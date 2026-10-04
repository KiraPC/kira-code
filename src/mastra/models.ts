import type { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';
import { getControllerContext } from './controller/selection';

/**
 * kira-code is model agnostic: nothing here is hardcoded into the agents.
 * Every role resolves its model at request time, so the same code runs on any
 * provider of the Mastra model router (https://mastra.ai/models).
 */
export type ModelRole = 'main' | 'fast' | 'subagent' | 'memory' | 'reflect';

/** Cheap default everywhere — development and tests run on Haiku. */
const FALLBACK_MODEL = 'anthropic/claude-haiku-4-5';

/**
 * The one role that does not default to Haiku.
 *
 * Reflection rewrites the entire observation log, and whatever it drops is
 * gone — unlike an observation, which later turns can correct. It also runs
 * rarely, so a stronger model here costs very little.
 */
const REFLECT_FALLBACK_MODEL = 'anthropic/claude-sonnet-5';

const ROLE_ENV_VAR: Record<ModelRole, string> = {
  main: 'KIRA_MODEL',
  fast: 'KIRA_FAST_MODEL',
  subagent: 'KIRA_SUBAGENT_MODEL',
  memory: 'KIRA_MEMORY_MODEL',
  reflect: 'KIRA_REFLECT_MODEL',
};

/** Request context key that overrides each role for a single run. */
const ROLE_CONTEXT_KEY: Record<ModelRole, string> = {
  main: 'model',
  fast: 'model',
  subagent: 'subagentModel',
  memory: 'memoryModel',
  reflect: 'reflectModel',
};

export const kiraRequestContextSchema = z.object({
  model: z
    .string()
    .optional()
    .describe('Model for the main agent, as "provider/model" (e.g. anthropic/claude-sonnet-5).'),
  subagentModel: z
    .string()
    .optional()
    .describe('Model used by subagents such as explore. Defaults to the subagent role default.'),
  memoryModel: z
    .string()
    .optional()
    .describe('Model that observes the conversation, and generates thread titles.'),
  reflectModel: z
    .string()
    .optional()
    .describe('Model that condenses the observation log. Defaults to a stronger model.'),
  cacheTtl: z
    .enum(['off', '5m', '1h'])
    .optional()
    .describe('Anthropic prompt-cache setting for this run. Defaults to KIRA_CACHE_TTL, else 5m.'),
});

export type KiraRequestContext = z.infer<typeof kiraRequestContextSchema>;

/** The configured default for a role, ignoring any per-request override. */
export function defaultModel(role: ModelRole): string {
  const configured = process.env[ROLE_ENV_VAR[role]]?.trim();
  if (configured) return configured;

  return role === 'reflect' ? REFLECT_FALLBACK_MODEL : FALLBACK_MODEL;
}

/**
 * Resolves the model for a role, most specific source first:
 *
 * 1. an explicit request-context override (Studio's request context panel)
 * 2. the live AgentController selection, i.e. `/model` in the CLI
 * 3. the role's env default, then the global fallback
 */
export function resolveModel(role: ModelRole, requestContext?: RequestContext): string {
  const override = requestContext?.get(ROLE_CONTEXT_KEY[role]);
  if (typeof override === 'string' && override.trim().length > 0) {
    return override.trim();
  }

  const controller = getControllerContext(requestContext);
  const selected =
    role === 'subagent'
      ? controller?.getSubagentModelId?.() ?? controller?.session?.modelId
      : role === 'main'
        ? controller?.session?.modelId
        : undefined;

  if (typeof selected === 'string' && selected.trim().length > 0) {
    return selected.trim();
  }

  return defaultModel(role);
}
