import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';

/**
 * Root of the kira-code installation itself — where its skills and database
 * live, which is not the project being worked on.
 *
 * The CLI sets `KIRA_HOME` explicitly, because it can be started from any
 * directory. Under `mastra dev` the variable is unset and the bundled server
 * runs from a nested directory, so `process.cwd()` is not the root either:
 * walk up until we find the package.json that owns it.
 */
function resolveKiraHome(): string {
  const configured = process.env.KIRA_HOME?.trim();
  if (configured) return resolve(configured);

  let current = resolve(process.cwd());

  while (true) {
    if (statSync(resolve(current, 'package.json'), { throwIfNoEntry: false })?.isFile()) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) return resolve(process.cwd());
    current = parent;
  }
}

export const KIRA_HOME = resolveKiraHome();

/**
 * Directory the agent works on. Point KIRA_PROJECT_DIR at the repository you
 * want kira-code to edit; it defaults to the kira-code project itself.
 */
function resolveProjectDir(): string {
  const configured = process.env.KIRA_PROJECT_DIR?.trim();
  const projectDir = resolve(configured && configured.length > 0 ? configured : KIRA_HOME);

  const stats = statSync(projectDir, { throwIfNoEntry: false });
  if (!stats?.isDirectory()) {
    throw new Error(
      `KIRA_PROJECT_DIR must point to an existing directory. Got: ${projectDir}`,
    );
  }

  return projectDir;
}

function resolveGitBranch(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

export const PROJECT_DIR = resolveProjectDir();
export const PROJECT_NAME = basename(PROJECT_DIR);
export const GIT_BRANCH = resolveGitBranch(PROJECT_DIR);
export const PLATFORM = process.platform;

/**
 * Directory scanned for reusable skills (agentskills.io format). Skills ship
 * with kira-code itself, so they live outside the project being worked on.
 */
export const SKILLS_DIR = resolve(process.env.KIRA_SKILLS_DIR?.trim() || resolve(KIRA_HOME, 'skills'));

/**
 * Skills that belong to you rather than to an installation or a repository:
 * they apply to every project kira-code is pointed at.
 */
export const GLOBAL_SKILLS_DIR = resolve(
  process.env.KIRA_GLOBAL_SKILLS_DIR?.trim() || resolve(homedir(), '.kira/skills'),
);

/** Skills that belong to the project being worked on, and travel with it. */
export const PROJECT_SKILLS_DIR = resolve(PROJECT_DIR, '.kira/skills');
