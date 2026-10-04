import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Session } from '@mastra/core/agent-controller';
import { PROJECT_DIR } from '../mastra/config';
import type { Renderer, TaskItem } from './events';

/**
 * Turns the session's event stream into {@link UiEvent}s, and keeps the two
 * behaviours that are not about drawing at all.
 *
 * The first is the queue. Interactive prompts must not run inside the listener:
 * it is called synchronously from the run loop, and awaiting input there stalls
 * it. Every prompt is queued and drained one at a time.
 *
 * The second is knowing when a run is really over. A suspended run is not a
 * finished run — an interactive tool is waiting for an answer and will resume —
 * so returning to the main prompt there would put two readers on stdin. Both
 * were found by breaking them; they move here unchanged.
 */
export type SubscribeOptions = {
  session: Session;
  renderer: Renderer;
  /** Runs a tool approval prompt. Queued, never called inside the listener. */
  onApproval(event: { toolCallId: string; toolName: string; args: unknown }): Promise<void>;
  /** Runs an interactive tool's prompt (ask_user, submit_plan). Queued too. */
  onSuspension(event: {
    toolCallId: string;
    toolName: string;
    suspendPayload: unknown;
  }): Promise<void>;
  /** Applies the permissions a mode implies, after a mode change. */
  onModeChange(): Promise<void>;
  /** Called when nothing is running and nothing is pending: the turn is over. */
  onIdle(): void;
};

export function subscribeSession(options: SubscribeOptions): () => void {
  const { session, renderer } = options;

  /** Text already emitted per assistant message, so updates arrive as deltas. */
  const printed = new Map<string, string>();

  // `tool_end` carries the call id but not the name or the arguments, and a
  // renderer that wants to show a diff needs both. Remembered from the start.
  const started = new Map<string, { name: string; args: unknown; previous?: string }>();

  /**
   * The file a write is about to replace, read while it still holds the old
   * text. Reading it at `tool_end` would return what was just written.
   */
  const contentBefore = (name: string, args: unknown): string | undefined => {
    if (name !== 'write_file') return undefined;

    const path = (args as { path?: unknown })?.path;
    if (typeof path !== 'string') return undefined;

    try {
      return readFileSync(resolve(PROJECT_DIR, path), 'utf8');
    } catch {
      // No file yet: a creation has nothing to diff against, and the renderer
      // shows it as all additions.
      return undefined;
    }
  };

  /**
   * The agent's task list, rebuilt from the calls that change it.
   *
   * It already kept this list diligently and nobody could see it: the calls
   * showed up as a line of JSON cut at a hundred characters. Following the
   * three tools that write it is enough to hold the current state.
   */
  let tasks: TaskItem[] = [];

  const applyTaskCall = (name: string, args: unknown): boolean => {
    const record = (args ?? {}) as Record<string, unknown>;

    if (name === 'task_write' && Array.isArray(record.tasks)) {
      tasks = record.tasks as TaskItem[];
      return true;
    }

    if (name === 'task_update' || name === 'task_complete') {
      const id = typeof record.id === 'string' ? record.id : undefined;
      const status = name === 'task_complete' ? 'completed' : (record.status as TaskItem['status'] | undefined);

      tasks = tasks.map(task =>
        task.id && task.id === id
          ? {
              ...task,
              ...(status ? { status } : {}),
              ...(typeof record.content === 'string' ? { content: record.content } : {}),
            }
          : task,
      );
      return true;
    }

    // `task_check` only reads.
    return name === 'task_check';
  };

  const finishIfIdle = () => {
    if (session.run.isRunning() || session.suspensions.hasPending()) return;
    options.onIdle();
  };

  let pending = Promise.resolve();
  const enqueue = (task: () => Promise<void>) => {
    pending = pending
      .then(task)
      .catch(error => {
        renderer.handle({
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      })
      // A resume that never restarts the run would otherwise hang the prompt.
      .then(finishIfIdle);
  };

  const assistantDelta = (message: { id: string; role: string; content: { parts?: unknown[] } }) => {
    if (message.role !== 'assistant') return;

    const full = (message.content?.parts ?? [])
      .filter((part): part is { type: 'text'; text: string } => {
        return (
          typeof part === 'object' &&
          part !== null &&
          (part as { type?: unknown }).type === 'text' &&
          typeof (part as { text?: unknown }).text === 'string'
        );
      })
      .map(part => part.text)
      .join('');

    const already = printed.get(message.id) ?? '';
    if (full.length <= already.length) return;

    renderer.handle({ type: 'assistant', text: full.slice(already.length) });
    printed.set(message.id, full);
  };

  return session.subscribe(event => {
    if (process.env.KIRA_DEBUG) {
      const detail = JSON.stringify(event, (key, value) => (key === 'message' ? undefined : value));
      renderer.handle({ type: 'debug', text: detail?.slice(0, 400) ?? '' });
    }

    switch (event.type) {
      case 'message_update':
      case 'message_end':
        assistantDelta(event.message);
        break;

      case 'tool_start':
        // The task tools are bookkeeping, not work: their calls are replaced by
        // the list itself rather than announced one by one.
        if (event.toolName.startsWith('task_')) {
          if (applyTaskCall(event.toolName, event.args)) renderer.handle({ type: 'tasks', tasks });
          break;
        }

        started.set(event.toolCallId, {
          name: event.toolName,
          args: event.args,
          previous: contentBefore(event.toolName, event.args),
        });
        renderer.handle({
          type: 'tool-start',
          id: event.toolCallId,
          name: event.toolName,
          args: event.args,
        });
        break;

      case 'tool_end': {
        const call = started.get(event.toolCallId);
        if (!call) break;
        started.delete(event.toolCallId);

        renderer.handle({
          type: 'tool-end',
          id: event.toolCallId,
          name: call?.name ?? '',
          args: call?.args,
          result: event.result,
          isError: Boolean(event.isError),
          previous: call?.previous,
        });
        break;
      }

      case 'tool_approval_required':
        enqueue(() => options.onApproval(event));
        break;

      case 'tool_suspended':
        enqueue(() => options.onSuspension(event));
        break;

      case 'om_status': {
        const messages = event.windows?.active?.messages;
        if (!messages) break;

        renderer.handle({
          type: 'context',
          tokens: messages.tokens,
          threshold: messages.threshold,
          pending: event.windows?.buffered?.observations?.projectedMessageRemoval ?? 0,
        });
        break;
      }

      case 'mode_changed':
        renderer.handle({ type: 'mode', mode: event.modeId });
        enqueue(options.onModeChange);
        break;

      case 'model_changed':
        renderer.handle({ type: 'model', model: event.modelId });
        break;

      case 'error':
        renderer.handle({ type: 'error', message: String(event.error?.message ?? event.error) });
        break;

      case 'agent_end':
        printed.clear();
        renderer.handle({ type: 'run-end', reason: event.reason });
        // Queued so it lands after any approval prompt still on screen;
        // resolving here would put the main loop on stdin alongside it.
        if (event.reason !== 'suspended') enqueue(async () => {});
        break;

      default:
        break;
    }
  });
}
