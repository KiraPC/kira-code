import type { ToolCategory } from '@mastra/core/agent-controller';
import { WORKSPACE_TOOLS } from '@mastra/core/workspace';

/** Tools that only observe the project. */
export const READ_TOOLS = [
  'view',
  'find_files',
  'search_content',
  WORKSPACE_TOOLS.FILESYSTEM.FILE_STAT,
  'lsp_inspect',
  WORKSPACE_TOOLS.SEARCH.SEARCH,
  // Indexing writes to the search index, never to the project.
  WORKSPACE_TOOLS.SEARCH.INDEX,
];

/** Tools that change files. */
export const EDIT_TOOLS = [
  'write_file',
  'edit_file',
  'delete_file',
  WORKSPACE_TOOLS.FILESYSTEM.MKDIR,
  WORKSPACE_TOOLS.FILESYSTEM.AST_EDIT,
];

/** Tools that run commands. */
export const EXECUTE_TOOLS = [
  'bash',
  WORKSPACE_TOOLS.SANDBOX.GET_PROCESS_OUTPUT,
  WORKSPACE_TOOLS.SANDBOX.KILL_PROCESS,
];

/** Tools that talk to the user or organise the run rather than touching the project. */
export const INTERACTION_TOOLS = [
  'ask_user',
  'submit_plan',
  'task_write',
  'task_update',
  'task_complete',
  'task_check',
  'agent-explore',
  'web_search',
  'web_fetch',
  // Working memory is the agent's own state, not a project file. Left
  // unclassified it falls through to the gated default, and every note the
  // agent wants to keep costs the user an approval prompt.
  'updateWorkingMemory',
];

const CATEGORY_BY_TOOL = new Map<string, ToolCategory>([
  ...READ_TOOLS.map(name => [name, 'read'] as const),
  ...EDIT_TOOLS.map(name => [name, 'edit'] as const),
  ...EXECUTE_TOOLS.map(name => [name, 'execute'] as const),
  ...INTERACTION_TOOLS.map(name => [name, 'other'] as const),
]);

/**
 * Maps kira-code's tool names onto the controller's permission categories, so a
 * host can say "ask before anything that executes" instead of listing tools.
 */
export function toolCategoryResolver(toolName: string): ToolCategory | null {
  return CATEGORY_BY_TOOL.get(toolName) ?? null;
}

export const PLAN_MODE_INSTRUCTIONS = `You are in PLAN mode.

Investigate and design — do not change the project. The shell is not available to you at all in this mode, and deleting, moving or editing project files is refused.

The one exception is the plan itself: you can and must write it under \`.kira/plans/\`. Writes there go through; writes anywhere else are refused.

Work like this:
1. Explore the code until you actually understand the change: \`search_content\` and \`find_files\` first, \`view\` for the parts that matter, and the \`explore\` subagent for broad "where does X live" questions.
2. Ask with \`ask_user\` when a decision is genuinely the user's to make.
3. Write the plan to a markdown file under \`.kira/plans/\`, then call \`submit_plan\` with that path and stop.

The plan states why the change is needed, the files it touches, the approach, and how to verify it. Include only the approach you recommend.

When the plan is approved you switch to BUILD mode automatically. If it is rejected, revise it with the feedback and submit again.`;

export const BUILD_MODE_INSTRUCTIONS = `You are in BUILD mode.

Implement the work. You have the full toolset: read, edit, and run commands.

If an approved plan exists, follow it and say so when you deviate. Track progress with the task tools for anything three steps or longer, and verify your work by running the project's own tests or typecheck before reporting done.`;

export const FAST_MODE_INSTRUCTIONS = `You are in FAST mode.

Short, direct answers to focused questions — a lookup, a one-line fix, an explanation. No plans, no task lists, no ceremony.

If the request turns out to need multi-file work, say so and suggest switching to plan mode instead of starting it here.`;

/** Mode id → behavioural instructions, delivered by the session-context signal. */
export const MODE_INSTRUCTIONS: Record<string, string> = {
  plan: PLAN_MODE_INSTRUCTIONS,
  build: BUILD_MODE_INSTRUCTIONS,
  fast: FAST_MODE_INSTRUCTIONS,
};
