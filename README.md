# kira-code

A coding agent built on [Mastra](https://mastra.ai), inspired by Claude Code. It reads and writes code in a real project directory, runs commands, plans before large changes, tracks its own tasks, and asks for approval before anything destructive.

Two front ends over the same agent, sharing threads and memory: a **terminal CLI** with plan/build/fast modes, and **Mastra Studio**.

## Features

- Works on any project directory you point it at (`KIRA_PROJECT_DIR`)
- Claude Code-style tools: `view`, `find_files`, `search_content`, `edit_file`, `write_file`, `bash`, `lsp_inspect`
- **Modes** (CLI): `plan` investigates and proposes, `build` implements, `fast` answers focused questions on a cheap model
- **Permissions** by category — reads flow, edits and shell commands ask, and you can grant a whole category for the session
- Plan mode: writes a plan to `.kira/plans/`, submits it for approval, and switches to build once you approve
- `explore` subagent: read-only code search, so file dumps stay out of the main context
- Semantic navigation with LSP hover/definitions, plus BM25 keyword search over indexed files
- Persistent task list, conversation memory, working memory, and observational memory
- Reusable skills from `skills/` (the [agentskills.io](https://agentskills.io) format)
- Multi-model: any provider of the [Mastra model router](https://mastra.ai/models), switchable at runtime
- Prompt caching on Anthropic models, with a rolling cache breakpoint that follows the conversation
- Context compaction, automatic on a token threshold and on demand with `/compact`
- Project instructions: `AGENTS.md` is loaded at the start, nested ones when the agent enters their subtree
- Skills from three sources — kira-code's own, yours, and the project's — with `/skills` and `/skill`
- MCP client: external servers' tools, kept out of the prompt until the model asks for them

## Get started

Copy `.env.example` to `.env` and set the API key for the provider you want to use.

**Terminal.** kira-code works on the directory you start it in. Link it once:

```shell
npm link
```

then, from any project:

```shell
cd /path/to/your/repo
kira-code
```

Without linking, `node /path/to/kira-code/bin/kira-code.mjs` from the target directory does the same thing. `npm run cli` also works, but npm runs scripts from the package root, so that one always works on kira-code itself.

Set `KIRA_PROJECT_DIR` to override the working directory regardless of where you launched from.

**Studio:**

```shell
KIRA_PROJECT_DIR=/path/to/your/repo npm run dev
```

Then open [http://localhost:4111](http://localhost:4111) and pick the **kira-code** agent. Studio has no notion of a launch directory, so it uses `KIRA_PROJECT_DIR`, defaulting to this project.

## CLI

```
/mode [plan|build|fast]   show or switch mode
/model <provider/model>   switch the model for the current mode
/perm <category> <policy> read|edit|execute|other × allow|ask|deny
/cache [off|5m|1h]        show or set the Anthropic prompt cache
/perms                    show current permission rules
/new [title]              start a new thread
/threads                  list stored threads
/switch <threadId>        switch to a thread
/context                  how much of the context window the thread occupies
/compact [instructions]   compact the context now, optionally guided
/usage                    token usage for this thread
/abort                    stop the active run
/help                     command list
/exit                     quit
```

When a tool needs approval you get `[y]es / [n]o / [a]lways this category`. `a` grants that category for the rest of the session. When the agent submits a plan, the CLI prints it and asks you to approve or reject with feedback.

Modes only exist in the CLI: they belong to the `AgentController` that hosts the session. Studio talks to the same agent in build mode.

## Models

Nothing is hardcoded. Each role resolves its model at request time and defaults to `anthropic/claude-haiku-4-5`:

| Env var | Role |
| --- | --- |
| `KIRA_MODEL` | the main agent |
| `KIRA_FAST_MODEL` | the CLI's `fast` mode |
| `KIRA_SUBAGENT_MODEL` | `explore` and future subagents |
| `KIRA_MEMORY_MODEL` | observing the conversation, and thread titles |
| `KIRA_REFLECT_MODEL` | condensing the observation log — defaults to `anthropic/claude-sonnet-5` |

Set them to any `provider/model` id — `anthropic/claude-sonnet-5`, `openai/gpt-5-mini`, `google/...`, `xai/...` — as long as the matching API key is set.

At runtime you can override without restarting: `/model` in the CLI (persisted per mode on the thread), or the `model` / `subagentModel` / `memoryModel` / `reflectModel` fields in Studio's **request context** panel.

Verify a model id before using it:

```shell
node .claude/skills/mastra/scripts/provider-registry.mjs --provider anthropic
```

## Prompt caching

Anthropic caching is an exact prefix match, so kira-code keeps the cacheable part of the request byte-identical: the system prompt carries no date, git branch, mode or model. Those arrive in a session-context message, emitted as a Mastra state signal after the cached prefix — as do the mode's own instructions, which is why switching mode no longer rebuilds the cache.

A processor then places up to three **rolling breakpoints** on the conversation, spaced under the API's 20-block lookback limit so a turn with many tool calls doesn't silently lose the previous entry. The markers apply to the outbound request only and are never persisted to the stored messages.

`/cache off|5m|1h` (default `KIRA_CACHE_TTL`, else `5m`). `off` is there to measure the difference: on a two-question thread the second request went from **15,507 uncached tokens to 6**.

Caveat: the minimum cacheable prefix is model-dependent and Haiku 4.5 has the highest — 4096 tokens, against 1024 on Sonnet 5 and 512 on Opus 5. Below it nothing is cached and no error is raised; check `/usage`.

## Project instructions

`AGENTS.md` at the root of the project (or `CLAUDE.md`, or `CONTEXT.md` — first one found) is loaded into the system prompt before the first turn, so a rule like "never run the build directly" arrives before the agent can break it, not after.

It lands as its own system block rather than inside the invariant one: editing the file rebuilds a few hundred tokens instead of the 12,728-character cached prefix. The file is re-read when its mtime or size changes, so an edit takes effect on the next turn without restarting the CLI — measured: the block's hash changed and the agent quoted the new rule.

Nested files are Mastra's `AgentsMDInjector`: when a tool touches a path, it walks up to the nearest instruction file and injects it as a `system-reminder`, once per file. That covers `packages/api/AGENTS.md` applying only inside `packages/api`. Two things are excluded from it — the project's own file, already in the system prompt, and any instruction file *above* the project, which the upward walk would otherwise pull in from your home directory.

Wiring it takes one thing that is invisible when you get it wrong: **the order of the input processors**. The injector reads the step's tool calls from `messageList.get.response`, and the observational-memory processor puts its own `data-om-status` message in that bucket, leaving the tool results in `get.all`. By default Mastra runs every memory processor first — `resolveInputProcessors` returns `[...memoryProcessors, ...configuredProcessors]` — so an injector left in the default position never fires, with no error and no reminder. Measured, same run and same question:

| position | `response` bucket | injected |
| --- | --- | --- |
| after the memory processors (default) | `assistant: data-om-status` | no |
| before them | `assistant: tool-invocation:result, workspace-metadata` | yes |

So `agents/kira-code.ts` lists the memory processors explicitly, after this one. That is the supported way round it: `memory.getInputProcessors()` skips any processor whose id is already configured, so nothing is registered twice. Caching and compaction were re-measured under the new order and are unchanged (`cacheRead 15,689`, `noCache 3`, `/compact` still folds the window down to zero messages).

`KIRA_INSTRUCTIONS=off` disables both halves. Instruction files are executable text from the checkout, and a branch under review is not always trusted.

## Working memory

The one thing that survives between sessions. It is a single markdown document **per project** — the resource is the project directory, not the thread — rewritten through `updateWorkingMemory` and re-sent as a system block on every request.

Left without a template Mastra fills in a user profile (first name, location, interests), which a coding agent never learns and never needs; ours holds what is actually worth carrying: the current task, decisions already settled, environment quirks, and how the user wants to be worked with. The template also asks for pruning, because the instruction Mastra puts above it does the opposite — *"If you're unsure whether to store something, store it"*.

Measured on a filled document: the test command stated in one session was answered from memory in the next, with no file read, and the document stayed at 137 characters over the following turns instead of growing a line per turn.

Updating it does not ask for approval: it is the agent's own state, not a project file, so it sits in the `other` permission category alongside the interactive tools.

`scripts/reset-working-memory.ts` clears the stored documents — needed once after a template change, since existing content keeps being sent until the agent rewrites it.

## Skills

A skill is a folder with a `SKILL.md` — frontmatter (`name`, `description`, optionally `user-invocable`) and instructions the agent follows when the task calls for them. Only name, description and path ride in the prompt; the body is read on demand, so twenty skills cost about as much as one.

Three sources, weakest first:

| source | path | for |
| --- | --- | --- |
| built-in | `<install>/skills`, `KIRA_SKILLS_DIR` | what kira-code ships with |
| global | `~/.kira/skills`, `KIRA_GLOBAL_SKILLS_DIR` | yours, on every project |
| project | `<project>/.kira/skills` | the conventions of that repo |

On a name clash the most specific source wins — a project's `code-review` replaces the built-in one. That arbitration is ours and it is not cosmetic: Mastra sorts candidates by source *type*, and since all three of ours are `local` its tie-break **throws** (`Cannot resolve skill "code-review": multiple local skills found at …`) instead of choosing. `src/mastra/skills.ts` picks the winner first and hands Mastra one path per surviving skill; `/skills` shows what was hidden.

```
/skills                    what is available, and where it comes from
/skill <name> [text]       use one now
```

`/skill` checks the name locally before sending anything, so a typo costs a line of output instead of a model call, and a skill marked `user-invocable: false` is refused.

Project skills are instructions from the checkout, like `AGENTS.md`, so `KIRA_INSTRUCTIONS=off` drops them too — built-in and global ones stay, because those are yours. The two directories outside the project are reachable through `allowedPaths` so `skill_read` can open a skill's reference files; that exception is not read-only, so the agent can also write there, behind the usual `edit` approval.

## MCP

kira-code is an MCP client: servers you configure contribute their tools to the agent. Two sources — `~/.kira/mcp.json` (yours, always active, `KIRA_MCP_CONFIG`) and `<project>/.kira/mcp.json`.

```jsonc
{
  "servers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"],
                "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }, "category": "execute" },
    "docs":   { "url": "https://docs.example.com/mcp",
                "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" }, "category": "read" }
  }
}
```

`${VAR}` is expanded from the environment, so tokens stay out of the file. `category` decides what the server's tools may do without asking — `read` runs freely, `execute` (the default when absent) goes through the approval prompt. Tools are named `serverName_toolName`, which is how a tool inherits its server's category.

**A project's servers do not start until you trust them.** A server definition is a command line, so a checkout that declares one is asking to run a process on your machine — a larger request than an `AGENTS.md` makes. `<project>/.kira/mcp.json` is read, reported at startup and by `/mcp`, and stays inert until `/mcp trust`. Consent is recorded against a hash of the file, so editing it withdraws the consent and it has to be given again.

```
/mcp            servers, source, category, tool count, errors
/mcp trust      enable the ones this project declares
```

The tools reach the model through `search_tools` / `load_tool` rather than sitting in the prompt, and that is a cache decision before it is a token one. In Mastra's `convertTools` the tools resolved for a request are spread *before* the workspace tools — that is, before the cache breakpoint on `mastra_workspace_index` — while tools a processor loads are spread last. Handed over directly, every change of MCP configuration would rewrite the cached prefix; loaded on demand they land behind it. Measured on the same two-turn conversation, with the server configured and without: `cacheRead 15,902` both times, and the same 27 tools in the prefix.

In plan mode only servers declared `read` are searchable — otherwise an MCP server would be the one way left to change something from a plan, since the workspace hook that guards plan mode never sees these tools.

A server that fails to start is reported by `/mcp` and ignored; discovery is lazy, so a session that never needs MCP never connects, and one bad server costs a timeout rather than the CLI. Servers that require an interactive OAuth login are not supported from here — token-based ones work.

## Context compaction

Long threads outgrow the context window. Observational memory folds older messages into an observation log and drops them from the request: the thread continues, the raw history stays in the database, and what the model sees is a summary instead of the transcript.

Two thresholds drive it, both derived from the main model's context window rather than fixed — 30% for messages, 20% for observations, floored at Mastra's 30k/40k and capped at 150k/100k, so 60,000 / 40,000 on Haiku. `KIRA_OBSERVE_TOKENS` and `KIRA_REFLECT_TOKENS` override them.

```
/context                  messages and observations against their thresholds
/compact                  observe now — messages become observations
/compact <instructions>   observe, then rewrite the log with that guidance
```

Measured on a filled thread: 7 messages and 3,834 tokens went to 0 messages and 349 tokens of observations, and the facts stated before the compaction were still answered afterwards without a single file read. A guided `/compact tieni solo le regole di progetto` then took the log from 349 to 116 tokens, dropping the file summaries and keeping the rules — content changed, not only size.

The two steps run on different models on purpose. Observing is frequent and recoverable; a reflection rewrites the whole log at once, so `KIRA_REFLECT_MODEL` defaults to Sonnet 5 while everything else stays on Haiku.

Compaction and caching interact but do not fight: compaction rewrites the messages, which sit *after* the system and tool breakpoints. Measured on the turn right after a `/compact`, the 14,086-token prefix still came from cache; only the rolling message breakpoints move, and since the history shrank, the cache write shrank with it (4,296 → 2,739 tokens).

`observe()` returns early below its own threshold even when called manually, and per-record threshold overrides are ignored below `bufferTokens` — so `/compact` lowers the engine threshold for the duration of the call and restores it right after. That is a private field, and the one thing here that could break on a Mastra upgrade; the automatic cycle would keep working.

## Safety

Filesystem tools are contained to `KIRA_PROJECT_DIR`. `bash` auto-runs a read-only allowlist (`git status/diff/log`, `ls`, `cat`, test and typecheck scripts) and asks for approval on everything else. Edits require reading the file first.

In plan mode the shell is **not exposed at all** — `bash` and the process tools are absent from the toolset, so the agent can't attempt them. The file-mutating tools stay visible (plan mode has to write its own plan) and are gated by a workspace hook with an allowlist: only `write_file` and `edit_file`, only under `.kira/plans/`. Anything else is refused, including tools added later, which are denied by default rather than permitted by omission.

Hiding the shell is cache-safe because the workspace registers the sandbox tools last, so dropping them trims the end of the tool block and leaves the cached prefix in front of it intact. Measured across a `/mode` switch: 7,823 tokens read from cache instead of a full rewrite.

`LocalSandbox` provides no OS-level isolation. Point kira-code at a repo you can afford to have modified, review approvals, and don't expose the dev server unauthenticated.

## Code navigation

`lsp_inspect` returns hover, definitions and implementations. The TypeScript language server ships as a devDependency; servers for other languages are used when they are installed on the machine, and the tool reports plainly when none is available.

`mastra_workspace_search` is BM25 keyword search and only covers what has been indexed with `mastra_workspace_index` — nothing is indexed at startup, so opening a large repo costs nothing.

## Layout

- `bin/kira-code.mjs` — launcher that keeps your cwd as the project directory
- `src/cli.ts` — terminal front end
- `src/cli-bootstrap.ts` — resolves the install root, the env file and the project directory
- `src/mastra/controller.ts` — AgentController: modes, permissions, sessions
- `src/mastra/modes.ts` — mode instructions and tool categories
- `src/mastra/agents/kira-code.ts` — the main agent
- `src/mastra/agents/explore-agent.ts` — the read-only search subagent
- `src/mastra/workspace.ts` — tool names, approval and mode policy, LSP, search
- `src/mastra/models.ts` — model roles, defaults, runtime overrides
- `src/mastra/skills.ts` — the three skill sources, and who wins a name clash
- `src/mastra/mcp.ts` — MCP config, the trust record, discovery and per-server categories
- `src/mastra/memory.ts` — memory instance, observation and reflection models
- `src/mastra/context.ts` — compaction thresholds from the model's context window
- `src/mastra/context-state.ts` — what the thread occupies, as the model sees it
- `src/mastra/prompts/system.ts` — the invariant system prompt plus its cache breakpoint
- `src/mastra/prompts/project-instructions.ts` — the project's AGENTS.md, and what the injector must skip
- `src/mastra/processors/nested-instructions.ts` — AGENTS.md of the subtree being worked on
- `src/mastra/cache.ts` — prompt-cache setting and provider options
- `src/mastra/processors/session-context.ts` — volatile session facts as a state signal
- `src/mastra/processors/prompt-cache.ts` — rolling cache breakpoints
- `src/mastra/config.ts` / `storage.ts` / `controller-context.ts` — paths, shared storage, controller wiring
- `skills/` — reusable skills

## Storage

`mastra.db` at the project root holds memory, tasks, threads and run snapshots — one database for both front ends. Set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` to use Turso instead.

## Learn more

[Mastra documentation](https://mastra.ai/docs/) · [course](https://mastra.ai/learn) · [Discord](https://discord.gg/BTYqqHKUrf)
