import { AgentsMDInjector } from '@mastra/core/processors';
import { ignoredInstructionPaths, instructionsEnabled } from '../prompts/project-instructions';

/**
 * Instruction files that belong to a subtree, injected when the agent works in
 * it — the monorepo case, where `packages/api/AGENTS.md` only applies there.
 *
 * All the work is Mastra's: the injector reads the paths out of the step's
 * completed tool calls, walks up from them to the nearest AGENTS.md /
 * CLAUDE.md / CONTEXT.md, and sends the content as a `system-reminder`, once per
 * file. The walk reaches the filesystem root, so `ignoredInstructionPaths()`
 * keeps out the project's own file (already in the system prompt) and anything
 * above the project.
 *
 * It has one ordering requirement, and it is invisible when broken. The
 * injector reads the step's tool calls from `messageList.get.response`, and the
 * observational-memory processor puts its own `data-om-status` message in that
 * bucket, leaving the tool results in `get.all`. By default Mastra runs every
 * memory processor *before* the agent's own (`resolveInputProcessors` returns
 * `[...memoryProcessors, ...configuredProcessors]`), so an injector left in the
 * default position silently never fires — no error, no reminder, measured
 * `response=1 all=5`.
 *
 * `agents/kira-code.ts` therefore places the memory processors explicitly,
 * after this one. Move this processor after them and nested instructions stop
 * working, quietly.
 */
export const nestedInstructionsProcessor = new AgentsMDInjector({
  // A nested file gets less room than the project's own: it is one subtree's
  // rules, and it arrives mid-conversation where it costs uncached tokens.
  maxTokens: 4_000,
  getIgnoredInstructionPaths: ignoredInstructionPaths,
  isEnabled: instructionsEnabled,
});
