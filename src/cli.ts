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
import type { Renderer } from './session/events';
import { subscribeSession } from './session/subscribe';
import { color } from './ui/color';
import { createIo, type Io } from './ui/io';
import { createPlainRenderer } from './ui/plain-renderer';
import { approvalContext } from './ui/tool-view';

/**
 * The terminal, behind an interface: Ink when there is a screen to draw on, and
 * plain lines when stdout is a pipe. Assigned in `main()` before anything reads
 * or writes.
 */
let io!: Io;

/** Prompt for a line, or return null when there is no more input. */
function ask(prompt: string): Promise<string | null> {
  return io.ask(prompt);
}

/** A finished line of output. */
function say(text = ''): void {
  io.line(text);
}

/** Resolves when the active run reaches a terminal state. */
let runFinished: (() => void) | null = null;

/**
 * Calls whose diff was already shown while asking about them, so the renderer
 * does not repeat it when they finish.
 */
const shownAtApproval = new Set<string>();

/** A turn a command wants sent on its behalf — see `/skill`. */
let queuedPrompt: string | null = null;

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
    say(color.red('nothing to compact: no thread, or observational memory is off'));
    return;
  }

  const before = await readContext(session);
  const resourceId = session.identity.getResourceId();

  say(color.dim(`compacting${instructions ? ` — ${instructions}` : ''}…`));

  const result = await withForcedObservation(om, () =>
    om.observe({ threadId, resourceId, trigger: 'manual' }),
  );
  if (instructions) await om.reflect(threadId, resourceId, instructions);

  const after = await readContext(session);

  if (before) say(color.dim(`  before  ${describeContextState(before)}`));
  if (after) say(color.dim(`  after   ${describeContextState(after)}`));

  if (!result.observed && !instructions) {
    say(color.dim('  nothing was observed — too little new history to be worth a pass'));
  }
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

async function handleSuspension(
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

/**
 * The lines renderer, plus the footer's share of the same events.
 *
 * Both renderers get the lines; only an interactive one has somewhere to put a
 * status that changes without a line being written, so `setStatus` is absent on
 * the plain side and these calls simply do nothing there.
 */
function createRenderer(session: Session): Renderer {
  const lines = createPlainRenderer(io, shownAtApproval);

  return {
    handle(event) {
      lines.handle(event);

      switch (event.type) {
        case 'mode':
          io.setStatus?.({ mode: event.mode });
          break;

        case 'model':
          io.setStatus?.({ model: event.model });
          break;

        case 'context':
          io.setStatus?.({ contextTokens: event.tokens, contextThreshold: event.threshold });
          break;

        case 'tasks':
          io.setTasks?.(event.tasks);
          break;

        // Usage is cumulative and cheap to read, but reading it per token would
        // be noise: a tool boundary is often enough to watch it climb.
        case 'tool-end':
          io.setStatus?.({ tokens: session.getTokenUsage().totalTokens });
          break;

        case 'run-end':
          io.setStatus?.({
            running: false,
            startedAt: null,
            tokens: session.getTokenUsage().totalTokens,
          });
          break;

        default:
          break;
      }
    },
  };
}

function subscribe(session: Session): () => void {
  return subscribeSession({
    session,
    renderer: createRenderer(session),
    onApproval: event => handleApproval(session, event),
    onSuspension: event => handleSuspension(session, event),
    onModeChange: () => applyModePermissions(session),
    onIdle: () => runFinished?.(),
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

/**
 * The command names, read out of HELP so completion cannot drift from the list
 * the user is shown.
 */
const COMMANDS = [...HELP.matchAll(/^ {2}\/(\w+)/gm)].map(match => match[1] ?? '').filter(Boolean);

async function runCommand(session: Session, line: string): Promise<boolean> {
  const [command, ...rest] = line.slice(1).trim().split(/\s+/);
  const arg = rest.join(' ');

  switch (command) {
    case 'exit':
    case 'quit':
      return false;

    case 'help':
      say(HELP);
      return true;

    case 'mode':
      if (!arg) say(`mode: ${session.mode.get()}`);
      else await session.mode.switch({ modeId: arg });
      return true;

    case 'model':
      if (!arg) say(`model: ${session.model.get() ?? defaultModel('main')}`);
      else await session.model.switch({ modelId: arg, scope: 'thread' });
      return true;

    case 'perm': {
      const [category, policy] = arg.split(/\s+/);
      if (!category || !policy) {
        say('usage: /perm <read|edit|execute|other> <allow|ask|deny>');
        return true;
      }
      if (category === 'edit') editPolicy = policy as typeof editPolicy;
      await session.permissions.setForCategory({
        category: category as 'read' | 'edit' | 'execute' | 'other',
        policy: policy as 'allow' | 'ask' | 'deny',
      });
      say(color.dim(`${category} → ${policy}`));
      return true;
    }

    case 'cache':
      if (!arg) {
        say(`cache: ${cacheSetting}`);
      } else if (isCacheSetting(arg)) {
        cacheSetting = arg;
        io.setStatus?.({ cache: cacheSetting });
        say(color.dim(`cache → ${cacheSetting}`));
      } else {
        say('usage: /cache <off|5m|1h>');
      }
      return true;

    case 'perms':
      say(JSON.stringify(session.permissions.getRules(), null, 2));
      return true;

    case 'new': {
      const thread = await session.thread.create({ title: arg || undefined });
      say(color.dim(`new thread ${thread.id}`));
      return true;
    }

    case 'mcp': {
      if (arg === 'trust') {
        const result = trustProjectConfig();
        say(
          result.trusted
            ? color.green(`trusted ${projectConfigPath()} — its servers start from the next turn`)
            : color.red(`nothing to trust: ${result.reason}`),
        );
        return true;
      }

      if (arg) {
        say(color.dim('usage: /mcp [trust]'));
        return true;
      }

      const servers = await mcpStatus();
      if (servers.length === 0) {
        say(color.dim('no MCP servers configured'));
        return true;
      }

      for (const server of servers) {
        const state = server.error
          ? color.red('error')
          : server.active
            ? `${server.tools} tools`
            : color.yellow('not trusted');
        say(`${server.name}  ${color.dim(`(${server.source}, ${server.category})`)}  ${state}`);
        say(color.dim(`  ${server.transport}`));
        if (server.error) say(color.dim(`  ${server.error}`));
      }

      if (servers.some(server => !server.active)) {
        say(color.dim(`\nrun /mcp trust to enable the servers declared in ${projectConfigPath()}`));
      }
      return true;
    }

    case 'skills': {
      const skills = listSkills();
      if (skills.length === 0) {
        say(color.dim('no skills found'));
        return true;
      }

      for (const skill of skills) {
        const flags = skill.userInvocable ? skill.source : `${skill.source}, not user-invocable`;
        say(`${skill.name}  ${color.dim(`(${flags})`)}`);
        if (skill.description) say(color.dim(`  ${skill.description}`));
        if (skill.shadows) say(color.dim(`  hides ${skill.shadows}`));
      }
      return true;
    }

    case 'skill': {
      const [name, ...args] = rest;
      const skills = listSkills();

      if (!name) {
        say(color.dim('usage: /skill <name> [instructions]'));
        return true;
      }

      // Checked here rather than sent and left to the model: a typo should cost
      // a line of output, not a model call that ends in "no such skill".
      const skill = skills.find(candidate => candidate.name === name);
      if (!skill) {
        say(color.red(`no skill named "${name}"`));
        say(color.dim(`available: ${skills.map(candidate => candidate.name).join(', ') || 'none'}`));
        return true;
      }

      if (!skill.userInvocable) {
        say(color.red(`"${name}" is marked user-invocable: false — the agent loads it on its own`));
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
        say(`${marker} ${thread.id}  ${thread.title || color.dim('(untitled)')}`);
      }
      return true;
    }

    case 'switch':
      if (!arg) say('usage: /switch <threadId>');
      else await session.thread.switch({ threadId: arg });
      return true;

    case 'context': {
      const state = await readContext(session);
      say(state ? describeContextState(state) : 'no thread yet');
      return true;
    }

    case 'compact':
      await compact(session, arg);
      return true;

    case 'usage':
      say(JSON.stringify(session.getTokenUsage(), null, 2));
      return true;

    case 'abort':
      await session.abort();
      return true;

    default:
      say(`unknown command: /${command} — try /help`);
      return true;
  }
}

async function main(): Promise<void> {
  // Before anything reads or writes: Ink on a terminal, plain lines on a pipe.
  io = await createIo({ commands: COMMANDS });

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
    say(color.dim(`[debug] submit_plan policy: ${session.resolveToolApproval('submit_plan')}`));
  }
  await session.permissions.setForCategory({ category: 'execute', policy: 'ask' });
  await applyModePermissions(session);

  io.setStatus?.({
    mode: session.mode.get(),
    model: session.model.get() ?? defaultModel('main'),
    cache: cacheSetting,
  });
  io.onInterrupt?.(() => {
    void session.abort();
  });
  io.onCycleMode?.(() => {
    const order = ['build', 'plan', 'fast'];
    const next = order[(order.indexOf(session.mode.get()) + 1) % order.length] ?? 'build';
    void session.mode.switch({ modeId: next });
  });

  const unsubscribe = subscribe(session);

  say(color.bold(`\nkira-code`));
  say(color.dim(`project: ${PROJECT_DIR}`));
  say(
    color.dim(
      `mode: ${session.mode.get()}   model: ${session.model.get() ?? defaultModel('main')}   ` +
        `cache: ${cacheSetting}   ui: ${io.interactive ? 'ink' : 'plain'}`,
    ),
  );

  // Said once, at the start: a project's MCP servers are read but inert until
  // they are trusted, and silence would read as "there are none".
  const untrusted = declaredServers().filter(server => server.source === 'project');
  if (untrusted.length > 0 && !projectTrusted()) {
    say(
      color.yellow(
        `\nthis project declares ${untrusted.length} MCP server(s): ${untrusted.map(server => server.name).join(', ')}`,
      ),
    );
    say(color.dim('they start no processes until you run /mcp trust'));
  }

  say(color.dim('\n/help for commands, /exit to quit\n'));

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
        say(color.dim(content));
      }

      const finished = new Promise<void>(resolveRun => {
        runFinished = resolveRun;
      });

      try {
        io.setStatus?.({ running: true, startedAt: Date.now() });
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
    await io.close();
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
