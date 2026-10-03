import { AgentController } from '@mastra/core/agent-controller';
import { kiraCode } from './agents/kira-code';
import { defaultModel } from './models';
import { toolCategoryResolver } from './modes';
import { storage } from './storage';
import { workspace } from './workspace';

/**
 * Mode instructions are deliberately NOT set here. The controller concatenates
 * them onto the agent's instructions, which is the block carrying the prompt
 * cache breakpoint — every /mode would rewrite the cached prefix. They are
 * delivered by the session-context state signal instead, after that prefix.
 *
 * The harness around kira-code: sessions, plan/build/fast modes, per-mode model
 * selection and tool permissions. The backing agent is the same one Studio
 * talks to, so both front ends share threads and memory.
 *
 * Built-in controller tools are disabled because the agent already owns
 * equivalents (ask_user, submit_plan, the task tools and the explore subagent).
 */
export const controller = new AgentController({
  id: 'kira-code',
  agent: kiraCode,
  storage,
  workspace,
  defaultModeId: 'build',
  toolCategoryResolver,
  disableBuiltinTools: [
    'ask_user',
    'submit_plan',
    'task_write',
    'task_update',
    'task_complete',
    'task_check',
    'subagent',
  ],
  modes: [
    {
      id: 'plan',
      name: 'Plan',
      description: 'Investigate and propose a plan. Cannot modify the project.',
      // No `availableTools` allowlist here on purpose: it did not restrict the
      // workspace tools in practice, and plan mode has to keep `write_file` so
      // the agent can write the plan it submits. The real restriction lives in
      // `workspace.ts`, which can look at the target path as well as the mode.
      transitionsTo: 'build',
      defaultModelId: defaultModel('main'),
    },
    {
      id: 'build',
      name: 'Build',
      description: 'Implement the work with the full toolset.',
      metadata: { default: true },
      defaultModelId: defaultModel('main'),
    },
    {
      id: 'fast',
      name: 'Fast',
      description: 'Short answers to focused questions on a cheap model.',
      defaultModelId: defaultModel('fast'),
    },
  ],
});
