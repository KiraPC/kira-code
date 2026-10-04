/**
 * probe-transient-fix-regress.ts — usa-e-getta.
 *
 * Regression checks for the transient-signal fix applied to
 * node_modules/@mastra/core/dist (equivalent of the fork source patch):
 *   1. addSignal: removeByIds([id]) before addOne when signal.transient
 *   2. createProcessorSendSignal: stable default id `transient:<processorId>:<tagName>`
 *      for a transient signal with no caller-supplied id
 *
 * Every scenario drives a REAL Agent over a stub LanguageModelV2 and measures the
 * REAL payload handed to the endpoint (options.prompt in doStream). Nothing here
 * re-implements the fix; it only observes the patched code.
 *
 * Scenarios:
 *   A. non-transient, no id      -> must be UNCHANGED by the fix (still accumulates)
 *   B. transient, caller id      -> caller id must be preserved verbatim, 1 copy
 *   C. two processors, same tag  -> must NOT collide: 2 distinct copies, both fresh
 *   D. one processor, two tags   -> must NOT collide: 2 distinct copies
 *   E. transient flag intact     -> DB signal rows still marked transient (not persisted)
 */
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import type { Processor, ProcessInputStepArgs } from '@mastra/core/processors';
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
} from '@ai-sdk/provider-v5';
import { z } from 'zod';

const TOOL_STEPS = 4; // 4 tool steps + 1 final text step = 5 steps in the turn

const noopTool = createTool({
  id: 'noop_probe',
  description: 'A no-op probe tool.',
  inputSchema: z.object({}),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async () => ({ ok: true }),
});

function makeStub(onPrompt: (prompt: unknown) => void): LanguageModelV2 {
  let calls = 0;
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
  return {
    specificationVersion: 'v2',
    provider: 'stub',
    modelId: 'stub-model',
    supportedUrls: {},
    async doGenerate(options: LanguageModelV2CallOptions) {
      calls++;
      onPrompt(options.prompt);
      if (calls <= TOOL_STEPS) {
        return {
          content: [
            { type: 'tool-call' as const, toolCallId: `call-${calls}`, toolName: 'noop_probe', input: '{}' },
          ],
          finishReason: 'tool-calls' as const,
          usage,
          warnings: [],
        };
      }
      return {
        content: [{ type: 'text' as const, text: 'done.' }],
        finishReason: 'stop' as const,
        usage,
        warnings: [],
      };
    },
    async doStream(options: LanguageModelV2CallOptions) {
      calls++;
      onPrompt(options.prompt);
      const parts: LanguageModelV2StreamPart[] = [{ type: 'stream-start', warnings: [] }];
      if (calls <= TOOL_STEPS) {
        parts.push({ type: 'tool-call', toolCallId: `call-${calls}`, toolName: 'noop_probe', input: '{}' });
        parts.push({ type: 'finish', usage, finishReason: 'tool-calls' });
      } else {
        const id = 'text-1';
        parts.push({ type: 'text-start', id });
        parts.push({ type: 'text-delta', id, delta: 'done.' });
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
}

type SignalSpec = { contents: string; transient?: boolean; id?: string; tagName?: string };

function makeProcessor(procId: string, specs: SignalSpec[], sink?: { ids: string[]; transient: boolean[] }) {
  return {
    id: procId,
    async processInputStep({ sendSignal, messageList }: ProcessInputStepArgs) {
      for (const spec of specs) {
        await sendSignal?.({
          type: 'reactive',
          contents: spec.contents,
          ...(spec.tagName ? { tagName: spec.tagName } : {}),
          ...(spec.transient ? { transient: true } : {}),
          ...(spec.id ? { id: spec.id } : {}),
        } as any);
      }
      if (sink) {
        for (const m of (messageList as any).get.all.db()) {
          if (m.role === 'signal') {
            sink.ids.push(m.id);
            sink.transient.push((m.content?.metadata?.signal as any)?.transient === true);
          }
        }
      }
      return messageList;
    },
  } as Processor;
}

async function run(label: string, processors: Processor[], markers: string[], sink?: { ids: string[]; transient: boolean[] }) {
  const perStep: number[][] = [];
  const distances: number[] = [];
  const stub = makeStub(prompt => {
    const json = JSON.stringify(prompt);
    perStep.push(markers.map(m => json.split(m).length - 1));
    // distance of the LAST marker occurrence from the tail of the prompt
    const arr = prompt as unknown[];
    let lastIdx = -1;
    arr.forEach((msg, i) => {
      if (markers.some(m => JSON.stringify(msg).includes(m))) lastIdx = i;
    });
    distances.push(lastIdx === -1 ? -1 : arr.length - 1 - lastIdx);
  });
  const agent = new Agent({
    id: `probe-${label}`,
    name: `probe-${label}`,
    instructions: 'You are a helpful assistant.',
    model: stub as any,
    tools: { noop_probe: noopTool },
    inputProcessors: processors,
  });
  await agent.generate('go.', { maxSteps: 10 } as any);
  return { perStep, distances, sink };
}

async function main() {
  console.log('='.repeat(78));
  console.log('REGRESSION CHECKS — patched @mastra/core 1.58.0 dist');
  console.log('='.repeat(78));

  // A. non-transient, no id -> must be untouched by the fix
  {
    const M = 'AAA-non-transient';
    const { perStep } = await run('A', [makeProcessor('proc-a', [{ contents: M }])], [M]);
    const series = perStep.map(r => r[0]);
    console.log(`\nA. NON-transient, no id`);
    console.log(`   copies per step: [${series.join(', ')}]`);
    console.log(`   expect UNCHANGED baseline (accumulates 1..5): ${JSON.stringify(series) === JSON.stringify([1, 2, 3, 4, 5]) ? 'PASS' : 'CHANGED -> ' + series}`);
  }

  // B. transient WITH caller-supplied id -> id preserved, 1 copy, recency kept
  {
    const M = 'BBB-caller-id';
    const sink = { ids: [] as string[], transient: [] as boolean[] };
    const { perStep, distances } = await run('B', [makeProcessor('proc-b', [{ contents: M, transient: true, id: 'my-own-id' }], sink)], [M], sink);
    const series = perStep.map(r => r[0]);
    const uniq = [...new Set(sink.ids)];
    console.log(`\nB. transient WITH caller id 'my-own-id'`);
    console.log(`   copies per step: [${series.join(', ')}]  distance: [${distances.join(', ')}]`);
    console.log(`   signal ids seen: ${JSON.stringify(uniq)}`);
    console.log(`   caller id preserved (never overridden): ${uniq.length === 1 && uniq[0] === 'my-own-id' ? 'PASS' : 'FAIL'}`);
    console.log(`   dedup + recency: ${series.every(c => c === 1) && distances.every(d => d === 0) ? 'PASS' : 'FAIL'}`);
  }

  // C. two DIFFERENT processors, SAME tagName, both transient -> must not collide
  {
    const M1 = 'CCC-proc-one';
    const M2 = 'CCC-proc-two';
    const { perStep } = await run(
      'C',
      [makeProcessor('proc-c1', [{ contents: M1, transient: true }]), makeProcessor('proc-c2', [{ contents: M2, transient: true }])],
      [M1, M2],
    );
    const s1 = perStep.map(r => r[0]);
    const s2 = perStep.map(r => r[1]);
    console.log(`\nC. TWO processors, same tagName, both transient`);
    console.log(`   proc-c1 copies: [${s1.join(', ')}]`);
    console.log(`   proc-c2 copies: [${s2.join(', ')}]`);
    console.log(`   no cross-processor collision (both survive, 1 each): ${s1.every(c => c === 1) && s2.every(c => c === 1) ? 'PASS' : 'FAIL'}`);
  }

  // D. ONE processor, TWO tagNames -> must not collide
  {
    const M1 = 'DDD-tag-one';
    const M2 = 'DDD-tag-two';
    const { perStep } = await run(
      'D',
      [makeProcessor('proc-d', [
        { contents: M1, transient: true, tagName: 'reminder-one' },
        { contents: M2, transient: true, tagName: 'reminder-two' },
      ])],
      [M1, M2],
    );
    const s1 = perStep.map(r => r[0]);
    const s2 = perStep.map(r => r[1]);
    console.log(`\nD. ONE processor, TWO tagNames, both transient`);
    console.log(`   tag one copies: [${s1.join(', ')}]`);
    console.log(`   tag two copies: [${s2.join(', ')}]`);
    console.log(`   no cross-tag collision (both survive, 1 each): ${s1.every(c => c === 1) && s2.every(c => c === 1) ? 'PASS' : 'FAIL'}`);
  }

  // E. transient flag still set on the DB row (so persistence filters still drop it)
  {
    const M = 'EEE-flag';
    const sink = { ids: [] as string[], transient: [] as boolean[] };
    const { sink: s } = await run('E', [makeProcessor('proc-e', [{ contents: M, transient: true }], sink)], [M], sink);
    const ids = [...new Set(s!.ids)];
    console.log(`\nE. transient flag + default id shape`);
    console.log(`   signal ids seen: ${JSON.stringify(ids)}`);
    console.log(`   exactly one stable id: ${ids.length === 1 ? 'PASS' : 'FAIL'}`);
    console.log(`   id is the derived stable key: ${ids[0] === 'transient:proc-e:system-reminder' ? 'PASS' : 'UNEXPECTED -> ' + ids[0]}`);
    console.log(`   transient flag true on every row: ${s!.transient.every(Boolean) ? 'PASS' : 'FAIL'}`);
  }

  console.log('\n' + '='.repeat(78));
}

main().catch(e => {
  console.error('ERRORE:', e);
  process.exit(1);
});

// ---- appended: F (accepted collision) and G (doc shape: processor returns nothing) ----
async function extra() {
  console.log('\n' + '='.repeat(78));
  console.log('F/G — trade-off and doc-shape checks');
  console.log('='.repeat(78));

  // F. SAME processor, SAME tagName, TWO DISTINCT transient reminders -> documented collision
  {
    const M1 = 'FFF-alpha';
    const M2 = 'FFF-beta';
    const { perStep } = await run(
      'F',
      [makeProcessor('proc-f', [
        { contents: M1, transient: true },
        { contents: M2, transient: true },
      ])],
      [M1, M2],
    );
    const s1 = perStep.map(r => r[0]);
    const s2 = perStep.map(r => r[1]);
    console.log(`\nF. SAME processor + SAME tagName, two DISTINCT transient reminders`);
    console.log(`   alpha copies: [${s1.join(', ')}]`);
    console.log(`   beta  copies: [${s2.join(', ')}]`);
    console.log(`   -> they share the derived id, so only the last survives: ${s1.every(c => c === 0) && s2.every(c => c === 1) ? 'CONFIRMED (documented trade-off)' : 'other: alpha=' + s1 + ' beta=' + s2}`);
  }

  // G. doc example's exact shape: processInputStep returns NOTHING
  {
    const M = 'GGG-doc-shape';
    const proc = {
      id: 'steering-reminder',
      async processInputStep({ sendSignal }: ProcessInputStepArgs) {
        await sendSignal?.({ type: 'reactive', contents: M, transient: true } as any);
        // no return — exactly as the docs example is written
      },
    } as Processor;
    const { perStep, distances } = await run('G', [proc], [M]);
    const series = perStep.map(r => r[0]);
    console.log(`\nG. doc example verbatim (processInputStep returns nothing)`);
    console.log(`   copies per step: [${series.join(', ')}]  distance: [${distances.join(', ')}]`);
    console.log(`   dedup + recency: ${series.every(c => c === 1) && distances.every(d => d === 0) ? 'PASS' : 'FAIL'}`);
  }
}
extra().catch(e => { console.error('ERRORE extra:', e); process.exit(1); });
