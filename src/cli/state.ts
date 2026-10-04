import type { Session } from '@mastra/core/agent-controller';
import { RequestContext } from '@mastra/core/request-context';
import { defaultCacheSetting, type CacheSetting } from '../mastra/cache';
import type { Io } from '../ui/io';

/**
 * The handful of things the CLI's parts share.
 *
 * Module state rather than an object threaded through every call: there is
 * exactly one terminal, one session and one set of settings per process, and
 * pretending otherwise would add a parameter to every function to describe a
 * situation that cannot happen.
 */

/**
 * The terminal, behind an interface: Ink when there is a screen to draw on, and
 * plain lines when stdout is a pipe. Set by `main()` before anything reads or
 * writes.
 */
export let io!: Io;

export function setIo(next: Io): void {
  io = next;
}

/** Prompt for a line, or null when there is no more input. */
export function ask(prompt: string): Promise<string | null> {
  return io.ask(prompt);
}

/** A finished line of output. */
export function say(text = ''): void {
  io.line(text);
}

/**
 * Prompt-cache setting for this session. It rides the request context so the
 * agent's instructions and the rolling-breakpoint processor both see it.
 */
export let cacheSetting: CacheSetting = defaultCacheSetting();

export function setCacheSetting(next: CacheSetting): void {
  cacheSetting = next;
  io.setStatus?.({ cache: next });
}

/** The edit policy the user chose; restored when leaving plan mode. */
export let editPolicy: 'allow' | 'ask' | 'deny' = 'ask';

export function setEditPolicy(next: 'allow' | 'ask' | 'deny'): void {
  editPolicy = next;
}

/**
 * Calls whose diff was already shown while asking about them, so the renderer
 * does not repeat it when they finish.
 */
export const shownAtApproval = new Set<string>();

/** A turn a command wants sent on its behalf — see `/skill`. */
let queuedPrompt: string | null = null;

export function queuePrompt(prompt: string): void {
  queuedPrompt = prompt;
}

/** Takes the queued turn, if a command left one. */
export function takeQueuedPrompt(): string | null {
  const prompt = queuedPrompt;
  queuedPrompt = null;
  return prompt;
}

export function runRequestContext(): RequestContext {
  const context = new RequestContext();
  context.set('cacheTtl', cacheSetting);
  return context;
}

/**
 * In plan mode the workspace itself refuses every write outside the plans
 * directory, so an approval prompt there would ask about something that is
 * going to be refused anyway. Let the workspace decide instead.
 */
export async function applyModePermissions(session: Session): Promise<void> {
  await session.permissions.setForCategory({
    category: 'edit',
    policy: session.mode.get() === 'plan' ? 'allow' : editPolicy,
  });
}
