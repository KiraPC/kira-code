/**
 * probe-cache-real.ts — usa-e-getta. MAKES REAL PAID ANTHROPIC CALLS.
 *
 * Measures the REAL Anthropic prompt cache for two transient-signal variants:
 *   VARIANT=A  ANCHORED       — the id-only fix (.idonly bundles): one copy, anchored in-turn
 *   VARIANT=B  RECENT-EVERY-STEP — the rejected removeByIds variant (.patched bundles)
 *
 * Rig is as close to Kira's real cache pipeline as a probe gets:
 *   - the real `promptCacheProcessor` (src/mastra/request/breakpoints.ts)
 *   - the real system prompt via `buildInstructions` (carries the system breakpoint)
 *   - cache TTL on (KIRA_CACHE_TTL / cacheTtl in requestContext)
 *   - a steering processor emitting the docs-example transient reminder each step
 *   - a real tool to force a multi-step tool loop
 *   - real @mastra/memory + LibSQL so turn 2 reloads turn 1 from storage
 *
 * PADDING: Haiku 4.5 does not cache a prefix below 4096 tokens (Opus/Sonnet are
 * 512-1024). Kira's real deployment clears that floor with its full workspace tool
 * set; this probe has one tool, so a byte-identical STABLE_PADDING system block is
 * appended to lift the prefix over the floor. It is identical in both variants and
 * on every request, so it cannot bias the A/B — without it both variants would
 * measure zero cache activity and the comparison would be meaningless.
 *
 * Reported per step, from the REAL response usage:
 *   cache_creation_input_tokens (writes = miss) / cache_read_input_tokens (hits)
 *   / uncached input_tokens.
 */
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import type { Processor, ProcessInputStepArgs } from '@mastra/core/processors';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { buildInstructions } from '../src/mastra/agent/system-prompt';
import { promptCacheProcessor } from '../src/mastra/request/breakpoints';

const VARIANT = (process.env.VARIANT ?? 'A').toUpperCase();
const TURNS = Number(process.env.TURNS ?? 2);
const MODEL = process.env.PROBE_MODEL ?? 'anthropic/claude-haiku-4-5';
const STEERING = 'Stay on the current task and keep answers under three sentences.';

/** Byte-identical filler to clear Haiku 4.5's 4096-token minimum cacheable prefix. */
const RUN_ID = process.env.PROBE_RUN_ID ?? 'default';
const STABLE_PADDING = [
  `## Reference: internal operating notes (stable across every request) [rig ${RUN_ID}]`,
  ...Array.from(
    { length: 220 },
    (_, i) =>
      `- Note ${String(i).padStart(3, '0')}: when reconciling a task list, prefer the entry whose ` +
      `identifier sorts first, keep the original ordering of untouched entries, and never rewrite ` +
      `a record that has not changed since it was last observed in this session.`,
  ),
].join('\n');

// ---- the docs example, verbatim: constant contents, transient, NO id ----
class SteeringReminderProcessor implements Processor {
  readonly id = 'steering-reminder';
  async processInputStep({ sendSignal }: ProcessInputStepArgs) {
    await sendSignal?.({ type: 'reactive', contents: STEERING, transient: true });
  }
}

const probeTool = createTool({
  id: 'noop_probe',
  description: 'A no-op probe tool. Returns ok. Call it when asked to.',
  inputSchema: z.object({ step: z.string().describe('which step this is') }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async () => ({ ok: true }),
});

type StepUsage = {
  turn: number;
  step: number;
  creation: number;
  read: number;
  input: number;
  output: number;
};

function pick(obj: any, ...names: string[]): number {
  for (const n of names) {
    const direct = obj?.[n];
    if (typeof direct === 'number') return direct;
  }
  return 0;
}

/** Anthropic cache counters live in usage and/or providerMetadata.anthropic, by SDK version. */
function readCacheUsage(step: any): { creation: number; read: number; input: number; output: number } {
  const u = step?.usage ?? {};
  const pm = step?.providerMetadata?.anthropic ?? step?.response?.providerMetadata?.anthropic ?? {};
  // Anthropic's own usage object is the source of truth: its `input_tokens` is the
  // UNCACHED remainder, whereas Mastra's usage.inputTokens reports the total
  // (uncached + creation + read). Using the latter as "uncached" double-counts.
  const raw = pm?.usage ?? {};
  const creation = pick(raw, 'cache_creation_input_tokens')
    || pick(u, 'cacheCreationInputTokens') || pick(pm, 'cacheCreationInputTokens');
  const read = pick(raw, 'cache_read_input_tokens')
    || pick(u, 'cachedInputTokens', 'cacheReadInputTokens') || pick(pm, 'cacheReadInputTokens');
  const input = Object.keys(raw).length
    ? pick(raw, 'input_tokens')
    : Math.max(0, pick(u, 'inputTokens', 'promptTokens') - creation - read);
  return {
    creation,
    read,
    input,
    output: pick(raw, 'output_tokens') || pick(u, 'outputTokens', 'completionTokens'),
  };
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set — run with: node --env-file=.env --import tsx scripts/probe-cache-real.ts');
    process.exit(1);
  }

  const dbFile = `/tmp/probe-cache-${randomUUID()}.db`;
  const store = new LibSQLStore({ id: 'probe-cache-store', url: `file:${dbFile}` });
  const memory = new Memory({ storage: store });

  const agent = new Agent({
    id: 'probe-cache-agent',
    name: 'probe-cache-agent',
    instructions: ({ requestContext }: any) => [
      ...buildInstructions({ requestContext }),
      { role: 'system' as const, content: STABLE_PADDING },
    ],
    model: MODEL,
    tools: { noop_probe: probeTool },
    inputProcessors: [promptCacheProcessor as any, new SteeringReminderProcessor()],
    memory,
  });

  const threadId = `thread-${randomUUID()}`;
  const resourceId = `resource-${randomUUID()}`;
  const rows: StepUsage[] = [];
  let firstStepDump: unknown = null;

  for (let t = 1; t <= TURNS; t++) {
    const result: any = await agent.generate(
      `Turn ${t}. Call the noop_probe tool exactly twice, one call at a time (step "a", then step "b"), ` +
        `then reply with one short sentence saying you are done.`,
      // cacheTtl comes from KIRA_CACHE_TTL (defaultCacheSetting() = '5m'), not a
      // per-request override: Mastra wants a real RequestContext instance here.
      {
        maxSteps: 6,
        memory: { thread: threadId, resource: resourceId },
      } as any,
    );

    const steps: any[] = result?.steps ?? [];
    steps.forEach((s, i) => {
      if (!firstStepDump) {
        firstStepDump = {
          usage: s?.usage,
          providerMetadata: s?.providerMetadata ?? s?.response?.providerMetadata,
        };
      }
      const u = readCacheUsage(s);
      rows.push({ turn: t, step: i + 1, ...u });
    });
  }

  if (process.env.DUMP_SHAPE) {
    console.log('=== first step usage shape ===');
    console.log(JSON.stringify(firstStepDump, null, 2));
  }

  const label = VARIANT === 'B' ? 'B — RECENT-EVERY-STEP (removeByIds)' : 'A — ANCHORED (id-only fix)';
  console.log('='.repeat(92));
  console.log(`REAL ANTHROPIC CACHE — variant ${label} | model ${MODEL}`);
  console.log('='.repeat(92));
  console.log('turn | step | cache_creation (miss) | cache_read (hit) | input (uncached) | output');
  for (const r of rows) {
    console.log(
      `  ${r.turn}  |  ${r.step}   |        ${String(r.creation).padStart(6)}         |` +
        `      ${String(r.read).padStart(6)}      |      ${String(r.input).padStart(6)}      | ${String(r.output).padStart(5)}`,
    );
  }

  const sum = (f: keyof StepUsage) => rows.reduce((a, r) => a + (r[f] as number), 0);
  const totals = { creation: sum('creation'), read: sum('read'), input: sum('input'), output: sum('output') };
  console.log('-'.repeat(92));
  console.log(
    `TOTAL creation=${totals.creation}  read=${totals.read}  input=${totals.input}  output=${totals.output}`,
  );
  const cacheable = totals.creation + totals.read;
  console.log(
    `cache hit ratio (read / (read+creation)) = ${cacheable ? ((totals.read / cacheable) * 100).toFixed(1) : '0.0'}%`,
  );
  // Haiku 4.5 list price: $1.00/MTok input, $5.00/MTok output; writes 1.25x, reads 0.1x
  const cost =
    (totals.input * 1.0 + totals.creation * 1.25 + totals.read * 0.1) / 1e6 + (totals.output * 5.0) / 1e6;
  console.log(`approx cost this run: $${cost.toFixed(5)}`);

  writeFileSync(
    `/tmp/probe-cache-${VARIANT}.json`,
    JSON.stringify({ variant: VARIANT, model: MODEL, rows, totals, cost }, null, 2),
  );
  console.log(`(written to /tmp/probe-cache-${VARIANT}.json)`);

  if (existsSync(dbFile)) { try { unlinkSync(dbFile); } catch {} }
}

main().catch(e => {
  console.error('ERRORE:', e?.message ?? e);
  process.exit(1);
});
