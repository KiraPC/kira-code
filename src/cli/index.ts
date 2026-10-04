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
import '../cli-bootstrap';
import type { Session } from '@mastra/core/agent-controller';
import { controller } from '../mastra/controller/index';
import { mastra } from '../mastra/index';
import { declaredServers, disconnectMcp, projectTrusted } from '../mastra/mcp';
import { PROJECT_DIR } from '../config';
import { defaultModel } from '../mastra/models';
import type { Renderer } from './session/events';
import { handleApproval, handleSuspension } from './approvals';
import { COMMANDS, runCommand } from './commands';
import {
  applyModePermissions,
  ask,
  cacheSetting,
  io,
  runRequestContext,
  say,
  setIo,
  shownAtApproval,
  takeQueuedPrompt,
} from './state';
import { subscribeSession } from './session/subscribe';
import { runStudio, studioRequested } from './studio';
import { color } from './ui/color';
import { createIo } from './ui/io';
import { createPlainRenderer } from './ui/plain-renderer';

/** Resolves when the active run reaches a terminal state. */
let runFinished: (() => void) | null = null;

/**
 * When the current turn began. A turn can span several runs — every approval
 * and every plan resumes into a new one — and the footer's timer should count
 * the turn, not restart at each of them.
 */
let turnStartedAt: number | null = null;

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

        // The main loop only marks the first run of a turn as running. Without
        // this, the run that resumes after an approval — and the whole build
        // that follows an approved plan — ran behind a footer that said idle.
        case 'run-start':
          turnStartedAt ??= Date.now();
          io.setStatus?.({ running: true, startedAt: turnStartedAt });
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
    onIdle: () => {
      turnStartedAt = null;
      runFinished?.();
    },
  });
}

async function main(): Promise<void> {
  // Before anything reads or writes: Ink on a terminal, plain lines on a pipe.
  setIo(await createIo({ commands: COMMANDS }));

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

  if (studioRequested) say(color.dim('\nstudio: opens after /exit, with the traces of this session'));

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
        const queued = takeQueuedPrompt();
        if (!queued) continue;
        content = queued;
        say(color.dim(content));
      }

      const finished = new Promise<void>(resolveRun => {
        runFinished = resolveRun;
      });

      try {
        turnStartedAt = Date.now();
        io.setStatus?.({ running: true, startedAt: turnStartedAt });
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

  if (studioRequested) process.exitCode = await runStudio();
}

main().catch(error => {
  console.error(color.red(error instanceof Error ? error.stack ?? error.message : String(error)));
  process.exit(1);
});
