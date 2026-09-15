# 0.2.0: V1 Runtime Foundation

This milestone adds reliability boundaries and local extension composition,
not a desktop application or untrusted-code sandbox. The extension manifest
API is version 1; the npm package remains pre-1.0 and is not published.

## Added

- Core-owned text/tool messages, structured text events, and explicit cancellation.
- Strict synchronous tool schema validation, registration checks, finite budgets,
  and bounded failure outputs.
- Private history snapshots and pre-effect checkpoints that preserve paired
  tool results across interruption and consumer exit.
- Opt-in atomic local sessions with ownership locks and unknown-outcome recovery.
- Explicitly trusted local ESM tool extensions with versioned manifests and cleanup.
- Workspace-aware filesystem tools, atomic writes, standard glob patterns,
  and bounded process execution with process-tree cancellation.
- CLI JSONL events, session resume, read-only mode, execution limits, and trust flags.

## Migration From 0.1.0

- Clients no longer print streamed text. Consume `textDelta` events, or supply
  `CompletionOptions.onText` when calling a model client directly.
- `PermissionManager("ask")` without a prompt callback denies mutating calls.
  The CLI injects a callback only for interactive, non-JSON terminals.
- Omitted `needsPermission` requires approval. Only explicit `false` bypasses it.
- `agent.messages` and `agent.tools` return copies; initialize history through
  `AgentOptions.messages` and persist through `checkpoint`.
- File tools reject paths outside the selected workspace and throw on failures.
  Pass `ToolContext` when calling tools directly against a temporary workspace.
- Glob now follows standard recursive matching; read offsets remain zero-based.
- Interrupted effects are not retried automatically. A failed checkpoint blocks
  the runtime until the session is reopened.

## Verification

Offline tests cover stream parsing for both SDKs, input gates, cancellation,
budgets, temporary filesystem operations, session corruption/lock ownership,
extension lifecycle, and compiled CLI requests against loopback fixtures.
See [V1.md](V1.md) for release criteria and [../SECURITY.md](../SECURITY.md)
for limitations. Passing checks is not a guarantee against adversarial code.