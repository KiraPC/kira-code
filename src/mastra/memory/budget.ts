import { defaultModel } from '../models';

/**
 * Token budgets for observational memory, sized against the model's context
 * window rather than left at Mastra's fixed 30k/40k.
 *
 * OM's cycle keeps raw message history oscillating below `messageTokens` and
 * the observation log around `observationTokens`, so these two numbers decide
 * how much of the window the conversation is allowed to occupy before it gets
 * compacted.
 */

/**
 * Context windows per model family. Mastra does not expose this — `ProviderConfig`
 * carries only a list of model ids — so it lives here.
 *
 * The default is deliberately the smallest of the current generation: an
 * unknown model compacts more often than it needs to, which costs an extra
 * Observer call. Guessing high would instead build requests the model cannot
 * accept.
 */
const DEFAULT_CONTEXT_WINDOW = 200_000;

const CONTEXT_WINDOWS: { pattern: RegExp; tokens: number }[] = [
  { pattern: /haiku/i, tokens: 200_000 },
  { pattern: /claude-(?:opus|sonnet|fable|mythos)-5/i, tokens: 1_000_000 },
  { pattern: /claude-(?:opus|sonnet)-4-[678]/i, tokens: 1_000_000 },
  { pattern: /gpt-5/i, tokens: 400_000 },
  { pattern: /gemini/i, tokens: 1_000_000 },
];

export function contextWindowFor(modelId: string): number {
  return CONTEXT_WINDOWS.find(({ pattern }) => pattern.test(modelId))?.tokens ?? DEFAULT_CONTEXT_WINDOW;
}

/** Share of the window the raw message history may reach before observation. */
const MESSAGE_SHARE = 0.3;
/** Share of the window the observation log may reach before reflection. */
const OBSERVATION_SHARE = 0.2;

/**
 * Never below Mastra's own defaults — those are tuned, and going lower would
 * compact constantly on a small model.
 */
const MIN_MESSAGE_TOKENS = 30_000;
const MIN_OBSERVATION_TOKENS = 40_000;

/**
 * And never above these. On a 1M-token model the percentages would put 300k
 * tokens of history in every single request: the model would accept it, the
 * bill would not.
 */
const MAX_MESSAGE_TOKENS = 150_000;
const MAX_OBSERVATION_TOKENS = 100_000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), max);
}

function envTokens(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : undefined;
}

export type ContextBudget = {
  contextWindow: number;
  messageTokens: number;
  observationTokens: number;
};

/**
 * The budget for the main agent's model. Env overrides win outright — they
 * exist to measure without recompiling, and the tests set them very low.
 */
export function contextBudget(modelId: string = defaultModel('main')): ContextBudget {
  const contextWindow = contextWindowFor(modelId);

  return {
    contextWindow,
    messageTokens:
      envTokens('KIRA_OBSERVE_TOKENS') ??
      clamp(contextWindow * MESSAGE_SHARE, MIN_MESSAGE_TOKENS, MAX_MESSAGE_TOKENS),
    observationTokens:
      envTokens('KIRA_REFLECT_TOKENS') ??
      clamp(contextWindow * OBSERVATION_SHARE, MIN_OBSERVATION_TOKENS, MAX_OBSERVATION_TOKENS),
  };
}
