import { estimateTokenCount } from 'tokenx';
import { contextTokenBudget, memory } from './index';

/**
 * What a thread currently occupies, measured the way the model sees it.
 *
 * The distinction that matters: `recall()` returns everything the thread ever
 * said, but observational memory prunes what it has already folded into
 * observations from the request. Counting stored messages would therefore show
 * a compaction as having changed nothing.
 *
 * The split follows Mastra's own pruning rule: the history carries an
 * `data-om-observation-end` marker at each compaction, and everything before
 * the last one is dropped from the request. Splitting on the record's
 * `observedMessageIds` instead looks equivalent but is not — a reflection
 * starts a new generation whose id list is empty, which would read as the whole
 * history coming back into the window. That list is only the fallback Mastra
 * itself uses when no marker is present, and it is the fallback here too.
 */
export type ContextState = {
  /** Raw messages still sent to the model. */
  messages: number;
  messageTokens: number;
  /** Messages replaced by the observation log, no longer sent. */
  observed: number;
  observedTokens: number;
  observationTokens: number;
  observations: string;
  messageThreshold: number;
  observationThreshold: number;
};

/** The same estimator observational memory thresholds on, so the numbers line up. */
function tokensOf(text: string): number {
  return text ? estimateTokenCount(text) : 0;
}

type Part = { type?: string; text?: string; toolInvocation?: unknown };

const OBSERVATION_END = 'data-om-observation-end';

function partsOf(message: unknown): Part[] {
  return ((message as { content?: { parts?: unknown[] } }).content?.parts ?? []) as Part[];
}

/** Index of the last message carrying a completed observation, or -1. */
function lastObservationBoundary(messages: unknown[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (partsOf(messages[index]).some(part => part.type === OBSERVATION_END)) return index;
  }

  return -1;
}

function messageText(message: unknown, fromPart = 0, toPart?: number): string {
  const parts = partsOf(message).slice(fromPart, toPart);

  return parts
    .map(part => {
      const p = part as { type?: string; text?: string; toolInvocation?: unknown };
      if (p.type === 'text' && typeof p.text === 'string') return p.text;
      return p.toolInvocation ? JSON.stringify(p.toolInvocation) : '';
    })
    .join(' ');
}

export async function readContextState(
  threadId: string,
  resourceId?: string,
): Promise<ContextState | null> {
  if (!threadId) return null;

  const recalled = await memory.recall({ threadId, resourceId, perPage: false });
  const om = await memory.omEngine;
  const record = om ? await om.getRecord(threadId, resourceId) : null;
  const observations = om ? ((await om.getObservations(threadId, resourceId)) ?? '') : '';

  const observedIds = new Set((record as { observedMessageIds?: string[] } | null)?.observedMessageIds ?? []);
  const boundary = lastObservationBoundary(recalled.messages);

  let messages = 0;
  let messageTokens = 0;
  let observed = 0;
  let observedTokens = 0;

  recalled.messages.forEach((message, index) => {
    const parts = partsOf(message);
    const pruned =
      boundary === -1 ? observedIds.has((message as { id?: string }).id ?? '') : index < boundary;

    if (pruned) {
      observed += 1;
      observedTokens += tokensOf(messageText(message));
      return;
    }

    if (index === boundary) {
      // Only the parts written after the marker survive on this message: the
      // ones before it are what the observation was made from.
      const marker = parts.map(part => part.type).lastIndexOf(OBSERVATION_END);
      observed += 1;
      observedTokens += tokensOf(messageText(message, 0, marker + 1));
      messageTokens += tokensOf(messageText(message, marker + 1));
      return;
    }

    messages += 1;
    messageTokens += tokensOf(messageText(message));
  });

  return {
    messages,
    messageTokens,
    observed,
    observedTokens,
    observationTokens: tokensOf(observations),
    observations,
    messageThreshold: contextTokenBudget.messageTokens,
    observationThreshold: contextTokenBudget.observationTokens,
  };
}

const pct = (value: number, of: number) => (of > 0 ? `${Math.round((value / of) * 100)}%` : '—');

/** One-line rendering, used by `/context` and by both sides of `/compact`. */
export function describeContextState(state: ContextState): string {
  const compacted =
    state.observed > 0 ? `, ${state.observed} messages compacted (${state.observedTokens} tokens)` : '';

  return (
    `messages ${state.messages} / ${state.messageTokens} tokens ` +
    `(${pct(state.messageTokens, state.messageThreshold)} of ${state.messageThreshold}), ` +
    `observations ${state.observationTokens} tokens ` +
    `(${pct(state.observationTokens, state.observationThreshold)} of ${state.observationThreshold})${compacted}`
  );
}
