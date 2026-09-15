# Security

Strata v1 is a local development runtime for trusted operators, workspaces,
and extension code. It is **not an OS sandbox**, a multi-tenant service, or a
production-safety guarantee. Do not use it to execute hostile code on a host
whose files, credentials, or network access you need to protect.

## Threat Model

Model responses, repository text, and tool output may be misleading or contain
instructions intended to influence later actions. Schema validation checks
argument structure, not whether an action is appropriate. Review approvals in
the context of the user's task; a valid command can still be destructive or
disclose data.

The trust boundary is the host process and its OS account. Tools, provider
SDKs, extensions, and their dependencies execute with that account's access.
File content and tool results may be sent to the selected model provider.
There is no secret redaction, network allowlist, or automatic containment of
extension imports and activation.

## Controls And Limits

- **Approval:** strict AJV input validation precedes permission checks.
  `PermissionManager` requires approval unless a tool explicitly declares
  `needsPermission: false`. Its default `ask` mode denies when no prompt
  callback is available. `--accept-all` bypasses approvals; an interactive
  `always` choice covers the tool name, not just one command or path.
- **Read-only mode:** the CLI exposes only tools declared read-only and denies
  permission-requiring actions. It does not constrain those implementations.
  Trusted extensions import and activate before this filtering, so
  `--read-only --trust-extensions` is not a restricted extension environment.
- **Workspace files:** built-in `read`, `write`, and `glob` check resolved paths
  against the real workspace. These are not protections against hostile
  concurrent filesystem changes or time-of-check/time-of-use (TOCTOU) races.
  `glob` exclusions such as `.git` and `.strata` limit discovery, not access:
  `read` can still read an explicitly named file in those locations.
- **Shell:** `bash` starts the platform shell at the workspace cwd, with bounded
  captured output and deadlines. It can change directory, access other files,
  use the network, or launch programs with the host account's privileges.
  Starting in a workspace is not filesystem confinement.
- **Cancellation:** aborts and timeouts request cancellation and shell
  process-tree cleanup. Cleanup is best effort; escaped or detached processes
  can survive. In-process extension code can ignore signals or block timers.
  A still-pending tool blocks another query after a short settling grace period;
  this does not terminate its code or undo effects.
- **Budgets:** finite turn, context-byte, output, token, and time limits bound
  normal operation, not arbitrary extension resource consumption. Context bytes
  are not exact tokens. Reported token usage is checked before the next request,
  so one response can overshoot the budget; it is not a hard billing cap.

See [ARCHITECTURE.md](ARCHITECTURE.md) for exact defaults, built-in behavior,
SDK retry defaults, and event/checkpoint ordering. There is no automatic tool
retry, replay, rollback, or history compaction.

## Extensions And Sessions

Only load reviewed local ESM extensions using explicit `--extension DIR` and
`--trust-extensions`. Review dependencies as well as the entry file. Manifest
and entry fingerprints plus canonical roots detect configuration changes;
they are not code signatures or transitive dependency integrity checks.
Activation and cleanup deadlines limit waiting, not execution. Details:
[docs/extensions.md](docs/extensions.md).

Persistence is off unless `--session PATH` is supplied. Snapshots and lock
files request mode `0600`, but this is not a Windows ACL guarantee or
encryption. Use a private directory, restrict OS access, and keep snapshots
out of Git, shared logs, and issue attachments. They can contain prompts,
source code, tool output, or secrets.

Atomic snapshot replacement does not make tool effects transactional. An
unknown-outcome result means an effect may already have happened. Inspect the
workspace and external systems before repeating an action. Never remove a
session lock until its recorded owner is confirmed stopped. Storage and recovery
instructions: [docs/sessions.md](docs/sessions.md).

The CLI retains the lock when an operation remains pending or extension cleanup
fails. A final JSON event is not proof of successful process cleanup; check the
exit status. Terminal display removes control sequences, but raw JSON events
preserve source text for consumers, which must apply their own output policy.

## Operating Precautions

- Use a disposable or externally isolated environment when running commands
  or tools that could affect important data. Keep recoverable backups.
- Grant the host and provider credentials only the access needed for the task.
  Keep secrets outside the workspace when they should not be read by tools.
- Use only trusted provider endpoints. An `OPENAI_BASE_URL` override receives
  credentials and conversation data. Environment files are not autoloaded.
- Prefer the built-in read/glob tool set for inspection. Review tool inputs,
  resulting changes, and possible external effects before continuing after an
  interruption. Do not infer safety from a successful test or a read-only label.

## Reporting

Use [GitHub issues](https://github.com/gnahz-eh/strata/issues) for nonsensitive,
redacted reports. Include the revision, OS/Node version, expected behavior,
and a minimal reproduction that contains no credentials, private source,
session snapshots, or sensitive exploit details.

This document does not designate a private reporting channel or promise a
response time. For a sensitive finding, request a private contact method in
a minimal nonsensitive issue before sharing details; do not publish those
details in the request.