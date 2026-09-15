# Strata Architecture

Strata v1 is a TypeScript runtime and CLI for a single agent using text and
tools. It keeps transport, execution, approval, persistence, extensions, and
presentation separate. It is intended for trusted local execution, not as an
isolation boundary for hostile code. See [README.md](README.md) for usage.

Related guides: [SECURITY.md](SECURITY.md),
[docs/extensions.md](docs/extensions.md), and [docs/sessions.md](docs/sessions.md).

## Ownership

| Owner | Responsibility |
|---|---|
| [src/core/client.ts](src/core/client.ts) | Provider-neutral text/tool messages and `ModelClient` |
| [src/core/agent.ts](src/core/agent.ts) | Private history, schema validation, budgets, serial tool execution, checkpoints, events |
| [src/core/history.ts](src/core/history.ts) | History validation and interrupted-result representation |
| [src/core/abort.ts](src/core/abort.ts), [src/core/stream.ts](src/core/stream.ts) | Deadlines, cancellation, and callback-to-event streaming |
| [src/core/tool.ts](src/core/tool.ts), [src/core/permissions.ts](src/core/permissions.ts) | Tool and approval contracts |
| [src/providers/index.ts](src/providers/index.ts) | Provider selection; adapters own SDK and wire-format conversion |
| [src/permissions/manager.ts](src/permissions/manager.ts) | Approval modes and tool-name allowlist, with an injected prompt callback |
| [src/tools/index.ts](src/tools/index.ts) | Built-in `read`, `write`, `glob`, and `bash` tools |
| [src/extensions/index.ts](src/extensions/index.ts) | Explicit trusted-local extension loading and tool registration |
| [src/sessions/index.ts](src/sessions/index.ts) | Opt-in file-session lifecycle |
| [src/cli/main.ts](src/cli/main.ts), [src/cli/render.ts](src/cli/render.ts) | Composition, terminal interaction, and text/JSON rendering |
| [src/index.ts](src/index.ts) | Public library exports |

Core code depends on its contracts, not the CLI, concrete providers, extension
loader, or session store. Message types are defined in core with no Anthropic
import. The familiar `tool_use`/`tool_result` names are an internal text/tool
protocol; adapters translate it to their provider's wire format.

## Model Boundary

`ModelClient` completes a request with a structured `Message` and may deliver
incremental text through the optional callback:

```typescript
complete(
  messages: MessageParam[],
  system: string,
  tools: Tool[],
  options?: { signal?: AbortSignal; onText?: (delta: string) => void },
): Promise<Message>;
```

`Agent.query()` exposes `textDelta`, `assistant`, `toolCall`, `toolResult`, and
`end` events. Consumers own presentation. A completed `assistant` includes
the text already streamed as deltas; rendering both duplicates that text.

## Adapters And Presentation

[Client](src/providers/anthropic.ts) remains the Anthropic Messages adapter;
[OpenAIClient](src/providers/openai.ts) uses Chat Completions, not Responses.
Both return core messages and deliver text through `onText`, without printing.
Public library imports are quiet. The CLI's `createRenderer` owns text and
JSONL rendering, including completed-text fallback for clients without deltas.

Both SDK clients default to `maxRetries: 2`: up to two retries after the initial
request for eligible failures, not a two-attempt ceiling. Library constructor
SDK options can override this setting. There is no automatic provider fallback
or application-level tool retry.

`PermissionManager` has no terminal dependency. It implements `ask`, `accept`,
and `deny` using an optional injected prompt callback; `ask` fails closed without
one. Only explicit `needsPermission: false` bypasses its approval requirement.
The CLI supplies terminal interaction and filters the read-only tool set.

## Built-In Tools

| Tool | Approval | Behavior |
|---|---|---|
| [read](src/tools/read.ts) | No | Regular files, strict UTF-8, at most 1 MiB before paging; zero-based offset, up to 2000 lines with one-based labels |
| [write](src/tools/write.ts) | Yes | Full-file replacement with a same-directory temporary file and atomic rename; creates parents and rejects a symlink target |
| [glob](src/tools/glob.ts) | No | `fast-glob` patterns including recursive `**`, files only, up to 200 results, no symlink traversal; skips dependency/generated directories, `.git`, and `.strata` |
| [bash](src/tools/bash.ts) | Yes | `cmd.exe` on Windows, `/bin/bash` elsewhere; workspace cwd, bounded combined output, default 60-second tool input timeout, maximum 120 seconds |

File tools check paths against the real workspace via
[src/tools/shared.ts](src/tools/shared.ts). Shell commands and trusted extension
code are not confined by these checks. Cancellation attempts shell process-tree
cleanup; detached or escaped processes may survive. Output is byte-bounded,
but neither path checks nor timers are adversarial isolation.

## Execution And Checkpoints

1. Reject concurrent queries, empty prompts, and invalid configuration. Append
   the user prompt to private history and invoke the optional checkpoint.
2. Before each model call, check turn, serialized-context-byte, and reported
   token budgets. Apply request and whole-run deadlines while streaming text.
3. Validate the completed response and account for its reported token usage.
   Append the assistant message and one following user message containing a
   placeholder result for every tool call. Checkpoint this paired history
   **before** yielding `assistant` or allowing tool effects.
4. If the batch exceeds its call limit, record errors for all calls and execute
   none. Otherwise, process calls serially: yield `toolCall`, validate input,
   request permission, and run the tool with workspace, signal, and output budget.
5. Replace each placeholder with the actual result and checkpoint **before**
   yielding its `toolResult`. Unknown tools, invalid inputs, denials, and tool
   failures produce error results. Invalid inputs never reach the approval gate.
6. Continue with the paired history, or emit `end` for completion or a runtime
   limit. Non-tool stop reasons, including `max_tokens`, do not trigger automatic
   recovery. Provider, protocol, or checkpoint failures may throw instead of
   emitting a normal `end` event.

AJV compiles synchronous schemas in strict mode at registration. Duplicate tool names are
rejected; input validation does not coerce types or fill defaults. The agent
copies registered schemas and exposes copies through `tools` and `messages`;
callers cannot mutate its history through those accessors.

The placeholder means **outcome unknown**, not that a tool definitely did or
did not run. Consumer exit and cancellation retain tool-call/result pairing.
Neither paired history nor atomic snapshot replacement makes an external side
effect transactional: a process can stop after an effect but before its result
is saved. No tool is automatically replayed or retried. Inspect uncertain
effects before submitting another prompt.

Checkpoints receive history copies. Without a checkpoint callback, history is
memory-only. The session store owns disk writes and locks; the core pins its
workspace via realpath but does not choose a persistence backend. A checkpoint
failure blocks subsequent queries until the session is reopened. Required
checkpoints finish before the terminal event; there is no save after `end`.

## Default Limits

These are the exported `DEFAULT_LIMITS` in [src/core/agent.ts](src/core/agent.ts).
Library callers can override them through `AgentOptions.limits`; values must
be positive safe integers no greater than 2147483647, and the tool-output
budget must be at least 128 bytes. Unknown limit names are rejected, including
when callers use plain JavaScript rather than TypeScript.

| Setting | Default | Scope |
|---|---|---|
| `maxTurns` | 20 | Model calls per query |
| `maxContextBytes` | 256000 | Serialized system prompt, history, and tool descriptors; also bounds responses |
| `maxToolOutputBytes` | 30000 | Retained output per tool result |
| `maxToolCallsPerTurn` | 16 | Calls in one assistant response |
| `maxRunTokens` | 100000 | Reported input plus output tokens per query |
| `requestTimeoutMs` | 120000 | One model request |
| `toolTimeoutMs` | 120000 | Approval and execution for one tool call |
| `runTimeoutMs` | 900000 | Whole query |

The context limit measures bytes, not a model's actual token window. There is
no automatic compaction. Token accounting uses provider-reported usage and
checks the total before the next model call, so it can overshoot by one
response. It is not a hard billing cap and does not account for all possible
provider-side work or retries.

## Cancellation And Trust

Use `agent.abort()` or `agent.query(prompt, { signal })` to request cancellation.
Signals propagate to model requests, approval, and tools. Deadlines bound
cooperative work; they cannot terminate arbitrary JavaScript or prevent it
from blocking the event loop.

A tool still running after cancellation gets up to a two-second settling
grace period. Pending model, permission, and tool promises are tracked; new
queries are refused until they settle. After draining or closing the query,
embedders can inspect `hasPendingOperations` and call `waitForIdle(signal)`.
The CLI retains its session lock and does not dispose extensions concurrently
with pending code. Extension cleanup failure also retains the lock. Verify
process termination before manual recovery. Cancellation and timeouts are not
rollback, and callers must inspect possible side effects before continuing.

The CLI drains stdout/stderr, records output failures as nonzero exit status,
and permits normal Node shutdown. An unreferenced two-second fallback exit
handles leftover trusted-code handles after draining; it does not release an
uncertain session lock or promise that detached child processes were stopped.

Permission policy is separate from execution isolation. Filesystem checks,
bounded output, and process cleanup reduce operational risk but do not form an
OS sandbox. Extensions and custom tools are trusted code with host privileges.
The v1 scope does not include automatic compaction, tool replay, parallel tool
execution, remote extension distribution, or model fallback.
