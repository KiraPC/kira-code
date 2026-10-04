import { AgentController } from '@mastra/core/agent-controller';
import { kiraCode } from '../agent/kira-code';
import { defaultModel } from '../models';
import { toolCategoryResolver } from './modes';
import { storage } from '../storage';
import { workspace } from '../agent/workspace';

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
    // Tested: letting the controller provide submit_plan instead (the way
    // Mastra Code does) does not avoid the resume re-gate — the approved call
    // still replays as output-denied. The correction in
    // request/plan-approval.ts stays.
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
      // No `availableTools` here, deliberately — see workspace.ts.
      //
      // It does work (measured: the model listed exactly the allowed tools),
      // and it is what Mastra Code uses. But it is an allowlist: every tool
      // the runtime adds has to be named in it or it silently disappears. Ours
      // dropped `updateWorkingMemory` and the three skill tools without a
      // word, and `updateWorkingMemory` sits ahead of the tool-cache
      // breakpoint, so the tool prefix was invalidated on every mode switch
      // too. Hiding the shell is a three-name denylist; that is what we use.
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
