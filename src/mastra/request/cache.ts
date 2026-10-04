import type { RequestContext } from '@mastra/core/request-context';
import { getControllerContext, type RequestContextLike } from '../controller/selection';

/**
 * Anthropic prompt caching settings.
 *
 * Caching is an exact prefix match: the cached span runs from the start of the
 * request to a `cache_control` breakpoint, and a single changed byte before it
 * invalidates everything after. Everything in this file exists to keep that
 * prefix stable and to decide where the breakpoints go.
 */
export type CacheTtl = '5m' | '1h';
export type CacheSetting = CacheTtl | 'off';

const CACHE_SETTINGS: CacheSetting[] = ['off', '5m', '1h'];

/** Request context key the CLI and Studio use to override the setting per run. */
const CACHE_CONTEXT_KEY = 'cacheTtl';

export function isCacheSetting(value: unknown): value is CacheSetting {
  return typeof value === 'string' && (CACHE_SETTINGS as string[]).includes(value);
}

export function defaultCacheSetting(): CacheSetting {
  const configured = process.env.KIRA_CACHE_TTL?.trim();
  return isCacheSetting(configured) ? configured : '5m';
}

/** Per-request override first, then the env default. */
export function resolveCacheSetting(requestContext?: RequestContextLike): CacheSetting {
  const raw =
    typeof (requestContext as RequestContext | undefined)?.get === 'function'
      ? (requestContext as RequestContext).get(CACHE_CONTEXT_KEY)
      : (requestContext as Record<string, unknown> | undefined)?.[CACHE_CONTEXT_KEY];

  return isCacheSetting(raw) ? raw : defaultCacheSetting();
}

/**
 * The `providerOptions` value that marks a cache breakpoint, or undefined when
 * caching is off. Anthropic only: other providers ignore the key, but there is
 * no reason to send it.
 */
export type CacheControlOptions = {
  anthropic: { cacheControl: Record<string, string> };
};

export function cacheControlOptions(setting: CacheSetting): CacheControlOptions | undefined {
  if (setting === 'off') return undefined;

  const cacheControl: Record<string, string> = { type: 'ephemeral' };
  if (setting === '1h') cacheControl.ttl = '1h';

  return { anthropic: { cacheControl } };
}

export function isAnthropicModel(modelId: unknown): boolean {
  return typeof modelId === 'string' && modelId.toLowerCase().includes('claude');
}

/** Re-exported so callers don't need two imports to read the controller mode. */
export { getControllerContext };
