import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { TaskItem } from '../session/events';
import type { Choice, UiStatus } from './store';

/**
 * Everything the CLI needs from its terminal, behind one interface.
 *
 * There are two implementations and only one entry point. On a terminal the Ink
 * app draws; on a pipe — a script, or the test driver that has verified every
 * feature in this repo — the same session writes plain lines. Without that
 * split, replacing the line-based CLI would have meant losing the way we test
 * it, which is too high a price for a nicer screen.
 *
 * The interface is deliberately the one the old CLI already used: `ask` for a
 * line of input, `line` for a finished line of output, `write` for streamed
 * text. That keeps the session logic untouched while the renderer changes
 * underneath it.
 */
export type Io = {
  /** Prompt for one line, or null when input is gone (EOF, Ctrl-D, pipe end). */
  ask(prompt: string): Promise<string | null>;
  /**
   * Pick one of a fixed set. Arrow keys on a screen, letters on a pipe — the
   * caller gets a value either way and never has to know which.
   *
   * Returns null when input is gone, and the caller decides what silence means.
   * For an approval it means no.
   */
  select(prompt: string, choices: Choice[]): Promise<string | null>;
  /** A complete line of output. */
  line(text?: string): void;
  /** A fragment, for streamed assistant text. */
  write(text: string): void;
  /** Whether this renderer draws a live screen (spinner, footer, selections). */
  readonly interactive: boolean;
  /**
   * Updates the footer. Absent on the plain renderer, which has nowhere to put
   * a status that changes without a line being written.
   */
  setStatus?(patch: Partial<UiStatus>): void;
  /** Registers what Esc does while a run is in flight. Interactive only. */
  onInterrupt?(handler: () => void): void;
  /** Replaces the live task checklist. Interactive only. */
  setTasks?(tasks: TaskItem[]): void;
  /** Registers what Shift+Tab does. Interactive only. */
  onCycleMode?(handler: () => void): void;
  close(): Promise<void> | void;
};

/** Plain line-based IO: what runs when stdout is a pipe rather than a screen. */
export function createPlainIo(): Io {
  const rl = createInterface({ input: stdin, output: stdout });

  let closed = false;
  rl.on('close', () => {
    closed = true;
  });

  return {
    interactive: false,

    async ask(prompt: string): Promise<string | null> {
      if (closed) return null;

      try {
        return await rl.question(prompt);
      } catch {
        closed = true;
        return null;
      }
    },

    async select(prompt: string, choices: Choice[]): Promise<string | null> {
      // The same shape the CLI has always used on a pipe: `[y]es / [n]o`. The
      // scripts that drive it answer with a letter, and keep working.
      const rendered = choices.map(choice => `[${choice.key ?? choice.label[0]}]${choice.label.slice(1)}`);
      const answer = (await this.ask(`${prompt}\n   ${rendered.join(' / ')}: `))?.trim().toLowerCase();
      if (answer === undefined) return null;

      const match = choices.find(choice => {
        const key = (choice.key ?? choice.label[0] ?? '').toLowerCase();
        return answer === key || answer === choice.label.toLowerCase() || answer === choice.value.toLowerCase();
      });

      return match?.value ?? null;
    },

    line(text = '') {
      console.log(text);
    },

    write(text: string) {
      stdout.write(text);
    },

    close() {
      rl.close();
    },
  };
}

/**
 * The renderer for this process: Ink when there is a terminal to draw on.
 *
 * `KIRA_PLAIN=1` forces the line-based one, which is how a terminal session can
 * still be captured or debugged without the screen being rewritten underneath.
 */
export async function createIo(options: { commands: string[] } = { commands: [] }): Promise<Io> {
  const plainRequested = process.env.KIRA_PLAIN?.trim() === '1';
  if (plainRequested || !stdin.isTTY || !stdout.isTTY) return createPlainIo();

  const { createInkIo } = await import('./ink-io.js');
  return createInkIo(options);
}
