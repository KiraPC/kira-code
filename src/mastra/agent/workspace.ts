import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { LocalFilesystem, LocalSandbox, WORKSPACE_TOOLS, Workspace } from '@mastra/core/workspace';
import { GLOBAL_SKILLS_DIR, KIRA_HOME, PROJECT_DIR, SKILLS_DIR } from '../../config';
import { inPlanMode, type RequestContextLike } from '../controller/selection';
import { skillPaths } from '../skills';

/** Where the agent writes plans it submits for approval. */
export const PLANS_DIR = '.kira/plans';

function toAbsolute(path: unknown): string | null {
  return typeof path === 'string' && path.length > 0 ? resolve(PROJECT_DIR, path) : null;
}

function isPlanFile(path: unknown): boolean {
  const absolute = toAbsolute(path);
  return absolute !== null && absolute.startsWith(`${resolve(PROJECT_DIR, PLANS_DIR)}/`);
}

/** Modification time in ms, or null when the file doesn't exist yet. */
function modifiedAt(absolutePath: string): number | null {
  return statSync(absolutePath, { throwIfNoEntry: false })?.mtimeMs ?? null;
}

const WRITE_TOOLS = new Set<string>([
  WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.AST_EDIT,
]);

/**
 * The only tools plan mode may use to change anything, and only under the
 * plans directory: it has to be able to write the plan it submits.
 *
 * An allowlist rather than a blocklist on purpose — a tool added later is
 * refused by default instead of being permitted by omission.
 *
 * The sandbox tools are not listed here because they are not even exposed in
 * plan mode (see `enabled` below). They sit at the end of the workspace's tool
 * order, so removing them trims a suffix and leaves the cacheable prefix of
 * the tool block untouched.
 */
/** Everything that can change the project, whatever the path. */
const MUTATING_TOOLS = new Set<string>([
  WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.AST_EDIT,
  WORKSPACE_TOOLS.FILESYSTEM.DELETE,
  WORKSPACE_TOOLS.FILESYSTEM.MKDIR,
]);

const PLAN_ALLOWED_WRITE_TOOLS = new Set<string>([
  WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
]);

const PLAN_MODE_REFUSAL = `Plan mode does not modify the project. Write the plan to a file under ${PLANS_DIR}/ and call submit_plan instead. The user switches to build mode by approving it.`;

/**
 * Read-before-write, tracked here rather than by the workspace.
 *
 * Mastra's built-in `requireReadBeforeWrite` keeps its record in a tracker
 * created inside `createWorkspaceTools()`, which runs again on every step of a
 * run. A file read in one step therefore counts as unread in the next, and
 * every edit fails with "has not been read" no matter how often the agent
 * re-reads it. This map belongs to the workspace singleton, so it survives
 * both step boundaries and approval suspensions.
 */
const readTracker = new Map<string, number>();

/**
 * Commands that only read state. They run without an approval prompt so the
 * agent can explore and verify freely; everything else is gated.
 */
const READ_ONLY_COMMANDS = [
  /^git\s+(status|diff|log|show|branch|remote|blame)\b/,
  /^(ls|pwd|cat|head|tail|wc|find|grep|rg|file|stat|which|tree)\b/,
  /^(node|npx tsc|tsc)\s+--version\b/,
  /^npx\s+tsc\s+--noEmit\b/,
  /^npm\s+(test|run\s+(test|lint|typecheck|build))\b/,
  /^(pnpm|yarn)\s+(test|lint|typecheck|build)\b/,
];

/**
 * Shell syntax that writes, or runs something the allowlist never inspected:
 * redirections (`cat x > important.ts` truncates a file with a "read-only"
 * command) and command substitution.
 */
const UNSAFE_SHELL_SYNTAX = /[>`]|\$\(|<\(/;

/** `find` only reads until you hand it an action. */
const MUTATING_FIND_ACTIONS = /\s-(delete|exec|execdir|ok|okdir|fls|fprint|fprintf)\b/;

function isReadOnlyCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  const normalized = command.trim();

  if (UNSAFE_SHELL_SYNTAX.test(normalized)) return false;

  // A chained command is only safe if every segment is.
  return normalized
    .split(/&&|\|\||;|\|/)
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0)
    .every(
      segment =>
        READ_ONLY_COMMANDS.some(pattern => pattern.test(segment)) &&
        !(segment.startsWith('find') && MUTATING_FIND_ACTIONS.test(segment)),
    );
}

/**
 * The main workspace: full read/write access to the project directory, with
 * Claude Code-style tool names and approval gates on anything destructive.
 */
export const workspace = new Workspace({
  id: 'kira-code-workspace',
  name: 'kira-code workspace',
  filesystem: new LocalFilesystem({
    basePath: PROJECT_DIR,
    // Both skill roots that sit outside the project: without them skill_read
    // could not open the reference files next to a built-in or global skill.
    allowedPaths: [SKILLS_DIR, GLOBAL_SKILLS_DIR],
  }),
  sandbox: new LocalSandbox({
    workingDirectory: PROJECT_DIR,
  }),
  // One path per skill rather than the roots: see skills.ts — two local skills
  // with the same name make Mastra's own tie-break throw, so the arbitration
  // happens before it, and only the winners are handed over.
  skills: skillPaths,
  // Semantic navigation via language servers. kira-code ships the TypeScript
  // one as a devDependency; servers for other languages are picked up from PATH
  // when they happen to be installed, and lsp_inspect simply reports that none
  // is available when they are not.
  lsp: {
    searchPaths: [resolve(KIRA_HOME, 'node_modules/.bin')],
  },
  // Keyword search over indexed files. Nothing is indexed up front: the agent
  // indexes the paths it cares about, so opening kira-code on a large repo
  // doesn't pay an indexing cost it may never use.
  bm25: true,
  tools: {
    // Read-before-write and the plan-mode restriction are enforced in the
    // hooks below, not through `requireReadBeforeWrite` / `requireApproval`.
    hooks: {
      beforeToolCall: ({ workspaceToolName, input, context }) => {
        const requestContext = (context as { requestContext?: RequestContextLike } | undefined)
          ?.requestContext;
        const planMode = inPlanMode(requestContext);

        const path = (input as { path?: unknown } | undefined)?.path;

        if (planMode && MUTATING_TOOLS.has(workspaceToolName)) {
          const allowed = PLAN_ALLOWED_WRITE_TOOLS.has(workspaceToolName) && isPlanFile(path);
          if (!allowed) return { proceed: false, output: PLAN_MODE_REFUSAL };
        }

        if (!WRITE_TOOLS.has(workspaceToolName)) return;

        const absolute = toAbsolute(path);
        if (!absolute) return;

        // A file that doesn't exist yet cannot have been read.
        const currentMtime = modifiedAt(absolute);
        if (currentMtime === null) return;

        const readMtime = readTracker.get(absolute);
        if (readMtime === undefined) {
          return {
            proceed: false,
            output: `File "${path}" has not been read. Open it with view before writing to it.`,
          };
        }

        if (currentMtime > readMtime) {
          return {
            proceed: false,
            output: `File "${path}" changed since you read it. Read it again before writing.`,
          };
        }
      },

      afterToolCall: ({ workspaceToolName, input, error }) => {
        if (error) return;
        if (workspaceToolName !== WORKSPACE_TOOLS.FILESYSTEM.READ_FILE && !WRITE_TOOLS.has(workspaceToolName)) {
          return;
        }

        const absolute = toAbsolute((input as { path?: unknown } | undefined)?.path);
        if (!absolute) return;

        // Recording the mtime after a write as well keeps consecutive edits
        // working: the agent knows what it just wrote.
        const currentMtime = modifiedAt(absolute);
        if (currentMtime !== null) readTracker.set(absolute, currentMtime);
      },
    },
    [WORKSPACE_TOOLS.LSP.LSP_INSPECT]: { name: 'lsp_inspect' },
    [WORKSPACE_TOOLS.FILESYSTEM.READ_FILE]: { name: 'view' },
    [WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES]: { name: 'find_files' },
    [WORKSPACE_TOOLS.FILESYSTEM.GREP]: { name: 'search_content' },
    [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: { name: 'write_file' },
    [WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE]: { name: 'edit_file' },
    [WORKSPACE_TOOLS.FILESYSTEM.DELETE]: {
      name: 'delete_file',
      requireApproval: true,
    },
    // Not exposed at all in plan mode. These three are the last tools the
    // workspace registers, so dropping them trims the end of the tool block
    // and the cached prefix in front of it still matches.
    [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]: {
      name: 'bash',
      maxOutputTokens: 5000,
      enabled: ({ requestContext }) => !inPlanMode(requestContext),
      requireApproval: ({ args }) => !isReadOnlyCommand(args?.command),
    },
    [WORKSPACE_TOOLS.SANDBOX.GET_PROCESS_OUTPUT]: {
      enabled: ({ requestContext }) => !inPlanMode(requestContext),
    },
    [WORKSPACE_TOOLS.SANDBOX.KILL_PROCESS]: {
      enabled: ({ requestContext }) => !inPlanMode(requestContext),
    },
  },
});

/**
 * Read-only view of the same project, used by the explore subagent so a
 * delegated search can never modify the repository.
 */
export const readOnlyWorkspace = new Workspace({
  id: 'kira-code-workspace-readonly',
  name: 'kira-code workspace (read-only)',
  filesystem: new LocalFilesystem({
    basePath: PROJECT_DIR,
    readOnly: true,
  }),
  tools: {
    [WORKSPACE_TOOLS.FILESYSTEM.READ_FILE]: { name: 'view' },
    [WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES]: { name: 'find_files' },
    [WORKSPACE_TOOLS.FILESYSTEM.GREP]: { name: 'search_content' },
    [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: { enabled: false },
    [WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE]: { enabled: false },
    [WORKSPACE_TOOLS.FILESYSTEM.AST_EDIT]: { enabled: false },
    [WORKSPACE_TOOLS.FILESYSTEM.DELETE]: { enabled: false },
    [WORKSPACE_TOOLS.FILESYSTEM.MKDIR]: { enabled: false },
  },
});
