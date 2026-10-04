import { color } from './color';

/**
 * How a tool call is shown: a header line, and what it produced.
 *
 * Before this, a call was one dim line with its arguments cut at a hundred
 * characters and no result at all — a `bash` command's output reached you only
 * when the model happened to quote it back, which costs the tokens twice and
 * stops the moment the model decides to summarise instead. A write showed its
 * path and nothing about what changed.
 */

/** Lines of a result beyond this are dropped; the header says how many. */
const MAX_RESULT_LINES = 12;
/** A diff longer than this is cut in the middle rather than filling the screen. */
const MAX_DIFF_LINES = 32;
/** Unchanged lines kept around a change, for orientation. */
const DIFF_CONTEXT = 2;

function oneLine(text: string, limit = 100): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** The text a tool returned, whatever shape it used to return it. */
function resultText(result: unknown): string {
  if (typeof result === 'string') return result;

  const record = asRecord(result);
  for (const key of ['content', 'output', 'stdout', 'text', 'message']) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }

  return result === undefined || result === null ? '' : JSON.stringify(result);
}

/**
 * A line-level diff: common prefix and suffix are trimmed, what is left is
 * shown as removals then additions.
 *
 * Deliberately not a minimal edit script. For the two cases that matter — an
 * `edit_file` whose arguments already are the before and after, and a
 * `write_file` against the file it replaces — trimming the ends puts the change
 * on screen with its surroundings, which is what you are looking for. A real
 * LCS would only pay off on interleaved edits, which these tools do not make.
 */
export function diffLines(before: string, after: string): string[] {
  const oldLines = before.split('\n');
  const newLines = after.split('\n');

  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start += 1;
  }

  let end = 0;
  while (
    end < oldLines.length - start &&
    end < newLines.length - start &&
    oldLines[oldLines.length - 1 - end] === newLines[newLines.length - 1 - end]
  ) {
    end += 1;
  }

  const removed = oldLines.slice(start, oldLines.length - end);
  const added = newLines.slice(start, newLines.length - end);

  const contextBefore = oldLines.slice(Math.max(0, start - DIFF_CONTEXT), start);
  const contextAfter = oldLines.slice(oldLines.length - end, oldLines.length - end + DIFF_CONTEXT);

  const body = [
    ...contextBefore.map(line => color.dim(`  ${line}`)),
    ...removed.map(line => color.red(`- ${line}`)),
    ...added.map(line => color.green(`+ ${line}`)),
    ...contextAfter.map(line => color.dim(`  ${line}`)),
  ];

  if (body.length <= MAX_DIFF_LINES) return body;

  const head = body.slice(0, MAX_DIFF_LINES / 2);
  const tail = body.slice(-MAX_DIFF_LINES / 2);
  return [...head, color.dim(`  … ${body.length - MAX_DIFF_LINES} more lines`), ...tail];
}

/** The line announcing a call, before anything is known about its outcome. */
export function toolHeader(name: string, args: unknown): string {
  const record = asRecord(args);
  const subject = record.command ?? record.path ?? record.pattern ?? record.query ?? record.name;

  const detail =
    typeof subject === 'string' ? subject : Object.keys(record).length > 0 ? oneLine(JSON.stringify(args)) : '';

  return color.dim(`· ${name}${detail ? ` ${oneLine(detail)}` : ''}`);
}

/**
 * What to show once a call is done.
 *
 * `previous` is the file's content from before a write, captured when the call
 * started — after it, the old text is gone and there is nothing to diff against.
 */
export function toolBody(options: {
  name: string;
  args: unknown;
  result: unknown;
  isError: boolean;
  previous?: string;
}): string[] {
  const { name, args, result, isError, previous } = options;
  const record = asRecord(args);

  if (isError) {
    // Errors are the one thing never abbreviated: a truncated failure is a
    // failure you have to reproduce to understand.
    return resultText(result)
      .split('\n')
      .map(line => color.red(`  ✗ ${line}`));
  }

  if (name === 'edit_file' && typeof record.old_string === 'string' && typeof record.new_string === 'string') {
    return diffLines(record.old_string, record.new_string).map(line => `  ${line}`);
  }

  if (name === 'write_file' && typeof record.content === 'string') {
    const after = record.content;
    if (previous !== undefined && previous !== after) {
      return diffLines(previous, after).map(line => `  ${line}`);
    }

    const lines = after.split('\n');
    const shown = lines.slice(0, MAX_RESULT_LINES);
    return [
      ...shown.map(line => color.green(`  + ${line}`)),
      ...(lines.length > shown.length
        ? [color.dim(`    … ${lines.length - shown.length} more lines`)]
        : []),
    ];
  }

  const text = resultText(result).trimEnd();
  if (!text || text === '(no output)') return [];

  const lines = text.split('\n');
  const shown = lines.slice(0, MAX_RESULT_LINES);

  return [
    ...shown.map(line => color.dim(`  ${line}`)),
    ...(lines.length > shown.length ? [color.dim(`  … ${lines.length - shown.length} more lines`)] : []),
  ];
}

/**
 * What you are being asked to approve, in full.
 *
 * The approval prompt used to show the arguments cut at a hundred characters:
 * for a write that meant approving a path, with the change itself arriving
 * afterwards, when saying no was no longer an option. Here the diff comes
 * first — `previous` is the file as it still is, since nothing has been written
 * yet — and a command is never abbreviated.
 */
export function approvalContext(options: { name: string; args: unknown; previous?: string }): string[] {
  const { name, args, previous } = options;
  const record = asRecord(args);

  if (name === 'edit_file' && typeof record.old_string === 'string' && typeof record.new_string === 'string') {
    return [
      color.dim(`  ${String(record.path ?? '')}`),
      ...diffLines(record.old_string, record.new_string).map(line => `  ${line}`),
    ];
  }

  if (name === 'write_file' && typeof record.content === 'string') {
    const path = String(record.path ?? '');
    if (previous !== undefined) {
      return [color.dim(`  ${path}`), ...diffLines(previous, record.content).map(line => `  ${line}`)];
    }

    const lines = record.content.split('\n');
    const shown = lines.slice(0, MAX_RESULT_LINES);
    return [
      color.dim(`  ${path} (new file)`),
      ...shown.map(line => color.green(`  + ${line}`)),
      ...(lines.length > shown.length ? [color.dim(`  … ${lines.length - shown.length} more lines`)] : []),
    ];
  }

  if (typeof record.command === 'string') {
    return record.command.split('\n').map(line => color.yellow(`  ${line}`));
  }

  const detail = Object.keys(record).length > 0 ? JSON.stringify(args, null, 2) : '';
  return detail ? detail.split('\n').map(line => color.dim(`  ${line}`)) : [];
}
