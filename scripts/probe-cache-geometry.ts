/**
 * probe-cache-geometry.ts — usa-e-getta, NO API COST (stub model).
 *
 * Dumps the actual prompt geometry the real promptCacheProcessor sees, per step,
 * across 2 real turns (real memory + LibSQL reload):
 *   - the role of every prompt entry
 *   - where the transient signal sits
 *   - which indices get a cache breakpoint (system + rolling message ones)
 *
 * Purpose: check the claim that "skip transient rows in chooseBreakpoints" moves
 * the signal out of the cached span. If the signal sits BEFORE the last
 * breakpoint, it is inside the cached span and skipping it changes nothing.
 */
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import type { Processor, ProcessInputStepArgs } from '@mastra/core/processors';
import type { LanguageModelV2, LanguageModelV2CallOptions, LanguageModelV2StreamPart } from '@ai-sdk/provider-v5';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { promptCacheProcessor } from '../src/mastra/request/breakpoints';

const STEERING = 'Stay on the current task and keep answers under three sentences.';
const TOOL_STEPS = 2;
let turn = 0;
let step = 0;

class SteeringReminderProcessor implements Processor {
  readonly id = 'steering-reminder';
  async processInputStep({ sendSignal }: ProcessInputStepArgs) {
    await sendSignal?.({ type: 'reactive', contents: STEERING, transient: true });
  }
}

/** Wraps the real processor so we can see the prompt it marked and where. */
const geometryProbe: Processor = {
  id: 'geometry-probe',
  processLLMRequest({ prompt }: any) {
    step++;
    const rows = prompt.map((m: any, i: number) => {
      const json = JSON.stringify(m);
      const marked = json.includes('cacheControl');
      const isSignal = json.includes(STEERING);
      return { i, role: m?.role, blocks: Array.isArray(m?.content) ? m.content.length : 1, marked, isSignal };
    });
    const signalIdx = rows.filter((r: any) => r.isSignal).map((r: any) => r.i);
    const markedIdx = rows.filter((r: any) => r.marked).map((r: any) => r.i);
    console.log(`\n--- turn ${turn} step ${step} | prompt len ${prompt.length}`);
    console.log(`    roles: ${rows.map((r: any) => `${r.i}:${r.role}${r.isSignal ? '*SIG' : ''}${r.marked ? '#BP' : ''}`).join('  ')}`);
    console.log(`    signal at ${JSON.stringify(signalIdx)} | breakpoints at ${JSON.stringify(markedIdx)}`);
    const lastBp = Math.max(...markedIdx, -1);
    for (const s of signalIdx) {
      console.log(`    -> signal@${s} is ${s < lastBp ? 'INSIDE the cached span (before last BP ' + lastBp + ')' : 'OUTSIDE (after last BP ' + lastBp + ')'}`);
    }
    return undefined;
  },
} as any;

const probeTool = createTool({
  id: 'noop_probe',
  description: 'no-op',
  inputSchema: z.object({}),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async () => ({ ok: true }),
});

const stub: LanguageModelV2 = {
  specificationVersion: 'v2',
  provider: 'stub',
  modelId: 'claude-stub',
  supportedUrls: {},
  async doGenerate() {
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
    if (step <= TOOL_STEPS) {
      return { content: [{ type: 'tool-call' as const, toolCallId: `c${step}`, toolName: 'noop_probe', input: '{}' }], finishReason: 'tool-calls' as const, usage, warnings: [] };
    }
    return { content: [{ type: 'text' as const, text: 'done.' }], finishReason: 'stop' as const, usage, warnings: [] };
  },
  async doStream() {
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
    const parts: LanguageModelV2StreamPart[] = [{ type: 'stream-start', warnings: [] }];
    if (step <= TOOL_STEPS) {
      parts.push({ type: 'tool-call', toolCallId: `c${step}`, toolName: 'noop_probe', input: '{}' });
      parts.push({ type: 'finish', usage, finishReason: 'tool-calls' });
    } else {
      parts.push({ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'done.' }, { type: 'text-end', id: 't' });
      parts.push({ type: 'finish', usage, finishReason: 'stop' });
    }
    return { stream: new ReadableStream<LanguageModelV2StreamPart>({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }) };
  },
};

async function main() {
  const db = `/tmp/geom-${randomUUID()}.db`;
  const store = new LibSQLStore({ id: 'geom', url: `file:${db}` });
  const agent = new Agent({
    id: 'geom-agent',
    name: 'geom-agent',
    instructions: 'You are a helpful assistant. Follow system reminders.',
    model: stub as any,
    tools: { noop_probe: probeTool },
    // real processor first, then the observer so it sees the marks
    inputProcessors: [new SteeringReminderProcessor(), promptCacheProcessor as any, geometryProbe],
    memory: new Memory({ storage: store }),
  });
  const threadId = `t-${randomUUID()}`;
  const resourceId = `r-${randomUUID()}`;
  for (let t = 1; t <= 2; t++) {
    turn = t; step = 0;
    await agent.generate(`Turn ${t}: do the work.`, { maxSteps: 6, memory: { thread: threadId, resource: resourceId } } as any);
  }
  if (existsSync(db)) { try { unlinkSync(db); } catch {} }
}
main().catch(e => { console.error('ERRORE:', e?.message ?? e); process.exit(1); });
