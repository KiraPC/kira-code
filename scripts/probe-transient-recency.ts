/**
 * probe-transient-recency.ts — usa-e-getta.
 *
 * Variante mirata del test e2e (Agent reale + stub LanguageModelV2 + processor
 * della doc, turno multi-step). Il SteeringReminderProcessor passa ora un `id`
 * STABILE al signal (stesso id a ogni processInputStep). Tutto il resto identico.
 *
 * DOMANDA: con l'id stabile l'unica copia del <system-reminder> nel payload REALE
 * ricevuto dall'endpoint (options.prompt in doGenerate) resta vicino all'ultimo
 * messaggio (recency), o si allontana man mano che il turno cresce?
 *
 * Per ogni step, MISURATO sul payload dell'endpoint:
 *  1. numero di copie del reminder
 *  2. indice della copia e lunghezza totale del prompt
 *  3. distanza dall'ultimo messaggio = (lunghezza - 1 - indice)
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
const TOOL_STEPS = 4; // 4 tool-call + 1 testo = 5 step
const STABLE_ID = 'steering-reminder-fixed-id';

type StepMeasure = {
  copies: number;
  indices: number[];
  promptLen: number;
  distanceFromLast: number | null;
};

function measurePromptPositions(prompt: any[]): StepMeasure {
  const indices: number[] = [];
  prompt.forEach((msg, i) => {
    if (JSON.stringify(msg).includes(STEERING)) indices.push(i);
  });
  const promptLen = prompt.length;
  // "copie" = quante occorrenze totali del marker in tutto il payload (robusto
  // anche se piu' copie finissero nello stesso messaggio come parti separate)
  const totalCopies = JSON.stringify(prompt).split(STEERING).length - 1;
  const lastIdx = indices.length ? indices[indices.length - 1] : -1;
  return {
    copies: totalCopies,
    indices,
    promptLen,
    distanceFromLast: lastIdx >= 0 ? promptLen - 1 - lastIdx : null,
  };
}

const perStep: StepMeasure[] = [];
let processorInvocations = 0;
let modelInvocations = 0;

class SteeringReminderProcessor implements Processor {
  readonly id = 'steering-reminder';
  async processInputStep({ sendSignal, messageList }: ProcessInputStepArgs) {
    processorInvocations++;
    await sendSignal?.({
      type: 'reactive',
      contents: STEERING,
      transient: true,
      id: STABLE_ID, // <-- unica differenza: id STABILE
    } as any);
    return messageList;
  }
}

const noopTool = createTool({
  id: 'noop_probe',
  description: 'A no-op probe tool.',
  inputSchema: z.object({}),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async () => ({ ok: true }),
});

const stubModel: LanguageModelV2 = {
  specificationVersion: 'v2',
  provider: 'stub',
  modelId: 'stub-model',
  supportedUrls: {},
  async doGenerate(options: LanguageModelV2CallOptions) {
    modelInvocations++;
    const stepIndex = modelInvocations;
    perStep.push(measurePromptPositions(options.prompt as any[]));
    const isToolStep = modelInvocations <= TOOL_STEPS;
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
  async doStream() {
    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      start(c) {
        c.close();
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

  await agent.generate('Fai il refactor del modulo pagamenti.', { maxSteps: 10 } as any);

  console.log('\n=== VARIANTE id STABILE ===');
  console.log(`processInputStep invocato: ${processorInvocations} volte`);
  console.log(`doGenerate invocato:       ${modelInvocations} volte`);
  console.log('\nMisurato sul payload REALE dell endpoint (options.prompt):');
  console.log('step | copie | indice(i) | lunghezza prompt | distanza dall ultimo');
  perStep.forEach((m, i) => {
    console.log(
      `  ${i + 1}  |   ${m.copies}   |  [${m.indices.join(',')}]      |        ${m.promptLen}         |         ${m.distanceFromLast}`,
    );
  });
  console.log(`\ncopie per step:    [${perStep.map((m) => m.copies).join(', ')}]`);
  console.log(`indice per step:   [${perStep.map((m) => m.indices.join('/')).join(', ')}]`);
  console.log(`lunghezza per step:[${perStep.map((m) => m.promptLen).join(', ')}]`);
  console.log(`distanza dall ultimo per step: [${perStep.map((m) => m.distanceFromLast).join(', ')}]`);
}

main().catch((e) => {
  console.error('ERRORE:', e);
  process.exit(1);
});
