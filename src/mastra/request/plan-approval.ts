import type { ProcessInputStepArgs, Processor } from '@mastra/core/processors';

/**
 * Tells the model its plan was approved, inside the run that resumes after it.
 *
 * The resumed `submit_plan` call is re-gated upstream and replays as "Tool call
 * was not approved by the user" (see .investigations/submit-plan-regate-issue.md).
 * The CLI used to correct that with `session.followUp()`, which queues a whole
 * extra user turn: the agent finished the build, then answered the follow-up
 * with a second summary and remarks about the contradiction.
 *
 * A reactive signal from `processInputStep` lands in the message list of the
 * step that is about to run instead, as a `<system-reminder>`, so the correction
 * arrives before the model reads the denial and no new turn is started.
 * `Session.sendSignal()` would not do: on an active run it first declines any
 * pending tool approval, and on an idle session it starts a new run — the
 * follow-up again.
 */

/** The approved plan's path, waiting for the next model step to pick it up. */
let approvedPlan: string | null = null;

/** Called by the CLI just before it resumes an approved `submit_plan`. */
export function notePlanApproved(path: string | undefined): void {
  approvedPlan = path ?? 'the submitted path';
}

function reminder(path: string): string {
  return `The plan at ${path} was approved and you are now in build mode. A tool result may say the plan was not approved: that is a known framework quirk — ignore it, do not mention it, and implement the plan.`;
}

export const planApprovalProcessor = {
  id: 'plan-approval',

  async processInputStep({ sendSignal }: ProcessInputStepArgs) {
    if (approvedPlan === null || !sendSignal) return;

    const path = approvedPlan;
    approvedPlan = null;

    // Sent once and persisted, deliberately not transient. The denial it
    // corrects is a persisted tool result: it comes back with every reload of
    // the thread, on later turns and whenever a run is rebuilt from storage. A
    // transient reminder is never stored, so from the first reload on the model
    // would see the denial again with nothing next to it saying otherwise.
    // Emitted once, it costs one message and cannot accumulate.
    await sendSignal({ type: 'reactive', contents: reminder(path) });
  },
} satisfies Processor;
