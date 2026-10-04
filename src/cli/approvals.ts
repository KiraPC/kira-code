import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Session } from '@mastra/core/agent-controller';
import { PROJECT_DIR } from '../mastra/config';
import { color } from '../ui/color';
import { approvalContext } from '../ui/tool-view';
import { ask, io, say, shownAtApproval } from './state';

/**
 * The interactive gates: approving a tool call, and answering a tool that
 * suspended to ask something.
 *
 * The most fragile code in the CLI, and the least documented upstream — the
 * queue that keeps these off the event listener, the re-gate that makes an
 * approved plan replay as denied, the resume shapes each tool expects. It was
 * found by breaking it, so it moved here whole rather than being rewritten.
 */

async function readPlan(path: unknown): Promise<string> {
  if (typeof path !== 'string') return '(no plan path provided)';

  try {
    return await readFile(resolve(PROJECT_DIR, path), 'utf8');
  } catch (error) {
    return `(could not read plan at ${path}: ${error instanceof Error ? error.message : error})`;
  }
}

export async function handleApproval(
  session: Session,
  event: { toolCallId: string; toolName: string; args: unknown },
): Promise<void> {
  io.write('\n');

  // The file as it still is: nothing has been written yet, so this is the side
  // of the diff that is about to disappear.
  const path = (event.args as { path?: unknown } | undefined)?.path;
  let previous: string | undefined;
  if (typeof path === 'string') {
    try {
      previous = await readFile(resolve(PROJECT_DIR, path), 'utf8');
    } catch {
      previous = undefined;
    }
  }

  const context = approvalContext({ name: event.toolName, args: event.args, previous });
  for (const line of context) say(line);
  if (context.length > 0) shownAtApproval.add(event.toolCallId);

  // The question goes to the selection, not to the log: printed above, it ends
  // up separated from its own answers by whatever the live area is drawing —
  // the task checklist, most of the time.
  const decision =
    (await io.select(color.yellow(`${event.toolName} wants to run — approve?`), [
      { value: 'approve', label: 'yes', key: 'y' },
      { value: 'decline', label: 'no', key: 'n' },
      { value: 'always_allow_category', label: 'always this category', key: 'a' },
    ])) ?? 'decline';

  session.respondToToolApproval({
    toolCallId: event.toolCallId,
    decision: decision as 'approve' | 'decline' | 'always_allow_category',
  });
  if (!io.interactive) say(color.dim(`   → ${decision}`));
}

export async function handleSuspension(
  session: Session,
  event: { toolCallId: string; toolName: string; suspendPayload: unknown },
): Promise<void> {
  io.write('\n');

  if (event.toolName === 'submit_plan') {
    const payload = (event.suspendPayload ?? {}) as { path?: string };
    say(color.cyan('── plan ──────────────────────────────'));
    say(await readPlan(payload.path));
    say(color.cyan('──────────────────────────────────────'));

    const answer = await io.select(color.yellow('Approve plan?'), [
      { value: 'yes', label: 'yes', key: 'y' },
      { value: 'no', label: 'no, with feedback', key: 'n' },
    ]);
    if (answer === 'yes') {
      await session.respondToToolSuspension({
        toolCallId: event.toolCallId,
        resumeData: { action: 'approved', path: payload.path },
      });
      say(color.dim('   → approved, switching to build mode'));

      // Upstream defect in @mastra/core 1.58.0: resumeToolCall() only clears
      // requireToolApproval for ask_user and request_access, so a resumed
      // submit_plan is re-gated and replays as "Tool call was not approved by
      // the user". The mode switch still happens, but the model is told its
      // approved plan was rejected and starts improvising. Say it plainly.
      await session.followUp({
        content: `The plan at ${payload.path ?? 'the submitted path'} was approved. Ignore any tool result saying it was not approved, and implement it now.`,
      });
      return;
    }

    const feedback = (await ask(color.yellow('What should change? '))) ?? '';
    await session.respondToToolSuspension({
      toolCallId: event.toolCallId,
      resumeData: { action: 'rejected', feedback, path: payload.path },
    });
    return;
  }

  const payload = (event.suspendPayload ?? {}) as {
    question?: string;
    message?: string;
    options?: { label?: string; description?: string }[];
    selectionMode?: string;
  };
  const question = payload.question ?? payload.message ?? `${event.toolName} needs input`;
  const options = payload.options ?? [];
  const multiSelect = payload.selectionMode === 'multi_select';

  // A single-choice question is a selection like any other; only multi-select
  // still needs numbers typed, because picking several is not what a list does.
  if (options.length > 0 && !multiSelect) {
    const chosen = await io.select(
      color.yellow(`? ${question}`),
      options.map((option, index) => ({
        value: option.label ?? String(index + 1),
        label: option.label ?? String(index + 1),
        hint: option.description ? color.dim(`— ${option.description}`) : undefined,
        key: String(index + 1),
      })),
    );

    await session.respondToToolSuspension({ toolCallId: event.toolCallId, resumeData: chosen ?? '' });
    return;
  }

  say(color.yellow(`? ${question}`));
  options.forEach((option, index) => {
    const description = option.description ? color.dim(` — ${option.description}`) : '';
    say(`  ${index + 1}) ${option.label ?? ''}${description}`);
  });
  if (options.length > 0) {
    say(color.dim('  pick numbers, comma separated'));
  }

  const raw = (await ask(color.yellow('> '))) ?? '';

  // The tool resumes with option labels, not indexes — and with an array when
  // the question allows several answers.
  const chosen = raw
    .split(',')
    .map(part => part.trim())
    .filter(part => part.length > 0)
    .map(part => {
      const index = Number(part);
      return Number.isInteger(index) && index >= 1 && index <= options.length
        ? options[index - 1]?.label ?? part
        : part;
    });

  const resumeData = multiSelect ? chosen : chosen.join(', ') || raw;
  await session.respondToToolSuspension({ toolCallId: event.toolCallId, resumeData });
}
