/**
 * Probe: does a cache breakpoint on a *tool definition* work, and does
 * appending a tool after it keep the cached prefix?
 *
 * Tools render before the system prompt, so a breakpoint on the last tool
 * covers the tool block only. On Haiku 4.5 the minimum cacheable prefix is
 * 4096 tokens, so the tool descriptions below are padded past that — without
 * the padding the API caches nothing and reports no error.
 *
 *   npx tsx scripts/probe-tool-cache.ts
 */
import '../src/cli-bootstrap';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

const MODEL = process.env.KIRA_MODEL?.trim() || 'anthropic/claude-haiku-4-5';

/** Deterministic filler: the prefix must be byte-identical across calls. */
const FILLER = Array.from(
  { length: 60 },
  (_, i) => `Constraint ${i}: the value must be a well-formed identifier and is validated before use.`,
).join(' ');

function padTool(name: string, cached: boolean) {
  return createTool({
    id: name,
    description: `Tool ${name}. ${FILLER}`,
    inputSchema: z.object({ value: z.string().describe(`Input for ${name}. ${FILLER}`) }),
    ...(cached
      ? { providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } }
      : {}),
    execute: async () => `${name} ok`,
  });
}

/** 12 padded tools; the breakpoint sits on the last one. */
function baseTools() {
  const tools: Record<string, ReturnType<typeof padTool>> = {};
  for (let i = 0; i < 11; i++) tools[`probe_tool_${i}`] = padTool(`probe_tool_${i}`, false);
  tools.probe_tool_cached = padTool('probe_tool_cached', true);
  return tools;
}

function agentWith(tools: Record<string, ReturnType<typeof padTool>>) {
  return new Agent({
    id: 'cache-probe',
    name: 'cache-probe',
    // Deliberately short and WITHOUT a breakpoint: any cache activity can only
    // come from the marker on the tool definition.
    instructions: 'Answer with a single word. Never call a tool.',
    model: MODEL,
    tools,
  });
}

function report(label: string, usage: Record<string, unknown> | undefined) {
  const read = Number(usage?.cachedInputTokens ?? 0);
  const write = Number(usage?.cacheCreationInputTokens ?? 0);
  const input = Number(usage?.inputTokens ?? 0);
  console.log(`${label.padEnd(34)} input=${input}  write=${write}  read=${read}`);
  return { read, write };
}

const prompt = 'Reply with the word ok.';

const first = await agentWith(baseTools()).generate(prompt);
report('1. primo giro (scrive)', first.usage as Record<string, unknown>);

const second = await agentWith(baseTools()).generate(prompt);
const { read: readSame } = report('2. stessi tool (dovrebbe leggere)', second.usage as Record<string, unknown>);

// A tool appended AFTER the breakpoint: the span before it is unchanged.
const appended = baseTools();
appended.probe_tool_appended = padTool('probe_tool_appended', false);
const third = await agentWith(appended).generate(prompt);
const { read: readAppended } = report('3. tool appeso in coda', third.usage as Record<string, unknown>);

// A tool inserted BEFORE the breakpoint: the span changes, so it must miss.
const prepended: Record<string, ReturnType<typeof padTool>> = {
  probe_tool_prepended: padTool('probe_tool_prepended', false),
  ...baseTools(),
};
const fourth = await agentWith(prepended).generate(prompt);
const { read: readPrepended } = report('4. tool inserito in testa', fourth.usage as Record<string, unknown>);

console.log('\nEsito:');
console.log(`  cacheControl su un tool onorato: ${readSame > 0 ? 'SÌ' : 'NO'}`);
console.log(`  append dopo il breakpoint conserva la cache: ${readAppended > 0 ? 'SÌ' : 'NO'}`);
console.log(`  insert prima del breakpoint invalida (atteso): ${readPrepended === 0 ? 'SÌ' : 'NO'}`);
