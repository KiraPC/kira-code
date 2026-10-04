import type { Session } from '@mastra/core/agent-controller';
import { isCacheSetting } from '../mastra/request/cache';
import { describeContextState, readContextState, type ContextState } from '../mastra/memory/usage';
import { mcpStatus, projectConfigPath, trustProjectConfig } from '../mastra/mcp';
import { memory } from '../mastra/memory/index';
import { defaultModel } from '../mastra/models';
import { listSkills } from '../mastra/skills';
import { color } from './ui/color';
import { cacheSetting, queuePrompt, say, setCacheSetting, setEditPolicy } from './state';

/**
 * The slash commands, and the two things only they do: compacting on demand and
 * reporting what the thread occupies.
 *
 * They are the part of the CLI a renderer never touches — every one of them
 * answers in lines, which is why the Ink screen and a pipe show the same thing
 * here.
 */

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

export const HELP = `
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
export const COMMANDS = [...HELP.matchAll(/^ {2}\/(\w+)/gm)].map(match => match[1] ?? '').filter(Boolean);

export async function runCommand(session: Session, line: string): Promise<boolean> {
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
      if (category === 'edit') setEditPolicy(policy as 'allow' | 'ask' | 'deny');
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
        setCacheSetting(arg);
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

      queuePrompt(`Use the \`${name}\` skill.${args.length > 0 ? ` ${args.join(' ')}` : ''}`);
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
