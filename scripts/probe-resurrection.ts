/**
 * probe-resurrection.ts — usa-e-getta, NO API COST (stub model).
 *
 * Closes the risk carried over from investigation 0001, now that `removeByIds` is
 * back in core's `addSignal`.
 *
 * 0001 showed the processor return contract is a trap: `ctx.messages` is a snapshot
 * captured BEFORE the processor ran, and returning it makes the runner re-apply it,
 * reverting in-place `messageList` mutations. Core now performs such a mutation
 * itself, inside `addSignal`, on every transient send. So: can a processor that
 * returns `ctx.messages` resurrect the copy core just removed?
 *
 * Three processors, identical except for what they return from processInputStep:
 *   1. returns nothing            (the docs example's shape)
 *   2. returns messageList        (the documented "I mutated it" shape)
 *   3. returns ctx.messages       (the trap)
 *
 * Measured on the REAL payload handed to the endpoint (options.prompt): copies of
 * the reminder, its index, and its distance from the tail, per step.
 */
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import type { Processor, ProcessInputStepArgs } from '@mastra/core/processors';
import type { LanguageModelV2, LanguageModelV2CallOptions, LanguageModelV2StreamPart } from '@ai-sdk/provider-v5';
import { z } from 'zod';

const STEERING = 'Stay on the current task and keep answers under three sentences.';
const TOOL_STEPS = 4; // 4 tool steps + 1 final = 5 steps

const probeTool = createTool({
  id: 'noop_probe',
  description: 'A no-op probe tool.',
  inputSchema: z.object({}),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async () => ({ ok: true }),
});

type Mode = 'nothing' | 'messageList' | 'ctxMessages';

function makeProcessor(mode: Mode): Processor {
  return {
    id: `ret-${mode}`,
    async processInputStep(args: ProcessInputStepArgs) {
      const { sendSignal, messageList } = args as any;
      await sendSignal?.({ type: 'reactive', contents: STEERING, transient: true });
      if (mode === 'messageList') return messageList;
      if (mode === 'ctxMessages') return (args as any).messages;
      return undefined;
    },
  } as Processor;
}

function makeStub(onPrompt: (p: unknown) => void): LanguageModelV2 {
  let calls = 0;
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
  const body = (options: LanguageModelV2CallOptions) => {
    calls++;
    onPrompt(options.prompt);
    return calls <= TOOL_STEPS;
  };
  return {
    specificationVersion: 'v2',
    provider: 'stub',
    modelId: 'claude-stub',
    supportedUrls: {},
    async doGenerate(options) {
      const isTool = body(options);
      if (isTool) {
        return {
          content: [{ type: 'tool-call' as const, toolCallId: `c${calls}`, toolName: 'noop_probe', input: '{}' }],
          finishReason: 'tool-calls' as const, usage, warnings: [],
        };
      }
      return { content: [{ type: 'text' as const, text: 'done.' }], finishReason: 'stop' as const, usage, warnings: [] };
    },
    async doStream(options) {
      const isTool = body(options);
      const parts: LanguageModelV2StreamPart[] = [{ type: 'stream-start', warnings: [] }];
      if (isTool) {
        parts.push({ type: 'tool-call', toolCallId: `c${calls}`, toolName: 'noop_probe', input: '{}' });
        parts.push({ type: 'finish', usage, finishReason: 'tool-calls' });
      } else {
        parts.push({ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'done.' }, { type: 'text-end', id: 't' });
        parts.push({ type: 'finish', usage, finishReason: 'stop' });
      }
      return { stream: new ReadableStream<LanguageModelV2StreamPart>({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }) };
    },
  };
}

async function run(mode: Mode) {
  const copies: number[] = [];
  const idx: number[] = [];
  const dist: number[] = [];
  const stub = makeStub(prompt => {
    const arr = prompt as unknown[];
    const json = JSON.stringify(prompt);
    copies.push(json.split(STEERING).length - 1);
    let last = -1;
    arr.forEach((m, i) => { if (JSON.stringify(m).includes(STEERING)) last = i; });
    idx.push(last);
    dist.push(last === -1 ? -1 : arr.length - 1 - last);
  });
  const agent = new Agent({
    id: `res-${mode}`,
    name: `res-${mode}`,
    instructions: 'You are a helpful assistant.',
    model: stub as any,
    tools: { noop_probe: probeTool },
    inputProcessors: [makeProcessor(mode)],
  });
  await agent.generate('go.', { maxSteps: 8 } as any);
  return { copies, idx, dist };
}

async function main() {
  console.log('='.repeat(88));
  console.log('0001 RESURRECTION TEST — core now does removeByIds inside addSignal');
  console.log('='.repeat(88));

  const modes: Mode[] = ['nothing', 'messageList', 'ctxMessages'];
  const out: Record<string, any> = {};
  for (const m of modes) out[m] = await run(m);

  console.log('\nprocessor returns   | copies per step | reminder index | distance from tail');
  for (const m of modes) {
    const r = out[m];
    console.log(
      `${m.padEnd(19)} | ${JSON.stringify(r.copies).padEnd(15)} | ${JSON.stringify(r.idx).padEnd(14)} | ${JSON.stringify(r.dist)}`,
    );
  }

  const good = (r: any) => r.copies.every((c: number) => c === 1) && r.dist.every((d: number) => d === 0);
  console.log('\n--- verdict ---');
  for (const m of modes) {
    const r = out[m];
    const dup = r.copies.some((c: number) => c > 1);
    const stale = r.dist.some((d: number) => d > 0);
    console.log(
      `${m.padEnd(19)} : ${good(r) ? 'OK — one copy, always last' : dup ? 'DUPLICATED (resurrection!)' : stale ? 'one copy but NOT last — repositioning reverted' : 'other'}`,
    );
  }
}

main().catch(e => { console.error('ERRORE:', e?.message ?? e); process.exit(1); });
