import type { Renderer, UiEvent } from '../session/events';
import { color } from './color';
import type { Io } from './io';
import { COMMAND_TOOLS, toolBody, toolHeader } from './tool-view';

/**
 * Lines, one per fact, with no live state: a spinner or a footer would only
 * write noise into a captured log.
 *
 * It is not the poor relation, though. Tool output and diffs go through the
 * same {@link toolBody} the Ink screen uses, so what a script records is what a
 * terminal shows — minus the redrawing.
 */
export function createPlainRenderer(io: Io, shownAtApproval?: Set<string>): Renderer {
  /** Last context notice, so a window that has not moved is not repeated. */
  let lastContextNotice = '';

  return {
    handle(event: UiEvent) {
      switch (event.type) {
        case 'debug':
          io.line(color.dim(`\n[event] ${event.text}`));
          break;

        case 'assistant':
          io.write(event.text);
          break;

        case 'tool-start':
          io.line(`\n${toolHeader(event.name, event.args)}`);
          break;

        case 'tool-end': {
          // A call you approved already showed its diff, in the prompt that
          // asked about it. Printing the same lines again on the way out says
          // nothing and buries what follows. A command is the exception: the
          // prompt showed what would run, and only now is there output.
          const alreadySeen = shownAtApproval?.delete(event.id) ?? false;
          if (alreadySeen && !event.isError && !COMMAND_TOOLS.has(event.name)) break;

          for (const line of toolBody(event)) io.line(line);
          break;
        }

        // On a pipe there is no live area, so the list is printed each time it
        // changes: a few lines, and the state is in the transcript.
        case 'tasks': {
          if (io.interactive) break;

          for (const task of event.tasks) {
            const mark = task.status === 'completed' ? '✔' : task.status === 'in_progress' ? '❯' : '○';
            io.line(color.dim(`  ${mark} ${task.content}`));
          }
          break;
        }

        case 'context': {
          const key = `${Math.round(event.tokens / 1000)}-${Math.round(event.pending / 1000)}`;
          if (key === lastContextNotice) break;
          lastContextNotice = key;

          if (event.pending > 0) {
            io.line(
              color.dim(
                `\n[context] ${event.tokens}/${event.threshold} tokens — ${event.pending} queued for compaction`,
              ),
            );
          } else if (event.tokens > event.threshold * 0.8) {
            io.line(color.dim(`\n[context] ${event.tokens}/${event.threshold} tokens`));
          }
          break;
        }

        case 'mode':
          io.line(color.cyan(`\n[mode: ${event.mode}]`));
          break;

        case 'model':
          io.line(color.cyan(`\n[model: ${event.model}]`));
          break;

        case 'error':
          console.error(color.red(`\n✗ ${event.message}`));
          break;

        case 'run-end':
          io.write('\n');
          if (event.reason && event.reason !== 'complete') io.line(color.dim(`[${event.reason}]`));
          break;

        default:
          break;
      }
    },
  };
}
