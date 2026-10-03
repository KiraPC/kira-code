import { Memory } from '@mastra/memory';
import { contextBudget } from './context';
import { resolveModel } from './models';
import { storage } from './storage';

/**
 * The agent's memory, exported rather than built inline so the CLI can reach
 * `memory.omEngine` and drive a compaction on demand (`/compact`).
 *
 * Observational memory is what compacts the context: past a token threshold the
 * Observer turns raw messages into observations and drops them from the window,
 * and past a second threshold the Reflector rewrites the observation log itself.
 *
 * The two steps run on different models on purpose. Observation is frequent and
 * recoverable — a detail missed this turn can be observed again later. A
 * reflection replaces the whole log in one shot, so whatever it decides to drop
 * is gone for good; that one runs on a stronger model. Mastra rejects a
 * top-level `model` alongside these two, so it is deliberately absent.
 */
const budget = contextBudget();

export const memory = new Memory({
  // The same store the Mastra instance uses. Passing it explicitly rather than
  // inheriting it at registration time is what lets a script (or the CLI) use
  // this memory outside an agent run.
  storage,
  options: {
    generateTitle: {
      model: ({ requestContext }) => resolveModel('memory', requestContext),
    },
    workingMemory: { enabled: true, scope: 'resource' },
    observationalMemory: {
      observation: {
        model: ({ requestContext }) => resolveModel('memory', requestContext),
        messageTokens: budget.messageTokens,
      },
      reflection: {
        model: ({ requestContext }) => resolveModel('reflect', requestContext),
        observationTokens: budget.observationTokens,
      },
    },
  },
});

export { budget as contextTokenBudget };
