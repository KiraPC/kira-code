/**
 * Terminal front end for kira-code.
 *
 * Drives an AgentController session: streams the agent's output, gates tool
 * approvals, resumes interactive tools (ask_user, submit_plan), and exposes
 * mode/model/thread control through slash commands.
 *
 * Run it with `npm run cli`.
 */
// Must come first: resolves KIRA_HOME, loads the env file, and defaults the
// project directory to the cwd the CLI was started in.
import './cli-bootstrap';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { Session } from '@mastra/core/agent-controller';
import { RequestContext } from '@mastra/core/request-context';
import { defaultCacheSetting, isCacheSetting, type CacheSetting } from './mastra/cache';
import { PROJECT_DIR } from './mastra/config';
import { describeContextState, readContextState, type ContextState } from './mastra/context-state';
import { controller } from './mastra/controller';
import { mastra } from './mastra/index';
import { declaredServers, disconnectMcp, mcpStatus, projectConfigPath, projectTrusted, trustProjectConfig } from './mastra/mcp';
import { memory } from './mastra/memory';
import { defaultModel } from './mastra/models';
import { listSkills } from './mastra/skills';

const color = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

const rl = createInterface({ input: stdin, output: stdout });

/** Input is gone once stdin closes (EOF, Ctrl-D, or a piped script ending). */
let inputClosed = false;
rl.on('close', () => {
  inputClosed = true;
});

/** Prompt for a line, or return null when there is no more input. */
async function ask(prompt: string): Promise<string | null> {
  if (inputClosed) return null;

  try {
    return await rl.question(prompt);
  } catch {
    inputClosed = true;
    return null;
  }
}

/** Text already printed per assistant message, so updates render as deltas. */
const printed = new Map<string, string>();
/** Resolves when the active run reaches a terminal state. */
let runFinished: (() => void) | null = null;

/** A turn a command wants sent on its behalf — see `/skill`. */
let queuedPrompt: string | null = null;

/** Last context notice printed, so a stable window doesn't repeat every step. */
let lastContextNotice = '';

/** The edit policy the user chose; restored when leaving plan mode. */
let editPolicy: 'allow' | 'ask' | 'deny' = 'ask';

/**
 * Prompt-cache setting for this session. It rides the request context so the
 * agent's instructions and the rolling-breakpoint processor both see it.
 */
let cacheSetting: CacheSetting = defaultCacheSetting();

function runRequestContext(): RequestContext {
  const context = new RequestContext();
  context.set('cacheTtl', cacheSetting);
  return context;
}

/**
 * In plan mode the workspace itself refuses every write outside the plans
 * directory, so an approval prompt there would ask about something that is
 * going to be refused anyway. Let the workspace decide instead.
 */
async function applyModePermissions(session: Session): Promise<void> {
  await session.permissions.setForCategory({
    category: 'edit',
    policy: session.mode.get() === 'plan' ? 'allow' : editPolicy,
  });
}

/** Reads the live context state for the session's thread. */
async function readContext(session: Session): Promise<ContextState | null> {
  const threadId = session.thread.getId();
  if (!threadId) return null;

  return readContextState(threadId, session.identity.getResourceId());
}

/**
 * Runs an observation with the message threshold out of the way.
 *
 * `observe()` is documented as a manual trigger, but it still returns early
 * unless the unobserved messages already exceed the automatic threshold — which
 * makes it useless as a "compact now" command. The documented way around it,
 * `updateRecordConfig({ observation: { messageTokens } })`, is silently ignored
 * for any value at or below `bufferTokens` (a fifth of the threshold, 12k on
 * Haiku), so it cannot force a pass on a thread smaller than that either.
 *
 * What is left is the engine's own threshold, lowered for the duration of the
 * call and restored right after. The engine serialises observations behind a
 * lock, and the CLI only accepts a command while no run is in flight, so no
 * other pass can see the lowered value.
 */
async function withForcedObservation<T>(om: unknown, run: () => Promise<T>): Promise<T> {
  const config = (om as { observationConfig?: { messageTokens?: unknown } }).observationConfig;
  const configured = config?.messageTokens;

  if (config) config.messageTokens = 1;
  try {
    return await run();
  } finally {
    if (config) config.messageTokens = configured;
  }
}

async function compact(session: Session, instructions: string): Promise<void> {
  const threadId = session.thread.getId();
  const om = await memory.omEngine;

  if (!threadId || !om) {
    console.log(color.red('nothing to compact: no thread, or observational memory is off'));
    return;
  }

  const before = await readContext(session);
  const resourceId = session.identity.getResourceId();

  console.log(color.dim(`compacting${instructions ? ` — ${instructions}` : ''}…`));

  const result = await withForcedObservation(om, () =>
    om.observe({ threadId, resourceId, trigger: 'manual' }),
  );
  if (instructions) await om.reflect(threadId, resourceId, instructions);

  const after = await readContext(session);

  if (before) console.log(color.dim(`  before  ${describeContextState(before)}`));
  if (after) console.log(color.dim(`  after   ${describeContextState(after)}`));

  if (!result.observed && !instructions) {
    console.log(color.dim('  nothing was observed — too little new history to be worth a pass'));
  }
}

/**
 * A suspended run is not a finished run: an interactive tool is waiting for an
 * answer and the run resumes once it gets one. Returning to the main prompt
 * here would put two readers on stdin, and the main loop would swallow the
 * answer meant for the suspension.
 */
function finishRunIfIdle(session: Session): void {
  if (session.run.isRunning() || session.suspensions.hasPending()) return;
  runFinished?.();
}

function messageText(message: { id: string; role: string; content: { parts?: unknown[] } }): string {
  const parts = message.content?.parts ?? [];
  return parts
    .filter((part): part is { type: 'text'; text: string } => {
      return (
        typeof part === 'object' &&
        part !== null &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string'
      );
    })
    .map(part => part.text)
    .join('');
}

function renderAssistantDelta(message: Parameters<typeof messageText>[0]): void {
  if (message.role !== 'assistant') return;

  const full = messageText(message);
  const already = printed.get(message.id) ?? '';
  if (full.length <= already.length) return;

  stdout.write(full.slice(already.length));
  printed.set(message.id, full);
}

function summarizeArgs(args: unknown): string {
  if (args === null || args === undefined) return '';

  const record = typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const interesting = record.command ?? record.path ?? record.pattern ?? record.prompt;
  const text = typeof interesting === 'string' ? interesting : JSON.stringify(args);

  const oneLine = (text ?? '').replace(/\s+/g, ' ').trim();
  return oneLine.length > 100 ? `${oneLine.slice(0, 100)}…` : oneLine;
}

async function readPlan(path: unknown): Promise<string> {
  if (typeof path !== 'string') return '(no plan path provided)';

  try {
    return await readFile(resolve(PROJECT_DIR, path), 'utf8');
  } catch (error) {
    return `(could not read plan at ${path}: ${error instanceof Error ? error.message : error})`;
  }
}

async function handleApproval(
  session: Session,
  event: { toolCallId: string; toolName: string; args: unknown },
): Promise<void> {
  stdout.write('\n');
  const answer = (
    (await ask(
      color.yellow(
        `⏸  ${event.toolName} wants to run: ${summarizeArgs(event.args)}\n   [y]es / [n]o / [a]lways this category: `,
      ),
    )) ?? 'n'
  )
    .trim()
    .toLowerCase();

  const decision =
    answer === 'y' || answer === 'yes'
      ? 'approve'
      : answer === 'a' || answer === 'always'
        ? 'always_allow_category'
        : 'decline';

  session.respondToToolApproval({ toolCallId: event.toolCallId, decision });
  console.log(color.dim(`   → ${decision}`));
}

async function handleSuspension(
  session: Session,
  event: { toolCallId: string; toolName: string; suspendPayload: unknown },
): Promise<void> {
  stdout.write('\n');

  if (event.toolName === 'submit_plan') {
    const payload = (event.suspendPayload ?? {}) as { path?: string };
    console.log(color.cyan('── plan ──────────────────────────────'));
    console.log(await readPlan(payload.path));
    console.log(color.cyan('──────────────────────────────────────'));

    const answer = ((await ask(color.yellow('Approve plan? [y]es / [n]o: '))) ?? 'n').trim().toLowerCase();
    if (answer === 'y' || answer === 'yes') {
      await session.respondToToolSuspension({
        toolCallId: event.toolCallId,
        resumeData: { action: 'approved', path: payload.path },
      });
      console.log(color.dim('   → approved, switching to build mode'));

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

  console.log(color.yellow(`? ${question}`));
  options.forEach((option, index) => {
    const description = option.description ? color.dim(` — ${option.description}`) : '';
    console.log(`  ${index + 1}) ${option.label ?? ''}${description}`);
  });
  if (options.length > 0) {
    console.log(color.dim(multiSelect ? '  pick numbers, comma separated' : '  pick a number, or type your own answer'));
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

function subscribe(session: Session): () => void {
  // Interactive prompts must not run inside the event listener: the listener is
  // called synchronously from the run loop, and awaiting user input there would
  // stall it. Queue them instead and drain one at a time.
  let pending = Promise.resolve();
  const enqueue = (task: () => Promise<void>) => {
    pending = pending
      .then(task)
      .catch(error => {
        console.error(color.red(`\n${error instanceof Error ? error.message : String(error)}`));
      })
      // A resume that never restarts the run would otherwise hang the prompt.
      .then(() => finishRunIfIdle(session));
  };

  return session.subscribe(event => {
    // KIRA_DEBUG=1 prints the raw event stream: the fastest way to see a
    // mismatch between what you answered and what the agent was told.
    if (process.env.KIRA_DEBUG) {
      const detail = JSON.stringify(event, (key, value) =>
        key === 'message' ? undefined : value,
      );
      console.log(color.dim(`\n[event] ${detail?.slice(0, 400)}`));
    }

    switch (event.type) {
      case 'message_update':
      case 'message_end':
        renderAssistantDelta(event.message);
        break;

      case 'tool_start':
        console.log(color.dim(`\n· ${event.toolName} ${summarizeArgs(event.args)}`));
        break;

      case 'tool_end': {
        if (event.isError) {
          console.log(color.red(`  ✗ ${summarizeArgs(event.result)}`));
          break;
        }
        // Show what an interactive tool actually reported back, so a decision
        // the model received can never silently disagree with what you typed.
        const content = (event.result as { content?: unknown } | undefined)?.content;
        if (typeof content === 'string' && content.startsWith('Plan ')) {
          console.log(color.dim(`  ${content.split('\n')[0]}`));
        }
        break;
      }

      case 'tool_approval_required':
        enqueue(() => handleApproval(session, event));
        break;

      case 'tool_suspended':
        enqueue(() => handleSuspension(session, event));
        break;

      // Observational memory reports its two windows on every step. Without
      // this the context silently compacts itself and you never see it happen.
      case 'om_status': {
        const active = event.windows?.active;
        const buffered = event.windows?.buffered?.observations;
        const messages = active?.messages;
        if (!messages) break;

        const pending = buffered?.projectedMessageRemoval ?? 0;
        const key = `${Math.round(messages.tokens / 1000)}-${Math.round(pending / 1000)}`;
        if (key === lastContextNotice) break;
        lastContextNotice = key;

        if (pending > 0) {
          console.log(
            color.dim(
              `\n[context] ${messages.tokens}/${messages.threshold} tokens — ${pending} queued for compaction`,
            ),
          );
        } else if (messages.tokens > messages.threshold * 0.8) {
          console.log(color.dim(`\n[context] ${messages.tokens}/${messages.threshold} tokens`));
        }
        break;
      }

      case 'mode_changed':
        console.log(color.cyan(`\n[mode: ${event.modeId}]`));
        enqueue(() => applyModePermissions(session));
        break;

      case 'model_changed':
        console.log(color.cyan(`\n[model: ${event.modelId}]`));
        break;

      case 'error':
        console.error(color.red(`\n✗ ${event.error?.message ?? event.error}`));
        break;

      case 'agent_end':
        printed.clear();
        stdout.write('\n');
        if (event.reason && event.reason !== 'complete') {
          console.log(color.dim(`[${event.reason}]`));
        }
        // Queued so it lands after any approval prompt still on screen;
        // resolving here would put the main loop on stdin alongside it.
        if (event.reason !== 'suspended') enqueue(async () => {});
        break;

      default:
        break;
    }
  });
}

const HELP = `
Commands:
  /mode [plan|build|fast]   show or switch mode
  /model <provider/model>   switch the model for the current mode
  /cache [off|5m|1h]        show or set the prompt-cache TTL
  /context                  how much of the context window is in use
  /compact [instructions]   compact now: fold messages into observations
  /mcp [trust]              MCP servers and their state; trust the project's own
  /skills                   list the skills available, and where they come from
  /skill <name> [text]      use a skill in this turn
  /perm <category> <policy> set a permission (read|edit|execute|other × allow|ask|deny)
  /perms                    show current permission rules
  /new [title]              start a new thread
  /threads                  list stored threads
  /switch <threadId>        switch to a thread
  /usage                    token usage for this thread
  /abort                    stop the active run
  /help                     this list
  /exit                     quit
`;

async function runCommand(session: Session, line: string): Promise<boolean> {
  const [command, ...rest] = line.slice(1).trim().split(/\s+/);
  const arg = rest.join(' ');

  switch (command) {
    case 'exit':
    case 'quit':
      return false;

    case 'help':
      console.log(HELP);
      return true;

    case 'mode':
      if (!arg) console.log(`mode: ${session.mode.get()}`);
      else await session.mode.switch({ modeId: arg });
      return true;

    case 'model':
      if (!arg) console.log(`model: ${session.model.get() ?? defaultModel('main')}`);
      else await session.model.switch({ modelId: arg, scope: 'thread' });
      return true;

    case 'perm': {
      const [category, policy] = arg.split(/\s+/);
      if (!category || !policy) {
        console.log('usage: /perm <read|edit|execute|other> <allow|ask|deny>');
        return true;
      }
      if (category === 'edit') editPolicy = policy as typeof editPolicy;
      await session.permissions.setForCategory({
        category: category as 'read' | 'edit' | 'execute' | 'other',
        policy: policy as 'allow' | 'ask' | 'deny',
      });
      console.log(color.dim(`${category} → ${policy}`));
      return true;
    }

    case 'cache':
      if (!arg) {
        console.log(`cache: ${cacheSetting}`);
      } else if (isCacheSetting(arg)) {
        cacheSetting = arg;
        console.log(color.dim(`cache → ${cacheSetting}`));
      } else {
        console.log('usage: /cache <off|5m|1h>');
      }
      return true;

    case 'perms':
      console.log(JSON.stringify(session.permissions.getRules(), null, 2));
      return true;

    case 'new': {
      const thread = await session.thread.create({ title: arg || undefined });
      console.log(color.dim(`new thread ${thread.id}`));
      return true;
    }

    case 'mcp': {
      if (arg === 'trust') {
        const result = trustProjectConfig();
        console.log(
          result.trusted
            ? color.green(`trusted ${projectConfigPath()} — its servers start from the next turn`)
            : color.red(`nothing to trust: ${result.reason}`),
        );
        return true;
      }

      if (arg) {
        console.log(color.dim('usage: /mcp [trust]'));
        return true;
      }

      const servers = await mcpStatus();
      if (servers.length === 0) {
        console.log(color.dim('no MCP servers configured'));
        return true;
      }

      for (const server of servers) {
        const state = server.error
          ? color.red('error')
          : server.active
            ? `${server.tools} tools`
            : color.yellow('not trusted');
        console.log(`${server.name}  ${color.dim(`(${server.source}, ${server.category})`)}  ${state}`);
        console.log(color.dim(`  ${server.transport}`));
        if (server.error) console.log(color.dim(`  ${server.error}`));
      }

      if (servers.some(server => !server.active)) {
        console.log(color.dim(`\nrun /mcp trust to enable the servers declared in ${projectConfigPath()}`));
      }
      return true;
    }

    case 'skills': {
      const skills = listSkills();
      if (skills.length === 0) {
        console.log(color.dim('no skills found'));
        return true;
      }

      for (const skill of skills) {
        const flags = skill.userInvocable ? skill.source : `${skill.source}, not user-invocable`;
        console.log(`${skill.name}  ${color.dim(`(${flags})`)}`);
        if (skill.description) console.log(color.dim(`  ${skill.description}`));
        if (skill.shadows) console.log(color.dim(`  hides ${skill.shadows}`));
      }
      return true;
    }

    case 'skill': {
      const [name, ...args] = rest;
      const skills = listSkills();

      if (!name) {
        console.log(color.dim('usage: /skill <name> [instructions]'));
        return true;
      }

      // Checked here rather than sent and left to the model: a typo should cost
      // a line of output, not a model call that ends in "no such skill".
      const skill = skills.find(candidate => candidate.name === name);
      if (!skill) {
        console.log(color.red(`no skill named "${name}"`));
        console.log(color.dim(`available: ${skills.map(candidate => candidate.name).join(', ') || 'none'}`));
        return true;
      }

      if (!skill.userInvocable) {
        console.log(color.red(`"${name}" is marked user-invocable: false — the agent loads it on its own`));
        return true;
      }

      queuedPrompt = `Use the \`${name}\` skill.${args.length > 0 ? ` ${args.join(' ')}` : ''}`;
      return true;
    }

    case 'threads': {
      const threads = await session.thread.list();
      const current = session.thread.getId();
      for (const thread of threads.slice(0, 20)) {
        const marker = thread.id === current ? '*' : ' ';
        console.log(`${marker} ${thread.id}  ${thread.title || color.dim('(untitled)')}`);
      }
      return true;
    }

    case 'switch':
      if (!arg) console.log('usage: /switch <threadId>');
      else await session.thread.switch({ threadId: arg });
      return true;

    case 'context': {
      const state = await readContext(session);
      console.log(state ? describeContextState(state) : 'no thread yet');
      return true;
    }

    case 'compact':
      await compact(session, arg);
      return true;

    case 'usage':
      console.log(JSON.stringify(session.getTokenUsage(), null, 2));
      return true;

    case 'abort':
      await session.abort();
      return true;

    default:
      console.log(`unknown command: /${command} — try /help`);
      return true;
  }
}

async function main(): Promise<void> {
  await controller.init();

  // The absolute path, not the folder name: two checkouts both called "api"
  // would otherwise share threads, working memory and observations.
  const session = await controller.createSession({ resourceId: PROJECT_DIR, scope: 'cli' });

  // Reads and the interactive tools run freely; edits and commands are gated.
  // Without an explicit 'other' policy, ask_user and submit_plan would sit
  // behind an approval prompt, which makes no sense for tools whose whole job
  // is to ask the user something.
  await session.permissions.setForCategory({ category: 'read', policy: 'allow' });
  await session.permissions.setForCategory({ category: 'other', policy: 'allow' });
  // The interactive tools must never sit behind the approval gate: they are the
  // gate. On resume the controller only exempts ask_user and request_access,
  // so submit_plan needs an explicit allow or its replay comes back denied.
  await session.permissions.setForTool({ toolName: 'submit_plan', policy: 'allow' });
  session.grantTool('submit_plan');
  if (process.env.KIRA_DEBUG) {
    console.log(color.dim(`[debug] submit_plan policy: ${session.resolveToolApproval('submit_plan')}`));
  }
  await session.permissions.setForCategory({ category: 'execute', policy: 'ask' });
  await applyModePermissions(session);

  const unsubscribe = subscribe(session);

  console.log(color.bold(`\nkira-code`));
  console.log(color.dim(`project: ${PROJECT_DIR}`));
  console.log(
    color.dim(
      `mode: ${session.mode.get()}   model: ${session.model.get() ?? defaultModel('main')}   cache: ${cacheSetting}`,
    ),
  );

  // Said once, at the start: a project's MCP servers are read but inert until
  // they are trusted, and silence would read as "there are none".
  const untrusted = declaredServers().filter(server => server.source === 'project');
  if (untrusted.length > 0 && !projectTrusted()) {
    console.log(
      color.yellow(
        `\nthis project declares ${untrusted.length} MCP server(s): ${untrusted.map(server => server.name).join(', ')}`,
      ),
    );
    console.log(color.dim('they start no processes until you run /mcp trust'));
  }

  console.log(color.dim('\n/help for commands, /exit to quit\n'));

  try {
    while (true) {
      const input = await ask(color.green(`${session.mode.get()} › `));
      if (input === null) break;

      const line = input.trim();
      if (!line) continue;

      let content = line;

      if (line.startsWith('/')) {
        if (!(await runCommand(session, line))) break;
        // Most commands are done here; /skill asks for a turn to be sent.
        if (!queuedPrompt) continue;
        content = queuedPrompt;
        queuedPrompt = null;
        console.log(color.dim(content));
      }

      const finished = new Promise<void>(resolveRun => {
        runFinished = resolveRun;
      });

      try {
        await session.sendMessage({ content, requestContext: runRequestContext() });
        await finished;
      } catch (error) {
        console.error(color.red(`\n${error instanceof Error ? error.message : String(error)}`));
      } finally {
        runFinished = null;
      }
    }
  } finally {
    unsubscribe();
    rl.close();
    await disconnectMcp();
    await controller.destroy();
    // Closes workspace resources, including the language servers — without this
    // their child processes keep the CLI alive after the loop ends.
    await mastra.shutdown();
  }
}

main().catch(error => {
  console.error(color.red(error instanceof Error ? error.stack ?? error.message : String(error)));
  process.exit(1);
});
