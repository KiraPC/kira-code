import { execFileSync } from 'node:child_process';
import type { ComputeStateSignalArgs, Processor } from '@mastra/core/processors';
import { getControllerContext } from '../controller/selection';
import { MODE_INSTRUCTIONS } from '../controller/modes';
import { PLATFORM, PROJECT_DIR, PROJECT_NAME } from '../../config';
import { defaultModel } from '../models';

/**
 * The session facts that used to live in the system prompt.
 *
 * They are delivered as a state signal instead, which lands in the message list
 * after the cached prefix. That is what lets the system prompt stay
 * byte-identical: the model still knows the date, branch, mode and model, but
 * knowing them no longer costs a cache rebuild.
 *
 * Mastra deduplicates on `cacheKey`, so an unchanged session emits nothing at
 * all and the message prefix stays cacheable too.
 */
type SessionContext = {
  date: string;
  gitBranch: string | null;
  mode: string;
  model: string;
};

/**
 * The branch is read at most once every 30s: it changes rarely, and shelling
 * out on every model step of an agentic loop would be pure overhead.
 */
const BRANCH_TTL_MS = 30_000;
let branchCache: { value: string | null; readAt: number } | null = null;

function git(...args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: PROJECT_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * The branch, or null when this isn't a git repository.
 *
 * `git branch --show-current` is used rather than `rev-parse --abbrev-ref HEAD`
 * because the latter fails on a repository with no commits yet — which would
 * otherwise be reported to the model as "not a git repository".
 */
function gitBranch(): string | null {
  const now = Date.now();
  if (branchCache && now - branchCache.readAt < BRANCH_TTL_MS) return branchCache.value;

  let value: string | null = null;

  if (git('rev-parse', '--is-inside-work-tree') === 'true') {
    const current = git('branch', '--show-current');
    // Empty means detached HEAD: name the commit instead of claiming no branch.
    value = current || `detached at ${git('rev-parse', '--short', 'HEAD') ?? 'unknown commit'}`;
  }

  branchCache = { value, readAt: now };
  return value;
}

function readSessionContext(args: ComputeStateSignalArgs): SessionContext {
  const controller = getControllerContext(args.requestContext);

  return {
    date: new Date().toDateString(),
    gitBranch: gitBranch(),
    // Without a controller there are no modes, and the agent always builds.
    mode: controller?.session?.modeId ?? 'build',
    model: controller?.session?.modelId ?? defaultModel('main'),
  };
}

function describe(context: SessionContext): string {
  return [
    '# Session context',
    `Working directory: ${PROJECT_DIR}`,
    `Project: ${PROJECT_NAME}`,
    `Platform: ${PLATFORM}`,
    `Date: ${context.date}`,
    context.gitBranch === null ? 'Not a git repository' : `Git branch: ${context.gitBranch}`,
    `Current mode: ${context.mode}`,
    `Current model: ${context.model}`,
    '',
    // The mode's behavioural rules ride along here rather than in the system
    // prompt, so switching mode costs one message instead of the whole cache.
    MODE_INSTRUCTIONS[context.mode] ?? '',
  ].join('\n');
}

function cacheKeyFor(context: SessionContext): string {
  return `session:${context.date}:${context.gitBranch ?? 'no-git'}:${context.mode}:${context.model}`;
}

export const sessionContextProcessor = {
  id: 'session-context',
  stateId: 'session',

  computeStateSignal(args: ComputeStateSignalArgs) {
    const context = readSessionContext(args);
    const cacheKey = cacheKeyFor(context);

    // Re-emit when the window lost the snapshot (observational memory trims old
    // messages), otherwise the model would run on without a date or a mode.
    const unchanged = args.tracking?.currentCacheKey === cacheKey;
    if (unchanged && args.contextWindow.hasSnapshot) return;

    return {
      mode: 'snapshot' as const,
      cacheKey,
      contents: describe(context),
      value: { ...context },
    };
  },
} satisfies Processor;
