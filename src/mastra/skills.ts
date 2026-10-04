import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { GLOBAL_SKILLS_DIR, PROJECT_SKILLS_DIR, SKILLS_DIR } from '../config';
import { instructionsEnabled } from './instructions/project';

/**
 * Where skills come from, and who wins when two of them share a name.
 *
 * Mastra discovers and serves skills; what it does not do is arbitrate between
 * sources, because it does not know ours apart — all three are `local` to it.
 * Its tie-break sorts by source *type*, and when the top two match it throws:
 *
 *   Cannot resolve skill "code-review": multiple local skills found at
 *   "…/skills/code-review", "…/.kira/skills/code-review". Rename one or move it.
 *
 * A project shipping a skill named like one of ours would therefore break the
 * `skill` tool rather than override it — and `list()` deduplicates by canonical
 * path, not by name, so the prompt would advertise the same name twice.
 *
 * So the arbitration happens here: each root is scanned, skills are deduplicated
 * by name keeping the most specific source, and Mastra receives the surviving
 * skill directories one by one. A path pointing straight at a skill directory is
 * supported — `#discoverDirectSkill` is tried before treating it as a container.
 */
export type SkillSourceName = 'built-in' | 'global' | 'project';

export type DiscoveredSkill = {
  name: string;
  description: string;
  path: string;
  source: SkillSourceName;
  userInvocable: boolean;
  /** Set when this skill hides one of the same name from a weaker source. */
  shadows?: string;
};

/** Weakest first: a later root overrides an earlier one on a name clash. */
function roots(): { source: SkillSourceName; dir: string }[] {
  const all: { source: SkillSourceName; dir: string }[] = [
    { source: 'built-in', dir: SKILLS_DIR },
    { source: 'global', dir: GLOBAL_SKILLS_DIR },
  ];

  // A project skill is instructions written by whoever wrote the checkout, so it
  // answers to the same switch as AGENTS.md. The other two are yours.
  if (instructionsEnabled()) all.push({ source: 'project', dir: PROJECT_SKILLS_DIR });

  return all;
}

function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

/** The frontmatter field, or undefined when it is missing or malformed. */
function frontmatterField(content: string, field: string): string | undefined {
  if (!content.startsWith('---')) return undefined;

  const end = content.indexOf('\n---', 3);
  if (end === -1) return undefined;

  const line = content
    .slice(3, end)
    .split('\n')
    .find(candidate => candidate.trim().startsWith(`${field}:`));

  return line?.slice(line.indexOf(':') + 1).trim().replace(/^["']|["']$/g, '') || undefined;
}

function readSkill(dir: string, source: SkillSourceName): DiscoveredSkill | null {
  const file = join(dir, 'SKILL.md');
  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) return null;

  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    return null;
  }

  return {
    // The directory name is the fallback: a skill whose frontmatter is broken
    // still has to get a name, or it could not be deduplicated at all.
    name: frontmatterField(content, 'name') ?? dir.split('/').pop() ?? dir,
    description: frontmatterField(content, 'description') ?? '',
    path: dir,
    source,
    userInvocable: frontmatterField(content, 'user-invocable') !== 'false',
  };
}

function scan(dir: string, source: SkillSourceName): DiscoveredSkill[] {
  if (!isDirectory(dir)) return [];

  // The root may be a single skill rather than a container of skills.
  const direct = readSkill(dir, source);
  if (direct) return [direct];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  return entries
    .map(entry => join(dir, entry))
    .filter(isDirectory)
    .map(path => readSkill(path, source))
    .filter((skill): skill is DiscoveredSkill => skill !== null);
}

/** Newest scan, keyed by the roots' mtimes so a new skill shows up on its own. */
let cached: { key: string; skills: DiscoveredSkill[] } | null = null;

function cacheKey(): string {
  return roots()
    .map(({ dir }) => `${dir}:${statSync(dir, { throwIfNoEntry: false })?.mtimeMs ?? 0}`)
    .join('|');
}

export function listSkills(): DiscoveredSkill[] {
  const key = cacheKey();
  if (cached?.key === key) return cached.skills;

  const byName = new Map<string, DiscoveredSkill>();

  for (const { source, dir } of roots()) {
    for (const skill of scan(dir, source)) {
      const weaker = byName.get(skill.name);
      byName.set(skill.name, weaker ? { ...skill, shadows: weaker.path } : skill);
    }
  }

  const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));

  if (process.env.KIRA_DEBUG) {
    for (const skill of skills) {
      const shadowed = skill.shadows ? `, shadowing ${skill.shadows}` : '';
      console.log(`[skills] ${skill.name} (${skill.source}) ${skill.path}${shadowed}`);
    }
  }

  cached = { key, skills };
  return skills;
}

/** What `workspace.skills` is given: one path per surviving skill. */
export function skillPaths(): string[] {
  return listSkills().map(skill => skill.path);
}
