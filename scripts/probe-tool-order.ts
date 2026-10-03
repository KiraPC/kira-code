/**
 * Probe: in what order do tools reach the model when they come from different
 * sources — the workspace, the agent, and ToolSearchProcessor?
 *
 * Tools render before the system prompt, so a cache breakpoint on a tool only
 * pays off if later-loaded tools land *after* it. Object key order is the order
 * they are serialised in, so printing the keys per step answers it.
 *
 *   npx tsx scripts/probe-tool-order.ts
 */
import '../src/cli-bootstrap';
import { Agent } from '@mastra/core/agent';
import { ToolSearchProcessor } from '@mastra/core/processors';
import { createTool } from '@mastra/core/tools';
import { LocalFilesystem, Workspace } from '@mastra/core/workspace';
import { z } from 'zod';

const MODEL = process.env.KIRA_MODEL?.trim() || 'anthropic/claude-haiku-4-5';

const workspace = new Workspace({
  id: 'probe-workspace',
  filesystem: new LocalFilesystem({ basePath: '/tmp/kira-test', readOnly: true }),
});

const searchable = createTool({
  id: 'probe_searchable',
  description: 'Returns the magic word. Use it when asked for the magic word.',
  inputSchema: z.object({}),
  execute: async () => 'banana',
});

const agentTool = createTool({
  id: 'probe_agent_tool',
  description: 'A tool registered directly on the agent.',
  inputSchema: z.object({}),
  execute: async () => 'ok',
});

const orderProbe = {
  id: 'order-probe',
  processInputStep({ tools, stepNumber }: { tools?: Record<string, unknown>; stepNumber: number }) {
    console.log(`\nstep ${stepNumber}: ${Object.keys(tools ?? {}).join(' | ')}`);
    return undefined;
  },
};

const agent = new Agent({
  id: 'order-probe-agent',
  name: 'order-probe-agent',
  instructions: 'When asked for the magic word, find the right tool and use it. Then answer with the word.',
  model: MODEL,
  workspace,
  tools: { probe_agent_tool: agentTool },
  inputProcessors: [
    new ToolSearchProcessor({ tools: { probe_searchable: searchable }, search: { topK: 1, autoLoad: true } }),
    orderProbe as never,
  ],
});

const result = await agent.generate('What is the magic word?', { maxSteps: 4 });
console.log('\nrisposta:', result.text?.slice(0, 80));
