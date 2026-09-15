# File Sessions

Sessions are explicit opt-in persistence, not automatic saving or task replay.
Without `--session PATH`, the CLI keeps history only in memory. Snapshots can
contain prompts, tool inputs, source files, command output, and secrets. Keep
them out of Git and public reports; they are not encrypted or redacted.

## CLI Usage

From the workspace, after the setup in [README.md](../README.md):

```sh
node dist/cli/index.js --read-only --session .strata/work.session.json -p "Summarize src/."
node dist/cli/index.js --read-only --session .strata/work.session.json -p "Which module owns tool approval?"
```

The second command loads the first command's history, then submits a **new**
prompt. It does not rerun an interrupted prompt or tool. Without `-p`, a TTY
session opens the interactive prompt and waits for new input.

`--cwd` selects the workspace. Relative `--session` paths resolve against that
workspace; absolute paths are allowed. The CLI creates missing parent
directories. `.strata/work.session.json` is a suggested location, not an
automatic default. Ensure local ignore rules exclude your session location.

A snapshot must match the canonical workspace path, provider, model, and
`toolsHash`. The CLI hashes the selected tool descriptors and
[extension identities](extensions.md), including canonical extension roots and
manifest/entry fingerprints. Changing providers, models, tool selection (such
as adding `--read-only`), schemas, or extension identity rejects the old session.
Use a new snapshot path for a different configuration; do not edit identity
fields to bypass compatibility checks. Transitive extension dependencies are
not included in the fingerprint.

## Checkpoints And Recovery

The version `1` JSON envelope contains `version`, `identity`, and `messages`.
The maximum snapshot size is **16 MiB**, on both read and write. It stores
conversation history, not permission allowlists or a resumable execution stack.
Runtime turn, token, and time budgets apply to each new query.

Before any tool effect, the agent checkpoints the assistant message together
with placeholder results for all its calls. After each tool finishes, its
actual result is saved before `toolResult` is yielded. Consumer exit and
cancellation therefore retain paired history. On load, an unanswered trailing
tool batch can be repaired with unknown-outcome results; other malformed or
mismatched history is rejected.

An interrupted placeholder means **outcome unknown**. A side effect may have
completed before its result was saved. Inspect files, processes, or external
systems before requesting another action. Strata never automatically replays
tools and cannot provide exactly-once side effects. Checkpoint failures stop
the run; atomic snapshot replacement does not roll back tool effects.

## Storage And Locks

Snapshots use a same-directory temporary file, file sync, and atomic rename.
Parent-directory sync is attempted on POSIX where supported and skipped on
Windows. Snapshot and lock creation request mode `0600`; this is not a Windows
ACL guarantee. Use a private directory and appropriate OS access controls.
Symlink session/lock paths and symlinked parent directories are rejected, but
these checks are not an adversarial filesystem isolation boundary.

An open session owns `PATH.lock`, for example
`.strata/work.session.json.lock`. The lock contains `pid`, `hostname`, and an
owner token. Locks are **never automatically evicted**, including after a crash.

1. Inspect the lock's PID and hostname and identify the owning process.
2. Confirm that owner has stopped, including on the recorded host. File age
   alone or a PID check on a different host is not enough.
3. Only then manually remove the lock and reopen the session. Do not delete a
   lock while its owner may still be running.

If ownership, file replacement, or durability checks fail, stop and inspect
the storage state. A reported save failure after rename may mean the new
snapshot exists but durability is uncertain; close and reopen before continuing.
Do not silently overwrite or discard the snapshot to recover.

The CLI deliberately leaves the lock behind if model, permission, or tool work
is still pending at shutdown, or if extension cleanup fails or times out.
An expired cleanup timer does not stop trusted code. The same manual recovery
rules apply even when the CLI has printed a final assistant message.

## Library Usage

`FileSession` and `SessionIdentity` are exported from the package root. The API
is `FileSession.open(path, { cwd, provider, model, toolsHash })`. Its parent
directory must already exist. Relative API paths resolve from the process
working directory, not `identity.cwd`; use an absolute path to avoid ambiguity.

After building, this example runs as an ESM script in the checkout. It uses
the CLI's hash shape for read/glob with no extensions:

```typescript
import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  Agent, FileSession, PermissionManager, buildSystemPrompt, createClient,
  readTool, globTool,
} from "strata";

const cwd = await realpath(process.cwd());
const path = resolve(cwd, ".strata/work.session.json");
await mkdir(dirname(path), { recursive: true });
const provider = "anthropic";
const model = "claude-sonnet-4-6";
const tools = [readTool, globTool];
const toolsHash = createHash("sha256").update(JSON.stringify({
  apiVersion: 1,
  tools: tools.map(({ name, description, inputSchema, needsPermission }) => ({
    name, description, inputSchema, needsPermission,
  })),
  extensions: [],
})).digest("hex");

const session = await FileSession.open(path, { cwd, provider, model, toolsHash });
let agent: Agent | undefined;
try {
  agent = new Agent({
    client: createClient(provider, model), tools, cwd,
    permissions: new PermissionManager("deny"),
    systemPrompt: buildSystemPrompt(cwd),
    messages: session.messages,
    checkpoint: (messages) => session.save(messages),
  });
  for await (const event of agent.query("Summarize the source modules.")) {
    if (event.kind === "textDelta") process.stdout.write(event.text);
    if (event.kind === "end") process.stdout.write("\n");
  }
} finally {
  if (!agent?.hasPendingOperations) await session.close();
  else throw new Error("Pending work remains; retain the lock and stop the process before recovery.");
}
```

`open()` creates or validates and rewrites the snapshot under its lock.
`session.messages` returns a copy. Await each `save()`; overlapping saves are
rejected. Await `close()` only after all work and extension cleanup have settled.
After draining or closing a query, `agent.waitForIdle(signal)` can wait for
pending cooperative work, but cannot terminate arbitrary JavaScript. Retain
the lock when safe settlement cannot be established.
Embedders are responsible for a meaningful, stable `toolsHash`, including any
extension identities and configuration their application needs to distinguish.

Implementation: [src/sessions/file.ts](../src/sessions/file.ts) and
[src/sessions/snapshot.ts](../src/sessions/snapshot.ts). Execution ordering is
described in [ARCHITECTURE.md](../ARCHITECTURE.md).