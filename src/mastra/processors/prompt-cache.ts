import type { ProcessInputStepArgs, ProcessLLMRequestArgs, Processor } from '@mastra/core/processors';
import { cacheControlOptions, isAnthropicModel, resolveCacheSetting } from '../cache';

/**
 * Rolling cache breakpoints over the conversation.
 *
 * The system prompt carries its own breakpoint (see `prompts/system.ts`), which
 * covers the largest fixed span. This processor covers the part that grows: as
 * the conversation gets longer, the breakpoints move forward with it so each
 * turn extends the cached prefix instead of rebuilding it.
 *
 * Two hard limits from the API shape the placement:
 *
 * 1. A request may carry at most 4 breakpoints. One is spent on the system
 *    prompt, leaving 3 here.
 * 2. A breakpoint looks back at most 20 content blocks to find the previous
 *    cache entry. A single agentic turn easily adds more than 20 blocks (tool
 *    call + tool result per step), so without intermediate breakpoints the next
 *    request finds nothing and misses the cache — silently, with no error.
 *
 * This runs in `processLLMRequest` on purpose: changes there apply to the
 * outbound request only and are never persisted to the message list, memory or
 * history. Cache markers are a property of one call, not of the conversation.
 */
const MAX_MESSAGE_BREAKPOINTS = 2;

/** Kept under the API's 20-block lookback, with room for the next turn's blocks. */
const MAX_BLOCKS_BETWEEN_BREAKPOINTS = 12;

/**
 * The tool the tool-block breakpoint goes on.
 *
 * Tools render before everything else, and the workspace registers them in a
 * fixed order that ends with the sandbox tools and lsp_inspect. `bash` and its
 * two siblings disappear in plan mode, so the marker has to sit before them —
 * on the last tool that is present in every mode — or the span would change
 * with the mode and never be read back.
 */
const TOOL_BREAKPOINT_PREFERRED = 'mastra_workspace_index';

/** Tools registered after the preferred one; never valid as the marker. */
const TOOLS_AFTER_BREAKPOINT = [
  'bash',
  'mastra_workspace_execute_command',
  'mastra_workspace_get_process_output',
  'mastra_workspace_kill_process',
  'lsp_inspect',
  'mastra_workspace_lsp_inspect',
];

function chooseToolBreakpoint(names: string[]): string | undefined {
  if (names.includes(TOOL_BREAKPOINT_PREFERRED)) return TOOL_BREAKPOINT_PREFERRED;

  // Fallback for a workspace without BM25: the last tool that still precedes
  // the mode-dependent ones.
  for (let i = names.length - 1; i >= 0; i--) {
    const name = names[i];
    if (name && !TOOLS_AFTER_BREAKPOINT.includes(name)) return name;
  }

  return undefined;
}

type PromptMessage = ProcessLLMRequestArgs['prompt'][number];

function contentBlockCount(message: PromptMessage): number {
  return Array.isArray(message.content) ? message.content.length : 1;
}

/**
 * The first system message — ours, the one built to be byte-identical.
 *
 * Mastra Code marks the *last* system block instead, which covers the blocks
 * Mastra appends after ours (task list, workspace, skills, working memory).
 * Measured here, that is worse: the task-list block comes and goes between
 * requests (6 system blocks on one turn, 5 on the next), and it sits ahead of
 * the others, so a span that includes it is invalidated whenever it toggles.
 * Our own block hashed identical across every request.
 *
 * The appended blocks are covered by the rolling message breakpoints anyway,
 * since a breakpoint on a message covers every system block before it.
 */
function stableSystemIndex(prompt: ProcessLLMRequestArgs['prompt']): number {
  return prompt.findIndex(message => message?.role === 'system');
}

/**
 * Indexes of the messages to mark, newest first, spaced so no gap exceeds the
 * lookback window.
 */
function chooseBreakpoints(prompt: ProcessLLMRequestArgs['prompt']): number[] {
  const chosen: number[] = [];
  let blocksSinceLast = 0;

  for (let index = prompt.length - 1; index >= 0; index--) {
    const message = prompt[index];
    // A system message is already covered by the instructions breakpoint.
    if (!message || message.role === 'system' || !Array.isArray(message.content)) continue;
    if (message.content.length === 0) continue;

    // Always anchor the newest eligible message: that is the point the next
    // request will look back to.
    if (chosen.length === 0 || blocksSinceLast >= MAX_BLOCKS_BETWEEN_BREAKPOINTS) {
      chosen.push(index);
      blocksSinceLast = 0;
      if (chosen.length === MAX_MESSAGE_BREAKPOINTS) break;
    }

    blocksSinceLast += contentBlockCount(message);
  }

  return chosen;
}

export const promptCacheProcessor = {
  id: 'prompt-cache',

  /**
   * Marks the tool block so it survives a mode switch.
   *
   * The workspace tool config has no `providerOptions`, so the marker is
   * attached here instead — `processInputStep` is the documented place to
   * read and replace the step's tools.
   */
  processInputStep({ tools, model, requestContext }: ProcessInputStepArgs) {
    const providerOptions = cacheControlOptions(resolveCacheSetting(requestContext));
    if (!providerOptions) return;
    if (!isAnthropicModel((model as { modelId?: unknown } | undefined)?.modelId)) return;

    const names = Object.keys(tools ?? {});
    const target = chooseToolBreakpoint(names);

    if (!target || !tools) {
      if (process.env.KIRA_DEBUG) console.log('[cache] no tool to mark; tool block uncached');
      return;
    }

    const existing = tools[target] as { providerOptions?: Record<string, unknown> };
    if (process.env.KIRA_DEBUG) {
      console.log(`[cache] tool breakpoint on ${target} (${names.length} tools)`);
      console.log(`[cache] tools: ${names.join(' ')}`);
    }

    return {
      tools: {
        ...tools,
        [target]: { ...existing, providerOptions: { ...existing.providerOptions, ...providerOptions } },
      },
    };
  },

  processLLMRequest({ prompt, model, requestContext }: ProcessLLMRequestArgs) {
    const providerOptions = cacheControlOptions(resolveCacheSetting(requestContext));
    if (!providerOptions) return;
    if (!isAnthropicModel(model?.modelId)) return;

    const systemIndex = stableSystemIndex(prompt);
    const targets = chooseBreakpoints(prompt);
    if (targets.length === 0 && systemIndex < 0) return;

    // Copy rather than mutate: the prompt array is the runtime's, and this
    // rewrite is only meant to apply to the current call.
    const next = prompt.map((message, index) => {
      const marked = targets.includes(index) || index === systemIndex;
      if (!marked) return message;

      // A system message carries a plain string rather than content parts.
      if (typeof message.content === 'string') {
        return {
          ...message,
          providerOptions: { ...message.providerOptions, ...providerOptions },
        } as PromptMessage;
      }

      if (!Array.isArray(message.content)) return message;

      const content = [...message.content];
      const last = content[content.length - 1];
      if (!last) return message;

      content[content.length - 1] = {
        ...last,
        providerOptions: { ...last.providerOptions, ...providerOptions },
      };

      return { ...message, content } as PromptMessage;
    });

    if (process.env.KIRA_DEBUG) {
      for (const [index, message] of prompt.entries()) {
        if (message.role !== 'system') continue;
        const text = typeof message.content === 'string' ? message.content : '';
        let hash = 5381;
        for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
        console.log(
          `[cache] system[${index}] ${text.length}ch #${hash.toString(16)}: ${text.slice(0, 40).replace(/\n/g, ' ')}`,
        );
      }
    }

    if (process.env.KIRA_DEBUG) {
      console.log(
        `[cache] breakpoints: system[${systemIndex}] + messages ${targets.join(', ')} of ${prompt.length} (${
          providerOptions.anthropic.cacheControl.ttl ?? '5m'
        })`,
      );
    }

    return { prompt: next };
  },
} satisfies Processor;
