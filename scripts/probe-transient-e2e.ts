/**
 * probe-transient-e2e.ts — usa-e-getta.
 *
 * Test end-to-end FEDELE ALLA DOC.
 *
 * Riproduce l'esempio "Deliver a reminder without retaining it" dai docs Mastra
 * (node_modules/@mastra/core/dist/docs/references/docs-agents-processors.md):
 * un Processor con processInputStep che fa sendSignal({ type:'reactive',
 * contents:'...', transient:true }) SENZA passare id. Registrato su un vero Agent,
 * dentro un turno multi-step reale guidato da uno stub LanguageModelV2 che chiama
 * un tool fittizio per i primi step e risponde con testo all'ultimo.
 *
 * Due misure per step:
 *  (A) copie del reminder nella vista messaggi lato modello (messageList.get.all...model())
 *      misurata DENTRO processInputStep subito dopo sendSignal.
 *  (B) copie del reminder nel payload REALE ricevuto dall'endpoint del modello
 *      (options.prompt catturato in doStream).
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

const STEERING = 'Stay on the current task and keep answers under three sentences.';
const TOOL_STEPS = 4; // 4 step con tool-call + 1 step finale con testo = 5 step nel turno

function countMarker(haystack: string): number {
  return haystack.split(STEERING).length - 1;
}

// ---- Misure ----
const measureA: number[] = []; // vista lato modello (messageList) dentro il processor
const measureB: number[] = []; // payload reale ricevuto da doStream
let processorInvocations = 0;
let doStreamInvocations = 0;

// ---- Processor IDENTICO alla doc (nessun id sul signal) ----
class SteeringReminderProcessor implements Processor {
  readonly id = 'steering-reminder';

  async processInputStep({ sendSignal, messageList }: ProcessInputStepArgs) {
    processorInvocations++;
    await sendSignal?.({
      type: 'reactive',
      contents: STEERING,
      transient: true,
    });
    // (A) quante copie vede il modello nella vista assemblata, dopo l'invio
    try {
      const modelView = (messageList as any).get.all.aiV5.model();
      measureA.push(countMarker(JSON.stringify(modelView)));
    } catch (e) {
      measureA.push(-1);
    }
    return messageList;
  }
}

// ---- Tool fittizio ----
const noopTool = createTool({
  id: 'noop_probe',
  description: 'A no-op probe tool.',
  inputSchema: z.object({}),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async () => ({ ok: true }),
});

// ---- Stub LanguageModelV2 ----
const stubModel: LanguageModelV2 = {
  specificationVersion: 'v2',
  provider: 'stub',
  modelId: 'stub-model',
  supportedUrls: {},
  async doGenerate(options: LanguageModelV2CallOptions) {
    doStreamInvocations++;
    const stepIndex = doStreamInvocations;
    // (B) copie nel payload REALE ricevuto dall'endpoint
    measureB.push(countMarker(JSON.stringify(options.prompt)));
    const isToolStep = doStreamInvocations <= TOOL_STEPS;
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
    if (isToolStep) {
      return {
        content: [
          {
            type: 'tool-call' as const,
            toolCallId: `call-${stepIndex}`,
            toolName: 'noop_probe',
            input: '{}',
          },
        ],
        finishReason: 'tool-calls' as const,
        usage,
        warnings: [],
      };
    }
    return {
      content: [{ type: 'text' as const, text: 'Riepilogo finale: fatto.' }],
      finishReason: 'stop' as const,
      usage,
      warnings: [],
    };
  },
  async doStream(options: LanguageModelV2CallOptions) {
    doStreamInvocations++;
    const stepIndex = doStreamInvocations; // 1-based
    // (B) copie nel payload REALE ricevuto dall'endpoint
    measureB.push(countMarker(JSON.stringify(options.prompt)));

    const isToolStep = doStreamInvocations <= TOOL_STEPS;
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

    const parts: LanguageModelV2StreamPart[] = [{ type: 'stream-start', warnings: [] }];
    if (isToolStep) {
      parts.push({
        type: 'tool-call',
        toolCallId: `call-${stepIndex}`,
        toolName: 'noop_probe',
        input: '{}',
      });
      parts.push({ type: 'finish', usage, finishReason: 'tool-calls' });
    } else {
      const id = 'text-1';
      parts.push({ type: 'text-start', id });
      parts.push({ type: 'text-delta', id, delta: 'Riepilogo finale: fatto.' });
      parts.push({ type: 'text-end', id });
      parts.push({ type: 'finish', usage, finishReason: 'stop' });
    }

    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      start(controller) {
        for (const p of parts) controller.enqueue(p);
        controller.close();
      },
    });
    return { stream };
  },
};

async function main() {
  const agent = new Agent({
    id: 'probe-agent',
    name: 'probe-agent',
    instructions:
      'You are a helpful assistant. Messages may contain <system-reminder>...</system-reminder> tags injected by the system; follow them.',
    model: stubModel as any,
    tools: { noop_probe: noopTool },
    inputProcessors: [new SteeringReminderProcessor()],
  });

  const result = await agent.generate('Fai il refactor del modulo pagamenti.', {
    maxSteps: 10,
  } as any);

  console.log('\n=== INVOCAZIONI ===');
  console.log(`processInputStep invocato: ${processorInvocations} volte`);
  console.log(`doStream invocato:         ${doStreamInvocations} volte`);

  console.log('\n=== MISURE PER STEP (affiancate) ===');
  const n = Math.max(measureA.length, measureB.length);
  console.log('step |  A: vista messageList (model) |  B: payload reale a doStream');
  for (let i = 0; i < n; i++) {
    const a = measureA[i] ?? '-';
    const b = measureB[i] ?? '-';
    console.log(`  ${i + 1}  |             ${a}                 |            ${b}`);
  }
  console.log(`\nA per step: [${measureA.join(', ')}]`);
  console.log(`B per step: [${measureB.join(', ')}]`);

  const finalText = (result as any)?.text ?? '(n/d)';
  console.log(`\nTesto finale del turno: ${JSON.stringify(finalText)}`);
}

main().catch((e) => {
  console.error('ERRORE:', e);
  process.exit(1);
});
