import { createCodingAgent } from '@mastra/core/coding-agent';
import { ToolSearchProcessor } from '@mastra/core/processors';
import { askUserTool, submitPlanTool, webFetchTool, webSearchTool } from '@mastra/core/tools';
import { PROJECT_NAME } from '../config';
import { inPlanMode } from '../controller-context';
import { mcpCategoryFor, mcpTools } from '../mcp';
import { memory } from '../memory';
import { kiraRequestContextSchema, resolveModel } from '../models';
import { nestedInstructionsProcessor } from '../processors/nested-instructions';
import { promptCacheProcessor } from '../processors/prompt-cache';
import { sessionContextProcessor } from '../processors/session-context';
import { buildInstructions } from '../prompts/system';
import { workspace } from '../workspace';
import { exploreAgent } from './explore-agent';

/**
 * MCP tools, kept out of the prompt until the model asks for them.
 *
 * Built once and reused: the processor indexes the catalogue, and rebuilding it
 * per request would reconnect to every server on every turn. `mcpTools()` is
 * itself lazy, so a session that never mentions MCP never connects.
 */
let toolSearch: ToolSearchProcessor | null = null;

async function mcpToolSearch(): Promise<ToolSearchProcessor> {
  if (toolSearch) return toolSearch;

  toolSearch = new ToolSearchProcessor({
    tools: (await mcpTools()) as never,
    // Derived from the conversation rather than a process-local map: what the
    // model loaded survives a restart, and is forgotten when the message that
    // loaded it leaves the window.
    storage: 'context',
    search: { topK: 5, autoLoad: true },
    // Plan mode has no shell and refuses project writes; without this an MCP
    // server would be the one way left to change something from a plan.
    filter: ({ toolName, requestContext }) =>
      !inPlanMode(requestContext) || mcpCategoryFor(toolName) === 'read',
  });

  return toolSearch;
}

/**
 * kira-code: a coding agent over the local project. `createCodingAgent` supplies
 * the coding-agent defaults (task signal provider, stream-retry error
 * processors); the workspace, model and prompt are ours.
 */
export const kiraCode = createCodingAgent({
  id: 'kira-code',
  name: 'kira-code',
  description: `A coding agent that reads, writes and runs code in ${PROJECT_NAME}, plans before large changes, and asks for approval on anything destructive.`,
  metadata: {
    suggestedPrompts: [
      'How is this project structured?',
      'Find where errors from the API are handled.',
      'Add a test for the module I just changed.',
    ],
  },
  model: ({ requestContext }) => resolveModel('main', requestContext),
  requestContextSchema: kiraRequestContextSchema,
  instructions: buildInstructions,
  workspace,
  memory,
  agents: { explore: exploreAgent },
  // session-context delivers the volatile session facts the system prompt no
  // longer carries; nested-instructions surfaces the AGENTS.md of whatever
  // subtree the agent is working in; prompt-cache places the rolling cache
  // breakpoints.
  //
  // The memory processors are listed explicitly, and the order is load-bearing.
  // Left implicit, Mastra puts them *first* — and the observational-memory one
  // takes over the message bucket that nested-instructions reads its tool calls
  // from, so nested instructions would silently never appear. Listing them here
  // is the supported way to say otherwise: `getInputProcessors` skips any
  // processor whose id is already configured, so nothing is registered twice.
  inputProcessors: async ({ requestContext }) => [
    sessionContextProcessor,
    nestedInstructionsProcessor,
    ...(await memory.getInputProcessors([], requestContext)),
    promptCacheProcessor,
    // Last on purpose. MCP tools reached through this processor are merged into
    // the request *after* the workspace tools (`inputProcessorLoadedTools` is
    // spread last in convertTools), so they land behind the cache breakpoint on
    // mastra_workspace_index. Handed to the agent directly instead, they would
    // sit in front of it and every change of MCP configuration would rewrite the
    // cached prefix.
    await mcpToolSearch(),
  ],
  tools: {
    ask_user: askUserTool,
    submit_plan: submitPlanTool,
    web_search: webSearchTool,
    web_fetch: webFetchTool,
  },
  defaultOptions: {
    maxSteps: 150,
    autoResumeSuspendedTools: true,
  },
});
