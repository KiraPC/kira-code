import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { CoreSystemMessage } from '@mastra/core/llm';
import { estimateTokenCount } from 'tokenx';
import { PROJECT_DIR } from '../config';

/**
 * The project's own instruction file — AGENTS.md and friends.
 *
 * Mastra ships half of this already: `AgentsMDInjector` injects the nearest
 * instruction file when a tool touches a path under it, which covers nested
 * files in a monorepo. What it does not do is load the project's own file
 * before the agent has touched anything, so a rule like "never run the build
 * directly" only arrives after the damage. That eager half is what this module
 * is.
 *
 * It lands as a second system block rather than inside the byte-stable one:
 * that keeps the ~14k-token cached prefix intact when the file changes, and the
 * block is still cached, because a breakpoint on a message covers every system
 * block ahead of it.
 */

/** The same names, in the same order, that `AgentsMDInjector` looks for. */
const INSTRUCTION_FILE_NAMES = ['AGENTS.md', 'CLAUDE.md', 'CONTEXT.md'];

/**
 * A cap, because this rides in every request. Long enough for any reasonable
 * instruction file — the ones in the wild run a few hundred tokens.
 */
const MAX_TOKENS = 8_000;

/**
 * Instruction files are instructions written by whoever wrote the checkout, and
 * a checkout under review is not necessarily trusted. `KIRA_INSTRUCTIONS=off`
 * turns both halves — this one and the nested injector — off entirely.
 */
export function instructionsEnabled(): boolean {
  return process.env.KIRA_INSTRUCTIONS?.trim().toLowerCase() !== 'off';
}

/** The instruction file directly in `dir`, first name wins, or null. */
function instructionFileIn(dir: string): string | null {
  for (const name of INSTRUCTION_FILE_NAMES) {
    const path = join(dir, name);
    if (statSync(path, { throwIfNoEntry: false })?.isFile()) return path;
  }

  return null;
}

export function projectInstructionFile(): string | null {
  return instructionsEnabled() ? instructionFileIn(PROJECT_DIR) : null;
}

/**
 * Every instruction file that sits *above* the project.
 *
 * The injector walks up to the filesystem root, so without this a stray
 * `~/AGENTS.md` would be read into a session about an unrelated project.
 */
const ANCESTOR_INSTRUCTION_PATHS: string[] = (() => {
  const paths: string[] = [];

  let current = dirname(resolve(PROJECT_DIR));
  let previous = '';

  while (current !== previous) {
    for (const name of INSTRUCTION_FILE_NAMES) paths.push(join(current, name));
    previous = current;
    current = dirname(current);
  }

  return paths;
})();

/**
 * What `AgentsMDInjector` must not inject: the project file, which is already
 * in the system prompt, and anything above the project.
 */
export function ignoredInstructionPaths(): string[] {
  const project = projectInstructionFile();
  return project ? [project, ...ANCESTOR_INSTRUCTION_PATHS] : ANCESTOR_INSTRUCTION_PATHS;
}

function truncate(content: string): string {
  const tokens = estimateTokenCount(content);
  if (tokens <= MAX_TOKENS) return content;

  const limit = content.lastIndexOf('\n', MAX_TOKENS * 4);
  const kept = content.slice(0, limit > 0 ? limit : MAX_TOKENS * 4).trimEnd();

  return `${kept}\n\n[truncated — ${estimateTokenCount(kept)} of ~${tokens} estimated tokens]`;
}

function render(path: string, content: string): string {
  return [
    '# Project instructions',
    '',
    `From ${path}. These are the conventions of the project you are working on:`,
    'follow them as you would a team convention. They outrank your own habits,',
    "and the user's instructions in this conversation outrank them.",
    '',
    truncate(content),
  ].join('\n');
}

/**
 * Read once and kept until the file changes on disk.
 *
 * `statSync` runs on every request rather than behind a TTL — it costs a
 * syscall, and a stale cache here would mean the agent editing its own AGENTS.md
 * and then ignoring it. Rebuilding on change is also exactly the right cache
 * behaviour: the block is byte-identical until the file really moves.
 */
let cached: { path: string; mtimeMs: number; size: number; message: CoreSystemMessage } | null = null;

export function projectInstructions(): CoreSystemMessage | null {
  const path = projectInstructionFile();
  if (!path) {
    cached = null;
    return null;
  }

  const stats = statSync(path, { throwIfNoEntry: false });
  if (!stats) {
    cached = null;
    return null;
  }

  if (cached && cached.path === path && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return cached.message;
  }

  let content: string;
  try {
    content = readFileSync(path, 'utf8').trim();
  } catch {
    cached = null;
    return null;
  }

  // An empty file is a file that says nothing, not an empty rule set.
  if (content.length === 0) {
    cached = null;
    return null;
  }

  const message: CoreSystemMessage = { role: 'system', content: render(path, content) };
  cached = { path, mtimeMs: stats.mtimeMs, size: stats.size, message };

  if (process.env.KIRA_DEBUG) {
    console.log(`[instructions] loaded ${path} (~${estimateTokenCount(content)} tokens)`);
  }

  return message;
}
