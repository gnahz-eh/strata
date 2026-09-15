# Strata

A minimal TypeScript runtime and CLI for AI-assisted development: Anthropic
and OpenAI text/tool streaming, four built-in tools, explicit approvals,
bounded runs, opt-in file sessions, and trusted local extensions.

Strata v1 is for workspaces and extension code you trust. It is not an OS
sandbox or a production-safety guarantee. Read-only tool selection reduces
capability; it does not isolate code or prevent sensitive data reaching a model.

Details: [ARCHITECTURE.md](ARCHITECTURE.md),
[docs/extensions.md](docs/extensions.md), [docs/sessions.md](docs/sessions.md),
and [SECURITY.md](SECURITY.md). Version 0.2.0 migration notes are in
[docs/changes.md](docs/changes.md); delivery criteria are in [docs/V1.md](docs/V1.md).

## Build And Run Locally

Requires Node.js 20+ and npm. Use this checkout of
[gnahz-eh/strata](https://github.com/gnahz-eh/strata). This project is **not
published to npm**; do not install an unrelated package with `npm install strata`.

```sh
npm ci --ignore-scripts
npm run build
node dist/cli/index.js --help
```

Only live model calls need credentials, and only the selected provider's key
is required. Set it in the process environment, for example in PowerShell:

```powershell
$env:ANTHROPIC_API_KEY = "your-api-key"
node dist/cli/index.js --read-only -p "Summarize the TypeScript modules under src/."
```

In a POSIX shell, use `export ANTHROPIC_API_KEY="your-api-key"` instead.
For OpenAI, set `OPENAI_API_KEY` and select `--provider openai`:

```sh
node dist/cli/index.js --provider openai --model gpt-4.1-mini --read-only --json -p "List the source modules."
```

For local source execution, use `npm start -- --read-only -p "Summarize src/."`.
Omit `-p` for the interactive terminal. Non-TTY input requires `-p`; piped
stdin is not used as a prompt. Nothing is saved automatically without `--session`.

## Configuration

| Provider | Default model | Required key |
|---|---|---|
| `anthropic` | `claude-sonnet-4-6` | `ANTHROPIC_API_KEY` |
| `openai` | `gpt-4.1-mini` | `OPENAI_API_KEY` |

CLI precedence is `--provider` > `STRATA_PROVIDER` > `anthropic`, and
`--model` > `STRATA_MODEL` > the selected provider's default. A model name
does not select a provider. Clear a stale `STRATA_MODEL` when switching
providers, or pass a matching model explicitly.

Strata does not autoload environment files. [.env.example](.env.example)
lists the variables. `OPENAI_BASE_URL` can override the OpenAI endpoint;
only use a trusted endpoint because it receives credentials and conversation data.

OpenAI uses **Chat Completions**, not the Responses API. Choose a model that
supports streaming text and function tools on that endpoint. Responses-only
models and image input are not supported by this adapter.

## CLI Options

| Option | Meaning |
|---|---|
| `--provider anthropic\|openai`, `--model MODEL` | Select transport and model |
| `--cwd DIR` | Workspace; relative paths resolve from the launch directory |
| `-p PROMPT`, `--prompt PROMPT` | One-shot execution |
| `--session PATH` | Create or resume a snapshot; relative to the workspace |
| `--json` | JSONL events on stdout; requires `-p` and disables interactive approval |
| `--read-only` | Expose only tools explicitly declaring `needsPermission: false` |
| `--accept-all` | Approve permission-requiring calls; conflicts with `--read-only` |
| `--extension DIR` | Load an explicitly selected local extension; repeatable |
| `--trust-extensions` | Required with `--extension`; grants selected code host access |
| `--max-turns N` | Model calls per prompt; default 20 |
| `--max-context-bytes N` | Serialized context budget; default 256000 bytes |
| `--max-run-tokens N` | Reported input/output token budget; default 100000 |
| `--timeout SECONDS` | Whole-prompt deadline; default 900 |
| `--request-timeout SECONDS` | Model-request deadline; default 120 |
| `--help`, `-h` | Show help without credentials |

Numeric options require positive integers. Context bytes are not an accurate
token count, and history is not automatically compacted. The token budget is
checked before the next request using reported usage, can overshoot by one
response, and is **not a hard billing cap**. See
[ARCHITECTURE.md](ARCHITECTURE.md) for all runtime limits and checkpoint ordering.

Exit codes: `0` for normal completion/help, `1` for execution/configuration,
storage, cleanup, or output errors, `2` for missing credentials/required
noninteractive input, `3` for a runtime budget or incomplete model output,
and `130` for cooperative cancellation. JSON `end` describes the agent loop;
also check the process exit code because later resource cleanup can fail.

## Approval And State

`read` and `glob` do not require approval; `write` and `bash` do. Missing
`needsPermission` defaults to requiring approval. Inputs are validated with
strict AJV schemas before the permission decision, and duplicate tool names
are rejected.

The default `ask` policy needs an injected prompt callback. The CLI provides
one only when stdin and stderr are TTYs and JSON mode is off. Otherwise,
permission-requiring calls are denied unless `--accept-all` is explicit.
An interactive `always` approval covers every later input for that tool name
in the current permission manager, not just the displayed command or path.

`--session .strata/work.session.json` opts into persistence. Reopening with
the same workspace, provider, model, and tool configuration resumes history;
you must submit a new prompt. Interrupted tools are never automatically replayed.
Snapshots may contain prompts, file contents, and secrets; keep them out of Git.

Extensions are local ESM modules loaded only through explicit `--extension`
paths and `--trust-extensions`. They run with host privileges, including during
activation before read-only filtering. They are not sandboxed plugins.

## Library Usage

The public API is exported through [src/index.ts](src/index.ts). Imports are
quiet: they do not construct clients, prompt, or launch the CLI. After
building, an ESM script inside this checkout can use the package's own name:

```typescript
import {
  Agent, Client, PermissionManager, buildSystemPrompt, readTool, globTool,
} from "strata";

const cwd = process.cwd();
const agent = new Agent({
  client: new Client("claude-sonnet-4-6"),
  tools: [readTool, globTool],
  permissions: new PermissionManager("deny"),
  cwd,
  systemPrompt: buildSystemPrompt(cwd),
});

for await (const event of agent.query("Summarize the source modules.")) {
  if (event.kind === "textDelta") process.stdout.write(event.text);
  if (event.kind === "end") process.stdout.write(`\nStopped: ${event.stopReason}\n`);
}
```

This example exposes only read-only built-ins, not a sandbox. `deny` rejects
permission-requiring tools but still allows those marked read-only. Both
provider clients deliver text through `onText`; they do not print. The agent
yields `textDelta`, `assistant`, `toolCall`, `toolResult`, and `end`. Do not
print completed assistant text a second time after rendering its deltas.

`Client` remains the Anthropic client. Use `new OpenAIClient("gpt-4.1-mini")`
or `createClient("openai", "gpt-4.1-mini")` for OpenAI. The
factory defaults to Anthropic; `STRATA_PROVIDER` is a CLI setting. Both
constructors honor `STRATA_MODEL` when no model is passed. Supply
`agent.query(prompt, { signal })` or call `agent.abort()` for cancellation.
History is private; `agent.messages` returns a copy.

After draining or closing a query, inspect `agent.hasPendingOperations` before
releasing a session lock or disposing extensions. `await agent.waitForIdle(signal)`
can wait for cooperative pending work; the optional signal bounds that wait.
If trusted code does not settle, do not start another query or release ownership.
The CLI exits with an error and retains its session lock in this situation.

## Development

| Command | Purpose |
|---|---|
| `npm ci --ignore-scripts` | Install the locked dependencies |
| `npm run typecheck` | Check source, TypeScript tests, and examples without emitting files |
| `npm test` | Run offline tests auto-discovered by [scripts/test.mjs](scripts/test.mjs) |
| `npm run build` | Emit ESM JavaScript, declarations, and source maps into `dist/` |
| `npm run test:package` | Check compiled imports and CLI behavior; run after building |
| `npm run dev` | Restart the source CLI on changes |

[CI](.github/workflows/ci.yml) is configured for Linux and Windows on Node 20
and 24. That configuration is not a claim that the current revision has passed
CI. Keep usage, architecture, session, extension, and security documentation
in step with changes to their owning contracts.

## License

MIT.
