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

/**
 * What working memory is for, in this agent.
 *
 * Working memory is the one thing that survives between sessions: a single
 * markdown document per project, rewritten through `updateWorkingMemory` and
 * re-sent as a system block on every request. Left without a template, Mastra
 * fills in a user profile — first name, location, interests — which a coding
 * agent will never learn and never need, and which it keeps offering to fill.
 *
 * The opening paragraph is there to push back on the instruction Mastra puts
 * above this template ("Store anything that could be useful later", "If you're
 * unsure whether to store something, store it"). That text is not ours to
 * change, so the template is the only place left to say "and prune".
 *
 * It moderates rather than decides: measured on Haiku, it reliably stops the
 * same fact being written into two sections and stops a one-turn instruction
 * being kept as a preference, but which section a fact lands in still varies
 * between runs. Forcing that would mean a zod `schema` instead of markdown,
 * and a document nobody can edit by hand.
 */
const WORKING_MEMORY_TEMPLATE = `# Working memory

Keep this glanceable: it is re-sent on every request. Replace what stopped being
true instead of appending, and leave a section out when it is empty. Write each
fact once, in one section. Keep only what still holds next session — not an
instruction meant for the turn you are in.

## Current task
What is being worked on, and where it stopped.

## Decisions
Choices already settled, with the reason, so they are not re-opened next session.

## Environment
Facts about this checkout: the command that runs the tests, the one that builds,
what broke once and how it was worked around.

## Preferences
How the user wants to be worked with: what to show them, what to ask before
doing, how to report results.`;

export const memory = new Memory({
  // The same store the Mastra instance uses. Passing it explicitly rather than
  // inheriting it at registration time is what lets a script (or the CLI) use
  // this memory outside an agent run.
  storage,
  options: {
    generateTitle: {
      model: ({ requestContext }) => resolveModel('memory', requestContext),
    },
    // Resource-scoped, and the resource is the project directory: this document
    // is per project and outlives the session, not per thread.
    workingMemory: { enabled: true, scope: 'resource', template: WORKING_MEMORY_TEMPLATE },
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
