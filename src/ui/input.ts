import { readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * The editing rules of the prompt, kept out of the component.
 *
 * Small, and worth having on their own: pasting was the thing that broke first
 * in every version of this CLI — the readline one dropped everything typed
 * before it was ready, and the first Ink one submitted a pasted block one line
 * per turn, which is worse, because it looks like it worked.
 */

/** Terminals wrap a paste in these when bracketed paste is on. */
const PASTE_START = '[200~';
const PASTE_END = '[201~';

export type Insertion = { kind: 'insert'; text: string } | { kind: 'submit'; text: string };

/**
 * What a payload from the keyboard means.
 *
 * A terminal does not say "this was pasted". What it does say is how much
 * arrives at once: one line ending in a newline is someone pressing return,
 * several lines in a single payload is a paste, and treating the second as a
 * series of the first is how a pasted block becomes twenty separate turns.
 */
export function interpret(payload: string): Insertion {
  if (payload.includes(PASTE_START)) {
    const text = payload.split(PASTE_START).join('').split(PASTE_END).join('');
    return { kind: 'insert', text: text.replace(/\r\n?/g, '\n') };
  }

  const text = payload.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');

  // `text\n` — a line and a return. Anything with more content than that came
  // in faster than a person types.
  const isSingleLineWithReturn = lines.length === 2 && lines[1] === '';
  if (isSingleLineWithReturn) return { kind: 'submit', text: lines[0] ?? '' };

  return { kind: 'insert', text };
}

/** Commands offered while the input is still a bare `/word`. */
export function completeCommand(input: string, commands: string[]): string[] {
  if (!input.startsWith('/') || input.includes(' ')) return [];

  const typed = input.slice(1).toLowerCase();
  return commands.filter(command => command.startsWith(typed));
}

/**
 * Paths offered for the `@token` being typed.
 *
 * Only the directory the token names is read — a full-tree search would be a
 * different feature, with a different cost, and the point here is to save
 * typing a path you already know.
 */
export function completePath(token: string, projectDir: string, limit = 8): string[] {
  if (!token.startsWith('@')) return [];

  const partial = token.slice(1);
  const directory = partial.endsWith('/') ? partial : dirname(partial);
  const prefix = partial.endsWith('/') ? '' : partial.slice(directory === '.' ? 0 : directory.length + 1);

  const base = resolve(projectDir, directory === '.' ? '' : directory);

  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    return [];
  }

  return entries
    .filter(entry => entry.startsWith(prefix) && !entry.startsWith('.'))
    .slice(0, limit)
    .map(entry => {
      const full = directory === '.' ? entry : join(directory, entry);
      const isDirectory = statSync(resolve(base, entry), { throwIfNoEntry: false })?.isDirectory() ?? false;
      return `@${full}${isDirectory ? '/' : ''}`;
    });
}

/** The whitespace-delimited token the cursor sits in, and where it starts. */
export function tokenAt(input: string, cursor: number): { token: string; start: number } {
  const start = input.lastIndexOf(' ', Math.max(0, cursor - 1)) + 1;
  return { token: input.slice(start, cursor), start };
}
