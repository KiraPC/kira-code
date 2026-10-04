import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { ToolCategory } from '@mastra/core/agent-controller';
import type { MCPClient as MCPClientType } from '@mastra/mcp';
import { PROJECT_DIR } from './config';

/**
 * MCP servers: where they are declared, which ones are allowed to run, and what
 * their tools are permitted to do.
 *
 * Two sources. `~/.kira/mcp.json` is yours and always active. The project's
 * `.kira/mcp.json` is read but stays inert until `/mcp trust`, because a server
 * definition is a command line: trusting a checkout here means letting it start
 * a process on your machine, which is a larger promise than the one AGENTS.md
 * asks for. The consent is recorded against a hash of the file, so editing it
 * withdraws the consent — otherwise the first `/mcp trust` would be a signature
 * on a blank page.
 */
export type McpServerConfig = {
  /** stdio transport */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** HTTP/SSE transport */
  url?: string;
  headers?: Record<string, string>;
  /** Per-server timeout, milliseconds. */
  timeout?: number;
  /**
   * What its tools are allowed to do without asking. Absent means `execute`,
   * which is gated: when whoever wrote the file said nothing, assume the tools
   * have consequences.
   */
  category?: ToolCategory;
};

type McpFile = { servers?: Record<string, McpServerConfig> };

export type McpSource = 'global' | 'project';

export type ResolvedServer = McpServerConfig & { name: string; source: McpSource };

const GLOBAL_CONFIG = resolve(process.env.KIRA_MCP_CONFIG?.trim() || resolve(homedir(), '.kira/mcp.json'));
const PROJECT_CONFIG = resolve(PROJECT_DIR, '.kira/mcp.json');
const TRUST_FILE = resolve(homedir(), '.kira/mcp-trust.json');

/** Discovery must not hold up a turn; a server that is slow is a server that is out. */
const DISCOVERY_TIMEOUT_MS = 8_000;

function readJson<T>(path: string): T | null {
  if (!statSync(path, { throwIfNoEntry: false })?.isFile()) return null;

  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (error) {
    console.warn(`[mcp] ignoring ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** `${VAR}` from the environment, so tokens live in the env and not in the file. */
function expand(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => process.env[name] ?? '');
}

function expandConfig(config: McpServerConfig): McpServerConfig {
  const entries = (record?: Record<string, string>) =>
    record && Object.fromEntries(Object.entries(record).map(([key, value]) => [key, expand(value)]));

  return {
    ...config,
    args: config.args?.map(expand),
    env: entries(config.env),
    headers: entries(config.headers),
    url: config.url ? expand(config.url) : undefined,
  };
}

function fileHash(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

export function projectConfigPath(): string {
  return PROJECT_CONFIG;
}

/** Whether the project's config is trusted *as it currently reads*. */
export function projectTrusted(): boolean {
  const hash = fileHash(PROJECT_CONFIG);
  if (!hash) return false;

  const trust = readJson<Record<string, string>>(TRUST_FILE) ?? {};
  return trust[PROJECT_DIR] === hash;
}

/** Records consent for the project's config exactly as it reads right now. */
export function trustProjectConfig(): { trusted: boolean; reason?: string } {
  const hash = fileHash(PROJECT_CONFIG);
  if (!hash) return { trusted: false, reason: `no config at ${PROJECT_CONFIG}` };

  const trust = readJson<Record<string, string>>(TRUST_FILE) ?? {};
  trust[PROJECT_DIR] = hash;

  mkdirSync(dirname(TRUST_FILE), { recursive: true });
  writeFileSync(TRUST_FILE, `${JSON.stringify(trust, null, 2)}\n`);

  return { trusted: true };
}

function serversFrom(path: string, source: McpSource): ResolvedServer[] {
  const file = readJson<McpFile>(path);

  return Object.entries(file?.servers ?? {}).map(([name, config]) => ({
    ...expandConfig(config),
    name,
    source,
  }));
}

/** Every server declared for this project, whether or not it is allowed to run. */
export function declaredServers(): ResolvedServer[] {
  return [...serversFrom(GLOBAL_CONFIG, 'global'), ...serversFrom(PROJECT_CONFIG, 'project')];
}

/** The servers that may actually be started: global always, project once trusted. */
export function activeServers(): ResolvedServer[] {
  const trusted = projectTrusted();
  const byName = new Map<string, ResolvedServer>();

  for (const server of declaredServers()) {
    if (server.source === 'project' && !trusted) continue;
    byName.set(server.name, server);
  }

  return [...byName.values()];
}

/**
 * The permission category for an MCP tool.
 *
 * Tools are named `serverName_toolName`, and a server name may itself contain
 * an underscore, so the longest matching prefix wins rather than the first one.
 */
export function mcpCategoryFor(toolName: string): ToolCategory | null {
  let match: ResolvedServer | undefined;

  for (const server of activeServers()) {
    if (!toolName.startsWith(`${server.name}_`)) continue;
    if (!match || server.name.length > match.name.length) match = server;
  }

  if (!match) return null;
  return match.category ?? 'execute';
}

type Discovery = {
  tools: Record<string, unknown>;
  errors: Record<string, string>;
  client: MCPClientType | null;
};

let discovery: Promise<Discovery> | null = null;
let discoveryKey = '';

function keyOf(servers: ResolvedServer[]): string {
  return JSON.stringify(servers.map(server => [server.name, server.command, server.url, server.args]));
}

async function discover(servers: ResolvedServer[]): Promise<Discovery> {
  if (servers.length === 0) return { tools: {}, errors: {}, client: null };

  const { MCPClient } = await import('@mastra/mcp');

  const definitions = Object.fromEntries(
    servers.map(server => [
      server.name,
      server.url
        ? { url: new URL(server.url), requestInit: server.headers ? { headers: server.headers } : undefined, timeout: server.timeout }
        : { command: server.command ?? '', args: server.args, env: server.env, timeout: server.timeout },
    ]),
  );

  const client = new MCPClient({
    id: `kira-code:${PROJECT_DIR}`,
    timeout: DISCOVERY_TIMEOUT_MS,
    servers: definitions as never,
  });

  // A server that fails to spawn makes the client log the same failure three
  // times, each with a serialised cause and a stack. The failure is already
  // reported once, in one line, by `/mcp` — so its logger is muted and only
  // debug output survives.
  (client as unknown as { __setLogger?: (logger: unknown) => void }).__setLogger?.({
    debug: (...args: unknown[]) => process.env.KIRA_DEBUG && console.log('[mcp]', ...args),
    info: () => {},
    warn: () => {},
    error: (...args: unknown[]) => process.env.KIRA_DEBUG && console.log('[mcp]', ...args),
    trackException: () => {},
  });

  try {
    const { tools, errors: raw } = await client.listToolsWithErrors();

    // Transport failures arrive with a stack attached; the first line is the
    // part a person needs, and the rest turns `/mcp` into a wall of text.
    const errors = Object.fromEntries(
      Object.entries(raw).map(([name, message]) => [name, String(message).split('\n')[0]?.trim() ?? '']),
    );

    // Sorted so the catalogue is byte-stable between runs: an unstable tool
    // order would move the prompt around for no reason.
    const sorted = Object.fromEntries(Object.entries(tools).sort(([a], [b]) => a.localeCompare(b)));

    for (const [name, error] of Object.entries(errors)) console.warn(`[mcp] ${name}: ${error}`);
    if (process.env.KIRA_DEBUG) console.log(`[mcp] ${Object.keys(sorted).length} tools from ${servers.length} server(s)`);

    return { tools: sorted, errors, client };
  } catch (error) {
    // A broken MCP setup must not stop the agent from working on the project.
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[mcp] discovery failed: ${message}`);

    return { tools: {}, errors: Object.fromEntries(servers.map(server => [server.name, message])), client };
  }
}

/**
 * The MCP tools, connected on first use rather than at startup: a session that
 * never needs them never pays for them, and a hanging server delays one turn
 * instead of the whole CLI.
 */
export function mcpDiscovery(): Promise<Discovery> {
  const servers = activeServers();
  const key = keyOf(servers);

  if (!discovery || key !== discoveryKey) {
    discoveryKey = key;
    discovery = discover(servers);
  }

  return discovery;
}

export async function mcpTools(): Promise<Record<string, unknown>> {
  return (await mcpDiscovery()).tools;
}

export type McpStatus = {
  name: string;
  source: McpSource;
  category: ToolCategory;
  transport: string;
  active: boolean;
  tools: number;
  error?: string;
};

export async function mcpStatus(): Promise<McpStatus[]> {
  const { tools, errors } = await mcpDiscovery();
  const active = new Set(activeServers().map(server => server.name));

  return declaredServers().map(server => ({
    name: server.name,
    source: server.source,
    category: server.category ?? 'execute',
    transport: server.url ? server.url : [server.command, ...(server.args ?? [])].join(' '),
    active: active.has(server.name),
    tools: Object.keys(tools).filter(name => name.startsWith(`${server.name}_`)).length,
    error: errors[server.name],
  }));
}

export async function disconnectMcp(): Promise<void> {
  if (!discovery) return;

  const { client } = await discovery;
  await client?.disconnect().catch(() => {});
}
