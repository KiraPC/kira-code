import { buildBasePrompt } from '@mastra/core/coding-agent';
import type { CoreSystemMessage } from '@mastra/core/llm';
import type { RequestContext } from '@mastra/core/request-context';
import { PLATFORM, PROJECT_DIR, PROJECT_NAME } from '../../config';
import { projectInstructions } from '../instructions/project';

/**
 * kira-code specific rules layered on top of the base coding-agent prompt.
 * The base prompt covers general coding behaviour; this covers how our
 * particular toolset is meant to be used.
 */
const TOOL_GUIDANCE = `## kira-code tool rules

- Read before you write. \`write_file\` and \`edit_file\` refuse to touch a file you have not opened with \`view\` in this run.
- \`bash\` runs read-only commands (git status/diff/log, ls, cat, test and typecheck scripts, \`sleep\`, plain \`curl\` GETs to localhost) without interruption. Anything else — installs, moves, deletes, git commit/push, network calls — pauses for the user's approval, so state clearly what you are about to run and why.
- Commands already run in the project directory: no \`cd\` prefix needed.
- A foreground \`bash\` call blocks until the command exits. Run test runners in their single-run mode (\`vitest run\`, \`jest\` without \`--watch\`), and when you write a \`test\` script, make it a single run too.
- Anything that does not exit on its own — dev servers, watchers, \`--watch\` modes — goes in the background: \`bash\` with \`background: true\` returns a PID immediately. Do not end that command with \`&\`: \`background: true\` already detaches it. Read its output with \`process_output\` (\`pid\`, optional \`tail\`, or \`wait: true\` to block until it exits), and stop it with \`kill_process\` (\`pid\`) once you are done with it.
- Never commit, push, or create branches unless the user asked for it explicitly.
- Delegate to the \`explore\` subagent when you need to locate code across many files. It reads and reports back; it cannot edit. Prefer it over reading a dozen files yourself, then act on what it reports.
- Use \`search_content\` and \`find_files\` before \`view\`: narrow down first, open second.
- \`lsp_inspect\` answers "what is this symbol and where is it defined" properly — prefer it over grepping for a definition. Give it a path, a line, and the line's text with a \`<<<\` marker before the symbol.
- \`mastra_workspace_search\` only returns files that were indexed first with \`mastra_workspace_index\`. Nothing is indexed at startup, so use grep unless you have indexed the area yourself.

## Planning

- For anything that touches multiple files, changes public behaviour, or is ambiguous: write the plan to a markdown file under \`.kira/plans/\` first, then call \`submit_plan\` with that path and wait. The user can approve or reject with feedback — revise and resubmit when rejected.
- Skip the plan for a one-line fix, a question, or a pure lookup.

## Task tracking

- Use the task tools (\`task_write\`, \`task_update\`, \`task_complete\`) for any job with three or more steps. Keep exactly one task in progress, and mark tasks complete as you finish them — not in a batch at the end.

## Working with the user

- Use \`ask_user\` when a decision is genuinely the user's to make and a wrong guess would waste the work. Otherwise pick the reasonable default and say what you assumed.
- Use \`web_search\` / \`web_fetch\` for library docs and APIs you are unsure about instead of guessing.
- Report what you actually did: if a test fails, say so and show the output.`;

const SESSION_CONTEXT_POINTER =
  "Today's date, the git branch, the active mode and the active model are not in these instructions: they change, and this prompt is kept byte-identical so it can be cached. They arrive in a separate session-context message. Read them from there.";

/**
 * Lines that `buildBasePrompt()` puts in its `# Environment` header and that
 * change from run to run. They sit at the very top of the prompt, so leaving
 * them in would invalidate the cached prefix — and with it the whole
 * conversation behind it — on every new day, branch, mode or model switch.
 */
const VOLATILE_LINE_PREFIXES = ['Git branch: ', 'Date: ', 'Current mode: '];

function stripVolatileLines(prompt: string): string {
  const kept: string[] = [];
  const removed = new Set<string>();

  for (const line of prompt.split('\n')) {
    const prefix = VOLATILE_LINE_PREFIXES.find(candidate => line.startsWith(candidate));
    if (prefix) removed.add(prefix);
    else kept.push(line);
  }

  // Fail at startup rather than degrade quietly: if the upstream template
  // changes shape, the volatile values would stay in the cached prefix and
  // caching would silently stop working with no error anywhere.
  const missing = VOLATILE_LINE_PREFIXES.filter(prefix => !removed.has(prefix));
  if (missing.length > 0) {
    throw new Error(
      `kira-code: buildBasePrompt() no longer emits ${missing.join(', ')}. ` +
        'The prompt-cache prefix cannot be verified — update stripVolatileLines() in prompts/system.ts.',
    );
  }

  return kept.join('\n');
}

/**
 * The system prompt, built once and byte-identical for the lifetime of the
 * process. `mode` and `modelId` are deliberately not passed: the first would
 * change on every /mode, and the second leaks into the commit co-author line.
 */
const STABLE_PROMPT = stripVolatileLines(
  buildBasePrompt({
    projectPath: PROJECT_DIR,
    projectName: PROJECT_NAME,
    gitBranch: 'placeholder-stripped-below',
    platform: PLATFORM,
    date: 'placeholder-stripped-below',
    mode: 'placeholder-stripped-below',
    toolGuidance: `${TOOL_GUIDANCE}\n\n## Session context\n\n- ${SESSION_CONTEXT_POINTER}`,
    productName: 'kira-code',
    coAuthorName: 'kira-code',
    coAuthorEmail: 'noreply@kira-code.local',
  }),
);

/**
 * The instructions, as system messages.
 *
 * The first block is the invariant one and carries the cache breakpoint (placed
 * by `processors/prompt-cache.ts`, not here). The project's AGENTS.md follows as
 * its own block, so editing it rebuilds a few hundred tokens instead of the
 * whole cached prefix.
 */
export function buildInstructions(_args: { requestContext?: RequestContext } = {}): CoreSystemMessage[] {
  const project = projectInstructions();

  return project
    ? [{ role: 'system', content: STABLE_PROMPT }, project]
    : [{ role: 'system', content: STABLE_PROMPT }];
}
