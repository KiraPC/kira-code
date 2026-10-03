import { createCodingAgent } from '@mastra/core/coding-agent';
import { askUserTool, submitPlanTool, webFetchTool, webSearchTool } from '@mastra/core/tools';
import { Memory } from '@mastra/memory';
import { PROJECT_NAME } from '../config';
import { kiraRequestContextSchema, resolveModel } from '../models';
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
  memory: new Memory({
    options: {
      generateTitle: {
        model: ({ requestContext }) => resolveModel('memory', requestContext),
      },
      workingMemory: { enabled: true, scope: 'resource' },
      observationalMemory: {
        model: ({ requestContext }) => resolveModel('memory', requestContext),
      },
    },
  }),
  agents: { explore: exploreAgent },
  // session-context delivers the volatile session facts the system prompt no
  // longer carries; prompt-cache places the rolling cache breakpoints.
  inputProcessors: [sessionContextProcessor, promptCacheProcessor],
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
