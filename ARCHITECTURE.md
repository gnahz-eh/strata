# Strata architecture

A walkthrough designed to be read alongside the source. Each section maps a
Strata concept back to its full-fat equivalent in claude-code, so you
can use this repo as a launchpad into the real codebase.

The implementation is TypeScript-only. References to claude-code below are
conceptual reading pointers, not verified paths for its current version.

## Repository boundaries

| Location | Responsibility |
|---|---|
| [src/core/agent.ts](src/core/agent.ts) | Conversation state, loop, and lifecycle events |
| [src/core/client.ts](src/core/client.ts) | `ModelClient` contract and message types |
| [src/core/permissions.ts](src/core/permissions.ts) | `PermissionPolicy` and decision contracts |
| [src/core/tool.ts](src/core/tool.ts) | Tool definition and object input schema type |
| [src/providers/anthropic.ts](src/providers/anthropic.ts) | Anthropic transport, streaming, and wire schema conversion |
| [src/providers/openai.ts](src/providers/openai.ts) | OpenAI Chat Completions streaming and message/tool conversion |
| [src/providers/index.ts](src/providers/index.ts) | Provider registry, defaults, key names, and client factory |
| [src/permissions/manager.ts](src/permissions/manager.ts) | Approval modes, terminal prompts, and session allowlist |
| [src/context/system-prompt.ts](src/context/system-prompt.ts) | System prompt construction |
| [src/tools/index.ts](src/tools/index.ts) | Built-in tools and registration |
| [src/cli/main.ts](src/cli/main.ts) | Compose concrete dependencies and run the CLI |
| [src/index.ts](src/index.ts) | Public library exports without starting the CLI |

The core depends on interfaces, not the concrete provider clients or terminal
permission manager. Adapters and tools depend on core contracts. The CLI
assembles these implementations; core modules never import the CLI or the
public barrel. The shared message types still use Anthropic's protocol types.
The OpenAI adapter translates to and from that shape, keeping the agent loop
unchanged. Supporting two providers does not yet make the shared message
schema provider-neutral.

## 1. The shape of an agent

An LLM agent is a `while` loop that alternates between two things:

1. Ask the model for the next action.
2. Take that action (run a tool), then go back to step 1.

It stops whenever `stop_reason !== "tool_use"`. This includes normal
`end_turn` completion, but also output limits such as `max_tokens`; the
current loop does not automatically recover from those limits.

That's the whole idea. Every line in Strata exists to support that loop,
and every "advanced" feature in claude-code (compaction, sub-agents, caching,
recovery, hooks) is an optimization or robustness layer wrapped around the
same loop.

## 2. The async-generator pattern

`Agent.query()` is an `async function*`. It `yield`s a stream of events
(`assistant`, `toolCall`, `toolResult`, `end`). The REPL consumes those
events with `for await (const event of agent.query(...))` and renders them.

```
user input ──► Agent.query() ──► events ──► REPL renders
                  │
                  ▼
              messages[] (mutated in place)
```

Why generators? Three reasons:

1. **Streaming UI**. The renderer shows progress as the agent works,
   instead of a blank screen until everything is done.
2. **Consumer control**. The consumer can stop requesting events. This
  alone does not cancel model requests or subprocesses, and stopping
  between tool events can leave incomplete history.
3. **Composability**. The same generator can be piped into a CLI, a web
   UI, an SDK, or another agent (claude-code's sub-agent tool literally
   instantiates a second `QueryEngine` and forwards its events).

Claude-code: `src/QueryEngine.ts:submitMessage()` returns
`AsyncGenerator<SDKMessage>`. Same idea, more event types.

Text deltas are currently printed directly by each provider adapter, not
yielded by `Agent.query()`. The generator exposes completed assistant messages
and tool lifecycle events. Replacing the default client is necessary for
fully custom streaming output until a text-event contract is added.

## 3. The Tool contract

Defined in [src/core/tool.ts](src/core/tool.ts).

A tool is a record: a JSON-schema for its inputs, a description for the
model, and an `async` function that takes the parsed input and returns a
string. Each provider request includes descriptors for the registered tools.

```typescript
import { readFile } from "node:fs/promises";
import type { Tool } from "strata";

interface ReadInput {
  path: string;
}

export const readTool: Tool = {
  name: "read",
  description: "Read a text file before changing it.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
  needsPermission: false,
  run: async (input: ReadInput) => readFile(input.path, "utf8"),
};
```

The current `Tool` interface is not generic. Implementations can type their
own input, but the registry erases it to `any`. `ToolInputSchema` requires
`type: "object"` so the descriptor matches the Anthropic SDK's input schema
contract. Neither TypeScript annotations nor this schema validate model
arguments at runtime; that remains a separate hardening task.

That's literally it. Claude-code's `Tool` interface adds: input validation,
permission previews, side-effect classification, concurrency safety,
streaming progress, custom render components, idempotency hints. Useful at
scale, irrelevant for learning the loop.

## 4. The loop

Implemented in [src/core/agent.ts](src/core/agent.ts), using the injected
`ModelClient` and `PermissionPolicy` contracts.

The whole loop, annotated:

```typescript
async *query(userInput: string): AsyncGenerator<Event> {
  this.messages.push({ role: "user", content: userInput });

  while (true) {
    // 1. Model call through the injected client; returns the final Message.
    const response = await this.client.complete(this.messages, this.systemPrompt, this.tools);
    this.messages.push({ role: "assistant", content: response.content });
    yield { kind: "assistant", message: response };

    // 2. Stop?
    if (response.stop_reason !== "tool_use") {
      yield { kind: "end", stopReason: response.stop_reason };
      return;
    }

    // 3. Run each tool_use block: permission check → run → record result.
    const toolResults: ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      yield { kind: "toolCall", name: block.name, input: block.input, toolUseId: block.id };

      const { output, isError } = await this.runOne(block.name, block.input);
      yield { kind: "toolResult", toolUseId: block.id, name: block.name, output, isError };

      toolResults.push({ type: "tool_result", tool_use_id: block.id, content: output, is_error: isError });
    }

    // 4. Feed results back as the next user turn, loop.
    this.messages.push({ role: "user", content: toolResults });
  }
}
```

The **protocol contract**: every `tool_use` block in an assistant message
*must* be answered by a matching `tool_result` block in the next user
message — and they go together in a single user turn, not one per turn.
Forget this and the API rejects your next request with a 400.

This is the internal history format and the Anthropic wire format. OpenAI's
wire format differs: the adapter emits one assistant `tool_calls` array and
one `role: "tool"` message per result, preserving the matching call IDs.

Compare with `src/query.ts:queryLoop()` (~1700 lines). The extra mass is:

| Concern | Where in claude-code |
|---|---|
| 4-phase compaction (snip / microcompact / collapse / autocompact) | `query.ts:453-543`, `services/compact/` |
| Recovery branches (PTL, max-tokens, fallback model, abort) | `query.ts:1062-1256` |
| Cache-control marker stability | `services/api/claude.ts:3078-3181` |
| Tool-call concurrency partitioning | `services/tools/toolOrchestration.ts:91-116` |
| Stop hooks | `query.ts:1267-1306`, `query/stopHooks.ts` |
| Token budget enforcement | `query.ts:1308-1355` |
| Memory prefetch | `query.ts:1599-1614` |
| Cost accounting | `cost-tracker.ts` |

Strata does not implement those layers. Small tasks can still encounter
these failure modes; the simpler loop is not a reliability guarantee.

## 5. The permission gate

The policy contract lives in [src/core/permissions.ts](src/core/permissions.ts).
The default interactive implementation is [src/permissions/manager.ts](src/permissions/manager.ts).

Tools that mutate the world (`bash`, `write`) have `needsPermission: true`.
Read-only tools (`read`, `glob`) don't. In `ask` mode the user is prompted
for each mutating call with `[y]es / [n]o / [a]lways`; `always` adds the
tool name to a session-level allowlist.

`accept` approves permission-requiring tools without prompting; `deny` rejects
them. Read-only tools bypass both modes. A custom tool that omits
`needsPermission` also bypasses the gate. Approval is not a filesystem or
process sandbox, and an `always` decision applies to every later input for
the same tool name within that manager.

Claude-code: `src/hooks/toolPermission/` — a 4-way race between the user
(`interactiveHandler.ts:233-530`), configured hooks
(`utils/hooks.ts:executePermissionRequestHooks`), the bridge (for IDE/remote
sessions), and an LLM classifier. Winners are claimed atomically with
`claim()`. The rule grammar (`Bash(npm:*)`, `Read(/etc/**)`) lives in
`utils/permissions/PermissionRule.ts`.

The educational takeaway: permissions are a *policy decision before the
side effect*. Make it explicit, make it cancelable, make it logged.

## 6. The system prompt

Built by [src/context/system-prompt.ts](src/context/system-prompt.ts).

Just cwd + platform + date. Claude-code's `context.ts` also pulls in
`CLAUDE.md`, git status, directory tree, ambient memories, model-specific
instructions, and assembles them into stable cache buckets so cache hits
survive across turns. None of that matters for learning the loop.

## 7. The API clients

[src/providers/anthropic.ts](src/providers/anthropic.ts) implements
`ModelClient`. It owns the `toApiSchema()` conversion; the core tool
contract contains no transport code.

We use `client.messages.stream()`, attach a `text` listener to print live,
then `await stream.finalMessage()` for the structured response. That's
enough to feel responsive.

[src/providers/openai.ts](src/providers/openai.ts) also implements
`ModelClient`, using the official OpenAI SDK's
`chat.completions.stream()` and `finalChatCompletion()`. The SDK assembles
fragmented tool arguments before the adapter converts the final response.
It does not execute tools; permissions and execution remain in the agent loop.

The OpenAI mapping is explicit:

| Shared/internal format | OpenAI Chat Completions format |
|---|---|
| Separate system prompt | First `system` message |
| Assistant text and `tool_use` blocks | Assistant `content` and function `tool_calls` |
| Batched user `tool_result` blocks | Individual `tool` messages with `tool_call_id` |
| Tool result with `is_error: true` | Text prefixed with `Tool error:` |
| `tool_use` stop reason | Normalized from `tool_calls` |
| `max_tokens` stop reason | Normalized from `length`; partial tool calls are not executed |
| `end_turn` stop reason | Normalized from `stop` |

OpenAI tool descriptors use `strict: false` to retain optional arguments in
the existing schemas. Completed function arguments are parsed as JSON objects;
malformed JSON and non-object inputs fail before tool execution. This is not
full schema validation. Refusals are surfaced as text; filtered responses and
SDK request errors propagate as errors. Text and function calls are supported;
image blocks and other unsupported content are rejected explicitly.

[src/providers/index.ts](src/providers/index.ts) supplies provider-specific
defaults and credential variable names. CLI precedence is explicit flag,
then `STRATA_PROVIDER` / `STRATA_MODEL`, then built-in defaults.
Anthropic remains the default, and only the selected provider's key is
required. Library users can instantiate `Client` (Anthropic), `OpenAIClient`,
or call `createClient(provider, model)`. Both adapters return the same core
message shape and keep text streaming as stdout side effects.

What we don't do:

- **Cache control**. Claude-code places `cache_control` markers on the
  system prompt, tools, and the last few messages, then very carefully
  *doesn't* move them across turns — moving a marker invalidates
  downstream cache.
- **Retry**. We don't handle 429s, 529s, or transient network errors. The
  SDK handles some retries; production code should add explicit backoff.
- **Fallback model**. Claude-code can demote Opus → Sonnet → Haiku if the
  primary is overloaded, taking care not to mix sign-required model
  signatures.
- **Additional provider/auth modes**. The current adapters cover Anthropic
  Messages and OpenAI Chat Completions. There is no dedicated Responses,
  Bedrock, Foundry, or OAuth adapter, and no automatic provider fallback.

## 8. Adding a tool

[src/tools/glob.ts](src/tools/glob.ts) is a reference. Four steps:

1. Define your input type and an `async function run(input): Promise<string>`.
2. Export a `Tool` literal with `name`, `description`,
   `inputSchema`, `needsPermission`, and `run`.
3. Add it to [src/tools/index.ts](src/tools/index.ts) so it ends up in `ALL_TOOLS`.
4. Add a focused test under `tests/` and include it in the `test` script.

The model only knows what your `description` tells it. Be concrete about
*when* to use the tool, not just what it does — that's where the model's
selection accuracy actually comes from.

## 9. What's still missing for production

The repository now has separate modules, library exports, a dependency
lockfile, offline tests, and CI. These provide a development foundation,
not production safety by themselves. Runtime argument validation and a
sandbox or other explicit execution boundary are still missing.

If you wanted to evolve this into a real product, the next features I'd
add in order:

1. **Cancellation propagation** — Ctrl-C should kill in-flight subprocesses,
   not just the loop. Pass an `AbortSignal` through to tools.
2. **Retry with backoff** — wrap `client.complete()` with exponential retry
   on 429/529/network.
3. **Context window guard** — track token usage, summarize old turns when
   you cross a threshold. That's "microcompact" in claude-code.
4. **Tool concurrency** — when the model emits N read-only tool calls in
   one turn, run them in parallel (claude-code caps at 10).
5. **Persistent sessions** — serialize `agent.messages` to disk so the
   user can resume.
6. **Sub-agents** — a tool that spawns another `Agent` with a focused
   system prompt. A handful of lines, enormous capability gain.
7. **MCP** — really just "tools, but loaded from an external server". The
   tool interface doesn't change; the loader does.

Keep these changes at their owning boundaries and test interrupted and
failed paths as well as successful ones. In particular, cancellation must
preserve tool-use/result pairing, and a tool returning an error-looking
string is currently still treated as successful unless it throws.

## 10. Reading order

If you're new here, read in this order:

1. [src/core/tool.ts](src/core/tool.ts) and [src/core/client.ts](src/core/client.ts)
2. [src/core/agent.ts](src/core/agent.ts) and [tests/core/agent.test.ts](tests/core/agent.test.ts)
3. [src/providers/anthropic.ts](src/providers/anthropic.ts), then [src/providers/openai.ts](src/providers/openai.ts)
4. [src/permissions/manager.ts](src/permissions/manager.ts)
5. [src/tools/read.ts](src/tools/read.ts), then [src/tools/bash.ts](src/tools/bash.ts)
6. [src/cli/main.ts](src/cli/main.ts) and [src/index.ts](src/index.ts)

Then open `claude-code/src/query.ts` and you'll recognize every concept,
just bigger.

## 11. Build and package boundaries

[package.json](package.json) exposes `dist/index.js` and its declarations as
the library API. The `strata` executable points to `dist/cli/index.js`.
Only the CLI bootstrap invokes `main()` and exits the process. Library imports
do not create either provider client or start a terminal session.

[tsconfig.json](tsconfig.json) builds only `src/`, using Node ESM resolution
and explicit `.js` import specifiers. [tsconfig.test.json](tsconfig.test.json)
checks source, TypeScript tests, and examples without adding them to the
published output. `npm test` runs the offline regressions; after
`npm run build`, `npm run test:package` verifies compiled library imports,
CLI help, provider-specific credential handling, and a compiled OpenAI CLI
request against a local HTTP fixture without live model calls.

Both built-in providers write streamed text to stdout, and the default
permission manager uses terminal input in `ask` mode. Applications with a
different UI should supply their own `ModelClient` and `PermissionPolicy`.
