/**
 * Reports what a thread currently occupies in the context window: how many
 * messages survive there, their token count, and the size and content of the
 * observation log that replaced the ones that no longer do.
 *
 * Used to show the before and after of a compaction independently of whatever
 * the CLI prints.
 *
 *   npx tsx scripts/context-report.ts <threadId> [label]
 */
import '../src/cli-bootstrap';
import { readContextState } from '../src/mastra/context-usage';
import { contextTokenBudget, memory } from '../src/mastra/memory';
import { defaultModel } from '../src/mastra/models';

const [threadId, label] = process.argv.slice(2);

if (!threadId) {
  console.error('usage: npx tsx scripts/context-report.ts <threadId> [label]');
  process.exit(1);
}

const thread = await memory.getThreadById({ threadId });
const state = await readContextState(threadId, thread?.resourceId);

if (!state) {
  console.error(`no context for thread ${threadId}`);
  process.exit(1);
}

const pct = (value: number, of: number) => (of > 0 ? `${Math.round((value / of) * 100)}%` : '\u2014');

console.log(`\n\u2500\u2500 contesto${label ? ` (${label})` : ''} \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`);
console.log(`thread            ${threadId}`);
console.log(`modello           ${defaultModel('main')} (finestra ${contextTokenBudget.contextWindow})`);
console.log(
  `messaggi          ${state.messages} in finestra, ${state.messageTokens} token ` +
    `(soglia ${state.messageThreshold}, ${pct(state.messageTokens, state.messageThreshold)})`,
);
console.log(
  `compattati        ${state.observed} messaggi, ${state.observedTokens} token usciti dalla finestra`,
);
console.log(
  `osservazioni      ~${state.observationTokens} token ` +
    `(soglia ${state.observationThreshold}, ${pct(state.observationTokens, state.observationThreshold)})`,
);
console.log(`totale in finestra ${state.messageTokens + state.observationTokens} token`);

if (state.observations) {
  console.log('\n\u2500\u2500 osservazioni \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
  console.log(
    state.observations.length > 1600 ? `${state.observations.slice(0, 1600)}\n\u2026[troncato]` : state.observations,
  );
} else {
  console.log('\nnessuna osservazione: niente \u00e8 ancora stato compattato');
}

process.exit(0);
