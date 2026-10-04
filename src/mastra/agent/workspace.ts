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
 * Why a write to `path` is going to be refused, or null when it may go ahead.
 * Read by both the approval check and the hook, so the two cannot disagree.
 */
function readBeforeWriteRefusal(path: unknown): string | null {
  const absolute = toAbsolute(path);
  if (!absolute) return null;

  // A file that doesn't exist yet cannot have been read.
  const currentMtime = modifiedAt(absolute);
  if (currentMtime === null) return null;

  const readMtime = readTracker.get(absolute);
  if (readMtime === undefined) {
    return `File "${path}" has not been read. Open it with view before writing to it.`;
  }

  if (currentMtime > readMtime) {
    return `File "${path}" changed since you read it. Read it again before writing.`;
  }

  return null;
}

/**
 * Approval for the write tools: none for a call the hook is about to refuse.
 *
 * The hook runs inside `execute`, after the approval gate, so on its own it let
 * the user approve an edit that was then refused with "has not been read".
 * The gate is decided per call by this function (a function-form
 * `requireApproval` becomes the tool's `needsApprovalFn`, which overrides the
 * controller's run-wide `requireToolApproval`). Returning false skips the gate
 * entirely — no prompt, and the controller's edit policy is never consulted —
 * so the refusal reaches the model at once and it reads the file. Returning
 * true gates the call as before, and the edit policy decides: ask, allow (the
 * user's "always", and plan mode) or deny.
 */
function writeNeedsApproval({ args }: { args?: Record<string, unknown> }): boolean {
  return readBeforeWriteRefusal(args?.path) === null;
}

/**
 * PIDs of the processes the agent started with `background: true`, in this
 * process.
 *
 * Stopping one of these needs no prompt: the user already approved starting
 * it, and a dev server the agent cannot stop without asking is one it tends to
 * leave running. Any other PID still asks. The sandbox would refuse a PID it
 * did not spawn anyway (its process manager only knows its own), so this is
 * the approval matching what the tool can actually do, not the only guard.
 */
const backgroundPids = new Set<string>();

const BACKGROUND_STARTED = /^Started background process \(PID: (\S+)\)/;

/** `cmd &` with `background: true` backgrounds twice; the shell's `&` adds nothing. */
const TRAILING_AMPERSAND = /\s*(?<!&)&\s*$/;

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
  // Waiting for a server started in the background to come up.
  /^sleep\s+\d+(\.\d+)?[smh]?$/,
];

/**
 * `curl` flags that only change what is printed or how long to wait. An
 * allowlist, not the list of dangerous ones: curl has hundreds of options, and
 * several write files (`-o`, `-O`, `-w '%output{…}'`, `-c`, `-D`), send data
 * (`-d`, `-F`, `-T`) or read a config that can do all of that (`-K`).
 */
const CURL_PRINT_FLAGS = new Set([
  '-s', '--silent', '-S', '--show-error', '-i', '--include', '-I', '--head', '-v', '--verbose', '-f', '--fail',
]);
const CURL_NUMERIC_FLAGS = new Set(['-m', '--max-time', '--connect-timeout']);
const CURL_LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function isLocalUrl(token: string): boolean {
  try {
    const url = new URL(token.includes('://') ? token : `http://${token}`);
    // `hostname` is what curl connects to, so `http://localhost@example.com`
    // is correctly seen as example.com.
    return (url.protocol === 'http:' || url.protocol === 'https:') && CURL_LOCAL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * A GET against this machine — checking a server the agent just started. Any
 * other host, method, body, output file or unknown flag falls through to the
 * approval prompt.
 */
function isLocalCurlRead(segment: string): boolean {
  const tokens = segment.split(/\s+/).map(token => token.replace(/^(['"])(.*)\1$/, '$2'));
  if (tokens[0] !== 'curl') return false;

  let urls = 0;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';

    if (token === '-X' || token === '--request') {
      index += 1;
      if (tokens[index]?.toUpperCase() !== 'GET') return false;
    } else if (CURL_NUMERIC_FLAGS.has(token)) {
      index += 1;
      if (!/^\d+(\.\d+)?$/.test(tokens[index] ?? '')) return false;
    } else if (/^-[a-zA-Z]{2,}$/.test(token)) {
      // Bundled short flags (`-sS`, `-fsS`) are fine only if each one is.
      if (![...token.slice(1)].every(flag => CURL_PRINT_FLAGS.has(`-${flag}`))) return false;
    } else if (token.startsWith('-')) {
      if (!CURL_PRINT_FLAGS.has(token)) return false;
    } else if (isLocalUrl(token)) {
      urls += 1;
    } else {
      return false;
    }
  }

  return urls > 0;
}

/**
 * Shell syntax that writes, or runs something the allowlist never inspected:
 * redirections (`cat x > important.ts` truncates a file with a "read-only"
 * command) and command substitution.
 */
const UNSAFE_SHELL_SYNTAX = /[>`]|\$\(|<\(/;

/** `find` only reads until you hand it an action. */
const MUTATING_FIND_ACTIONS = /\s-(delete|exec|execdir|ok|okdir|fls|fprint|fprintf)\b/;

/**
 * A bare `cd <dir>`. Models prefix almost every command with `cd <project> &&`
 * even though the sandbox already starts there; without this, that prefix alone
 * made `ls` and `npm test` ask for approval. It only moves the shell, and the
 * rest of the chain is still checked segment by segment.
 */
const CHANGE_DIRECTORY = /^cd(\s+("[^"]*"|'[^']*'|[^\s"']+))?$/;

/**
 * Merging stderr into stdout is the one redirection that writes nothing, and
 * models append it to test commands out of habit.
 */
const STDERR_TO_STDOUT = /\s+2>&1\b/g;

function isReadOnlyCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  const normalized = command.trim().replace(STDERR_TO_STDOUT, '');

  if (UNSAFE_SHELL_SYNTAX.test(normalized)) return false;

  // A chained command is only safe if every segment is. A lone `&` and a
  // newline separate commands too: without them `ls & rm -rf x` was one "ls"
  // segment and ran unprompted.
  return normalized
    .split(/&&|\|\||;|\||&|\n/)
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0)
    .every(
      segment =>
        CHANGE_DIRECTORY.test(segment) ||
        isLocalCurlRead(segment) ||
        (READ_ONLY_COMMANDS.some(pattern => pattern.test(segment)) &&
          !(segment.startsWith('find') && MUTATING_FIND_ACTIONS.test(segment))),
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
    // Test runners default to watch mode and wait for file changes forever;
    // with CI set, vitest and jest run once and exit. LocalSandbox passes only
    // PATH plus this `env` to commands, so it has to be set here — and it has no
    // default timeout, so a watcher run in the foreground blocks the turn.
    env: { CI: '1' },
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
    // hooks below, not through `requireReadBeforeWrite`; the write tools'
    // `requireApproval` only keeps a refused write from asking first.
    // The hooks also record background PIDs, for kill_process's approval.
    hooks: {
      beforeToolCall: ({ workspaceToolName, input, context }) => {
        const requestContext = (context as { requestContext?: RequestContextLike } | undefined)
          ?.requestContext;
        const planMode = inPlanMode(requestContext);

        const path = (input as { path?: unknown } | undefined)?.path;

        // Hooks cannot return a new input, but they receive the object the tool
        // then executes, so trimming it here is what runs. Only for background
        // starts: in the foreground a trailing `&` changes the meaning.
        const command = input as { command?: unknown; background?: unknown } | undefined;
        if (
          workspaceToolName === WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND &&
          command?.background === true &&
          typeof command.command === 'string'
        ) {
          command.command = command.command.replace(TRAILING_AMPERSAND, '');
        }

        if (planMode && MUTATING_TOOLS.has(workspaceToolName)) {
          const allowed = PLAN_ALLOWED_WRITE_TOOLS.has(workspaceToolName) && isPlanFile(path);
          if (!allowed) return { proceed: false, output: PLAN_MODE_REFUSAL };
        }

        if (!WRITE_TOOLS.has(workspaceToolName)) return;

        // Unprompted by now: writeNeedsApproval let this call past the gate
        // because of this very refusal.
        const refusal = readBeforeWriteRefusal(path);
        if (refusal) return { proceed: false, output: refusal };
      },

      afterToolCall: ({ workspaceToolName, input, output, error }) => {
        if (error) return;

        if (workspaceToolName === WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND && typeof output === 'string') {
          const pid = output.match(BACKGROUND_STARTED)?.[1];
          if (pid) backgroundPids.add(pid);
          return;
        }

        if (workspaceToolName === WORKSPACE_TOOLS.SANDBOX.KILL_PROCESS && typeof output === 'string') {
          // Once it is gone the number can be reused by something else.
          const pid = (input as { pid?: unknown } | undefined)?.pid;
          if (output.includes('has been killed') || output.includes('not found or had already exited')) {
            backgroundPids.delete(String(pid));
          }
          return;
        }

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
    [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: { name: 'write_file', requireApproval: writeNeedsApproval },
    [WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE]: { name: 'edit_file', requireApproval: writeNeedsApproval },
    [WORKSPACE_TOOLS.FILESYSTEM.AST_EDIT]: { requireApproval: writeNeedsApproval },
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
    // Both need a function, not `false`: the controller runs with
    // requireToolApproval on, and only a function-form requireApproval (a
    // needsApprovalFn) overrides that per call. A plain `false` is OR-ed with
    // it and the call is gated anyway.
    [WORKSPACE_TOOLS.SANDBOX.GET_PROCESS_OUTPUT]: {
      name: 'process_output',
      enabled: ({ requestContext }) => !inPlanMode(requestContext),
      requireApproval: () => false,
    },
    [WORKSPACE_TOOLS.SANDBOX.KILL_PROCESS]: {
      name: 'kill_process',
      enabled: ({ requestContext }) => !inPlanMode(requestContext),
      requireApproval: ({ args }) => !backgroundPids.has(String(args?.pid)),
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
