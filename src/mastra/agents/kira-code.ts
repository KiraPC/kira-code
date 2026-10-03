import { createCodingAgent } from '@mastra/core/coding-agent';
import { askUserTool, submitPlanTool, webFetchTool, webSearchTool } from '@mastra/core/tools';
import { PROJECT_NAME } from '../config';
import { memory } from '../memory';
import { kiraRequestContextSchema, resolveModel } from '../models';
import { nestedInstructionsProcessor } from '../processors/nested-instructions';
import { promptCacheProcessor } from '../processors/prompt-cache';
import { sessionContextProcessor } from '../processors/session-context';
import { buildInstructions } from '../prompts/system';
import { workspace } from '../workspace';
import { exploreAgent } from './explore-agent';

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
