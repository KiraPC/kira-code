/**
 * probe-transient.ts — usa-e-getta.
 *
 * Verifica EMPIRICAMENTE l'accumulo di un signal `transient` attraverso gli step
 * di UN SINGOLO turno agentico, riproducendo il percorso reale del framework:
 *
 *   createProcessorSendSignal (trip-wire) fa, per ogni step:
 *     const signal = createSignal(signalInput);
 *     messageList.addSignal(signal);
 *
 * Qui replichiamo esattamente quella coppia di chiamate (createSignal + addSignal)
 * una volta per step, e dopo ogni step CONTIAMO quante copie del reminder finiscono
 * nel prompt assemblato inviato al modello (messageList.get.all.aiV5.model()).
 *
 * Due varianti:
 *   A) id rotante  -> id assente in input, createSignal genera un UUID nuovo ogni volta
 *   B) id stabile  -> stesso id passato ogni step
 *
 * Nessun modello reale: contiamo solo le copie nel prompt.
 */
import { MessageList } from '@mastra/core/agent/message-list';
import { createSignal } from '@mastra/core/signals';

const MARKER = 'REMEMBER_THE_PROJECT_RULES';
const STEPS = 5;

function countCopiesInPrompt(list: MessageList): number {
  // Prompt effettivamente assemblato per il modello (formato AI SDK v5 model messages).
  const modelMessages = list.get.all.aiV5.model();
  const serialized = JSON.stringify(modelMessages);
  // conta le occorrenze del marker nel prompt
  return serialized.split(MARKER).length - 1;
}

function countSignalDbMessages(list: MessageList): number {
  const db = list.get.all.db();
  return db.filter((m: any) => m.role === 'signal').length;
}

function transientFlagsInDb(list: MessageList): boolean[] {
  const db = list.get.all.db();
  return db
    .filter((m: any) => m.role === 'signal')
    .map((m: any) => m?.content?.metadata?.signal?.transient === true);
}

function runVariant(label: string, useStableId: boolean) {
  const list = new MessageList();
  // turno realistico: un messaggio utente iniziale
  list.add({ role: 'user', content: 'Fai il refactor del modulo pagamenti.' }, 'input');

  console.log(`\n=== VARIANTE ${label} (${useStableId ? 'id STABILE' : 'id ROTANTE'}) ===`);
  const perStepPrompt: number[] = [];
  const perStepDb: number[] = [];

  for (let step = 1; step <= STEPS; step++) {
    // Riproduzione fedele di createProcessorSendSignal: un processore che a ogni
    // step re-inietta lo STESSO reminder transient.
    const signal = createSignal({
      type: 'reactive',
      tagName: 'system-reminder',
      contents: MARKER,
      transient: true,
      ...(useStableId ? { id: 'reminder-project-rules' } : {}),
    });
    list.addSignal(signal);

    const inPrompt = countCopiesInPrompt(list);
    const inDb = countSignalDbMessages(list);
    perStepPrompt.push(inPrompt);
    perStepDb.push(inDb);
    console.log(
      `  step ${step}: copie nel PROMPT = ${inPrompt} | messaggi signal in DB list = ${inDb}`,
    );
  }

  console.log(`  -> serie copie nel prompt: [${perStepPrompt.join(', ')}]`);
  console.log(`  -> flag transient sui signal DB: [${transientFlagsInDb(list).join(', ')}]`);
  return { perStepPrompt, perStepDb };
}

const a = runVariant('A', false);
const b = runVariant('B', true);

console.log('\n=== VERDETTO EMPIRICO ===');
const accumulatesA = a.perStepPrompt.every((v, i) => v === i + 1);
console.log(`A (id rotante) accumula 1..${STEPS} nel prompt: ${accumulatesA}`);
const stableStaysOne = b.perStepPrompt.every((v) => v === 1);
console.log(`B (id stabile) resta a 1 copia nel prompt: ${stableStaysOne}`);
console.log(
  `Nota: 'transient' e' true sui DB message in entrambe le varianti, ma NON riduce le copie nel prompt.`,
);
