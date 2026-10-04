/**
 * probe-transient-multiturn.ts — usa-e-getta.
 *
 * Verifies the SIMPLIFIED transient fix (stable default id ONLY — no removeByIds/repositioning).
 *
 * Design under test:
 *   - within a turn: stable id + constant contents => messagesAreEqual short-circuits => no write
 *     => the signal stays ANCHORED and the prompt prefix ahead of it is byte-stable (cache-friendly)
 *   - across turns: transient => never persisted => absent from reloaded history => the next turn's
 *     send appends it fresh at the tail => recency PER TURN
 *
 * 2 real turns on one thread (real @mastra/memory + LibSQL), each a 3-step tool loop.
 * Processor is the docs example verbatim: constant contents, transient: true, NO id.
 *
 * All four measures are taken on the REAL payload handed to the endpoint (options.prompt):
 *   1. copies of the reminder per step/turn        (expect 1 per turn, no cross-turn accumulation)
 *   2. distance from the last message within turn  (expect GROWING = anchored, no per-step recency)
 *   3. distance at the FIRST step of each turn     (expect ~0 = per-turn recency)
 *   4. cache prefix stability within a turn        (expect the common prefix between consecutive
 *      steps to INCLUDE the signal, i.e. divergence point strictly AFTER the signal index)
 */
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import type { Processor, ProcessInputStepArgs } from '@mastra/core/processors';
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
} from '@ai-sdk/provider-v5';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { unlinkSync, existsSync } from 'node:fs';

const STEERING = 'Stay on the current task and keep answers under three sentences.';
const TOOL_STEPS_PER_TURN = 2; // 2 tool steps + 1 final text step = 3 steps per turn
const TURNS = 2;

const DB_FILE = `/tmp/probe-multiturn-${randomUUID()}.db`;

type Capture = {
  turn: number;
  stepInTurn: number;
  copies: number;
  signalIdx: number;
  promptLen: number;
  distance: number;
  msgKeys: string[]; // strict key, for prefix comparison
  cacheKeys: string[]; // provider-visible key (mastra metadata stripped)
};
const captures: Capture[] = [];

let currentTurn = 0;
let stepInTurn = 0;
let processorInvocations = 0;

// ---- Processor: the docs example verbatim (constant contents, transient, NO id) ----
class SteeringReminderProcessor implements Processor {
  readonly id = 'steering-reminder';

  async processInputStep({ sendSignal }: ProcessInputStepArgs) {
    processorInvocations++;
    await sendSignal?.({
      type: 'reactive',
      contents: STEERING,
      transient: true,
    });
    // no return — exactly as the docs example is written
  }
}

const noopTool = createTool({
  id: 'noop_probe',
  description: 'A no-op probe tool.',
  inputSchema: z.object({}),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async () => ({ ok: true }),
});

/** Strict key: the full ModelMessage as Mastra hands it over, including internal metadata. */
function messageKey(msg: unknown): string {
  return JSON.stringify(msg);
}

/**
 * Cache-relevant key: the same message with Mastra's internal `providerOptions.mastra`
 * namespace stripped. Providers consume only their own providerOptions namespace, so the
 * `mastra` bookkeeping is not part of what a provider hashes for prompt caching.
 */
function cacheKey(msg: unknown): string {
  const strip = (v: any): any => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
      const out: any = {};
      for (const [k, val] of Object.entries(v)) {
        if (k === 'providerOptions' || k === 'providerMetadata') {
          const rest = { ...(val as any) };
          delete rest.mastra;
          if (Object.keys(rest).length === 0) continue;
          out[k] = strip(rest);
        } else out[k] = strip(val);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(strip(msg));
}

function capture(prompt: unknown) {
  stepInTurn++;
  const arr = prompt as unknown[];
  const msgKeys = arr.map(messageKey);
  const cacheKeys = arr.map(cacheKey);
  const json = JSON.stringify(prompt);
  const copies = json.split(STEERING).length - 1;
  const signalIdx = msgKeys.findIndex(k => k.includes(STEERING));
  captures.push({
    turn: currentTurn,
    stepInTurn,
    copies,
    signalIdx,
    promptLen: arr.length,
    distance: signalIdx === -1 ? -1 : arr.length - 1 - signalIdx,
    msgKeys,
    cacheKeys,
  });
}

const stubModel: LanguageModelV2 = {
  specificationVersion: 'v2',
  provider: 'stub',
  modelId: 'stub-model',
  supportedUrls: {},
  async doGenerate(options: LanguageModelV2CallOptions) {
    capture(options.prompt);
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
    if (stepInTurn <= TOOL_STEPS_PER_TURN) {
      return {
        content: [
          { type: 'tool-call' as const, toolCallId: `t${currentTurn}-call-${stepInTurn}`, toolName: 'noop_probe', input: '{}' },
        ],
        finishReason: 'tool-calls' as const,
        usage,
        warnings: [],
      };
    }
    return {
      content: [{ type: 'text' as const, text: `Turn ${currentTurn} done.` }],
      finishReason: 'stop' as const,
      usage,
      warnings: [],
    };
  },
  async doStream(options: LanguageModelV2CallOptions) {
    capture(options.prompt);
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
    const parts: LanguageModelV2StreamPart[] = [{ type: 'stream-start', warnings: [] }];
    if (stepInTurn <= TOOL_STEPS_PER_TURN) {
      parts.push({ type: 'tool-call', toolCallId: `t${currentTurn}-call-${stepInTurn}`, toolName: 'noop_probe', input: '{}' });
      parts.push({ type: 'finish', usage, finishReason: 'tool-calls' });
    } else {
      const id = 'text-1';
      parts.push({ type: 'text-start', id });
      parts.push({ type: 'text-delta', id, delta: `Turn ${currentTurn} done.` });
      parts.push({ type: 'text-end', id });
      parts.push({ type: 'finish', usage, finishReason: 'stop' });
    }
    return {
      stream: new ReadableStream<LanguageModelV2StreamPart>({
        start(controller) {
          for (const p of parts) controller.enqueue(p);
          controller.close();
        },
      }),
    };
  },
};

/** Index of the first differing message between two prompts (= length of the common prefix). */
function divergenceIndex(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
}

async function main() {
  const store = new LibSQLStore({ id: 'probe-store', url: `file:${DB_FILE}` });
  const memory = new Memory({ storage: store });

  const agent = new Agent({
    id: 'probe-agent-mt',
    name: 'probe-agent-mt',
    instructions: 'You are a helpful assistant.',
    model: stubModel as any,
    tools: { noop_probe: noopTool },
    inputProcessors: [new SteeringReminderProcessor()],
    memory,
  });

  const threadId = `thread-${randomUUID()}`;
  const resourceId = `resource-${randomUUID()}`;

  for (let t = 1; t <= TURNS; t++) {
    currentTurn = t;
    stepInTurn = 0;
    await agent.generate(`Turn ${t}: do the work.`, {
      maxSteps: 10,
      memory: { thread: threadId, resource: resourceId },
    } as any);
  }

  // ---------- report ----------
  console.log('='.repeat(96));
  console.log('MULTI-TURN PROBE — simplified fix (stable default id, NO repositioning)');
  console.log(`${TURNS} turns x ${TOOL_STEPS_PER_TURN + 1} steps | measured on the REAL endpoint payload`);
  console.log('='.repeat(96));
  console.log(`processInputStep invocations: ${processorInvocations} | endpoint calls: ${captures.length}`);

  console.log('\n1+2+3. COPIES, POSITION, DISTANCE');
  console.log('turn | step | copies | signal idx | prompt len | distance from tail | note');
  for (const c of captures) {
    const note = c.stepInTurn === 1 ? (c.distance === 0 ? 'first step of turn -> LAST (per-turn recency)' : 'first step of turn') : '';
    console.log(
      `  ${c.turn}  |  ${c.stepInTurn}   |   ${c.copies}    |     ${String(c.signalIdx).padEnd(2)}     |     ${String(c.promptLen).padEnd(2)}     |         ${String(c.distance).padEnd(2)}         | ${note}`,
    );
  }

  if (process.env.DUMP) {
    const t1 = captures.filter(c => c.turn === 1);
    for (let i = 0; i < 3; i++) {
      console.log(`\n--- turn1 step${i + 1} msg[2] ---`);
      console.log((t1[i]!.msgKeys[2] ?? '(none)').slice(0, 400));
    }
  }
  console.log('\n4. CACHE PREFIX STABILITY WITHIN A TURN');
  console.log('   (divergence index = length of the byte-identical common prefix between');
  console.log('    consecutive steps; it must be > signal index for the signal to be cached)');
  console.log('turn | steps | signal idx | div(strict) | div(provider-visible) | signal inside provider-visible prefix?');
  for (let t = 1; t <= TURNS; t++) {
    const inTurn = captures.filter(c => c.turn === t);
    for (let i = 1; i < inTurn.length; i++) {
      const prev = inTurn[i - 1]!;
      const cur = inTurn[i]!;
      const div = divergenceIndex(prev.msgKeys, cur.msgKeys);
      const divC = divergenceIndex(prev.cacheKeys, cur.cacheKeys);
      const inside = cur.signalIdx !== -1 && cur.signalIdx < divC && prev.signalIdx === cur.signalIdx;
      console.log(
        `  ${t}  | ${prev.stepInTurn}->${cur.stepInTurn}   |     ${String(cur.signalIdx).padEnd(2)}     |      ${String(div).padEnd(2)}     |          ${String(divC).padEnd(2)}           | ${inside ? 'YES — provider prefix stable, signal cached' : 'NO — breaks at/before the signal'}`,
      );
    }
  }

  // cross-turn divergence, for contrast
  const lastOfT1 = captures.filter(c => c.turn === 1).at(-1)!;
  const firstOfT2 = captures.find(c => c.turn === 2)!;
  console.log(
    `\n   cross-turn (t1 last -> t2 first): divergence idx = ${divergenceIndex(lastOfT1.msgKeys, firstOfT2.msgKeys)} ` +
      `(expected: the signal moves, so the prefix breaks where it used to sit)`,
  );

  // ---------- persistence ----------
  const rows: any = await (store as any).client?.execute?.(
    `SELECT role, COUNT(*) AS n FROM mastra_messages GROUP BY role`,
  );
  console.log('\n5. PERSISTED ROWS (mastra_messages GROUP BY role)');
  if (rows?.rows) {
    for (const r of rows.rows) console.log(`   ${r.role}: ${r.n}`);
    const signalRows = rows.rows.find((r: any) => r.role === 'signal');
    console.log(`   -> signal rows: ${signalRows ? signalRows.n : 0} (expected 0 for transient)`);
  } else {
    console.log('   (could not query storage directly)');
  }

  // ---------- verdict ----------
  const perTurnCopies = Array.from({ length: TURNS }, (_, i) =>
    Math.max(...captures.filter(c => c.turn === i + 1).map(c => c.copies)),
  );
  const firstStepDistances = captures.filter(c => c.stepInTurn === 1).map(c => c.distance);
  const anchoredWithinTurn = Array.from({ length: TURNS }, (_, i) => {
    const inTurn = captures.filter(c => c.turn === i + 1);
    return inTurn.every(c => c.signalIdx === inTurn[0]!.signalIdx) && inTurn.at(-1)!.distance > inTurn[0]!.distance;
  });
  const cacheStable = Array.from({ length: TURNS }, (_, t) => {
    const inTurn = captures.filter(c => c.turn === t + 1);
    return inTurn.slice(1).every((cur, i) => {
      const prev = inTurn[i]!;
      return cur.signalIdx < divergenceIndex(prev.cacheKeys, cur.cacheKeys) && prev.signalIdx === cur.signalIdx;
    });
  });

  console.log('\n' + '='.repeat(96));
  console.log('VERDICT');
  console.log(`  dedup (max 1 copy in any step, per turn):   ${perTurnCopies.every(c => c === 1) ? 'PASS' : 'FAIL'}  -> ${JSON.stringify(perTurnCopies)}`);
  console.log(`  no cross-turn accumulation:                 ${perTurnCopies.every(c => c === 1) ? 'PASS' : 'FAIL'}`);
  console.log(`  per-turn recency (distance 0 at step 1):    ${firstStepDistances.every(d => d === 0) ? 'PASS' : 'FAIL'}  -> ${JSON.stringify(firstStepDistances)}`);
  console.log(`  anchored within turn (no per-step recency): ${anchoredWithinTurn.every(Boolean) ? 'PASS' : 'FAIL'}  -> ${JSON.stringify(anchoredWithinTurn)}`);
  const strictStable = Array.from({ length: TURNS }, (_, t) => {
    const inTurn = captures.filter(c => c.turn === t + 1);
    return inTurn.slice(1).every((cur, i) => cur.signalIdx < divergenceIndex(inTurn[i]!.msgKeys, cur.msgKeys));
  });
  console.log(`  cache prefix stable (provider-visible):     ${cacheStable.every(Boolean) ? 'PASS' : 'FAIL'}  -> ${JSON.stringify(cacheStable)}`);
  console.log(`  cache prefix stable (strict, incl. mastra): ${strictStable.every(Boolean) ? 'PASS' : 'FAIL'}  -> ${JSON.stringify(strictStable)}`);
  console.log('='.repeat(96));

  if (existsSync(DB_FILE)) { try { unlinkSync(DB_FILE); } catch {} }
}

main().catch(e => {
  console.error('ERRORE:', e);
  if (existsSync(DB_FILE)) { try { unlinkSync(DB_FILE); } catch {} }
  process.exit(1);
});
