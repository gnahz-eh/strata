# Strata

A modular TypeScript runtime and CLI for AI-assisted development. Strata
combines an async-generator loop, four tools, a permission gate, and Anthropic
and OpenAI streaming clients, with separate library and command-line entry points.

The project is evolving toward an extension-based runtime. An extension host
is not implemented yet.

The directory layout supports testing and further development; it does not
make the runtime production-hardened. See [Runtime limitations](#runtime-limitations)
before running it against important files.

## Project layout

```text
src/
  index.ts                  Public library exports; does not start the CLI
  core/
    agent.ts                Agent loop and events
    client.ts               Model client contract and message types
    permissions.ts          Permission policy contract
    tool.ts                 Tool contract and input schema type
  providers/
    index.ts                Provider registry, defaults, and client factory
    anthropic.ts            Anthropic SDK adapter and wire schema conversion
    openai.ts               OpenAI Chat Completions adapter and protocol conversion
  permissions/
    manager.ts              Approval modes, terminal prompt, session allowlist
  context/
    system-prompt.ts        System prompt construction
  tools/
    index.ts                Built-in tool registry
    bash.ts                 Shell execution
    read.ts                 Line-numbered file reading
    write.ts                Full-file writes
    glob.ts                 File discovery
  cli/
    index.ts                Executable bootstrap and process exit handling
    main.ts                 Composition and interactive/one-shot execution
    args.ts                 Command-line parsing
    render.ts               Terminal event rendering
tests/
  core/                     Agent protocol regression tests
  cli/                      Argument parsing tests
  permissions/              Permission policy tests
  providers/                Protocol conversion and offline streaming tests
  tools/                    Built-in tool tests using temporary directories
  package.test.mjs          Compiled package and CLI smoke tests
examples/
  oneShot.ts                Source-level embedding example
.github/workflows/ci.yml     Linux/Windows checks on Node 20 and 24
```

Start reading at [src/core/agent.ts](src/core/agent.ts). The dependency rules
and execution sequence are explained in [ARCHITECTURE.md](ARCHITECTURE.md).

## Install and run

Requires Node.js 20+ and npm. Only the selected provider's API key is needed
for live model calls. Help, tests, and builds do not require real credentials.
Anthropic remains the default provider.

PowerShell:

```powershell
npm ci --ignore-scripts
$env:ANTHROPIC_API_KEY = "your-api-key"
npm start
```

macOS/Linux:

```bash
npm ci --ignore-scripts
export ANTHROPIC_API_KEY="your-api-key"
npm start
```

One-shot mode and help:

```bash
npm start -- -p "List the TypeScript files under src/ and summarize each module."
npm start -- --help
```

### OpenAI

In PowerShell:

```powershell
$env:OPENAI_API_KEY = "your-openai-api-key"
npm start -- --provider openai --model gpt-4.1-mini
```

In macOS/Linux shells:

```bash
export OPENAI_API_KEY="your-openai-api-key"
npm start -- --provider openai --model gpt-4.1-mini
```

One-shot mode:

```bash
npm start -- --provider openai -p "List the TypeScript files under src/."
```

The OpenAI adapter uses **Chat Completions**, including streamed text and
function tool calls. Select a model that supports both on that endpoint and
is available to your account. Responses-only models are not supported by
this adapter. Current message conversion supports text and function tools;
unsupported content such as images is rejected rather than silently omitted.

### Provider configuration

| Provider | Default model | Required key |
|---|---|---|
| `anthropic` | `claude-sonnet-4-6` | `ANTHROPIC_API_KEY` |
| `openai` | `gpt-4.1-mini` | `OPENAI_API_KEY` |

Provider selection: `--provider` overrides `STRATA_PROVIDER`, which
defaults to `anthropic`. Model selection: `--model` overrides
`STRATA_MODEL`, which otherwise falls back to the provider's default.
There is no provider inference from a model name. When switching providers,
unset an old `STRATA_MODEL` value or select a matching model explicitly.

To run the compiled CLI:

```bash
npm run build
node dist/cli/index.js --help
```

`--model MODEL` overrides the model. `--accept-all` skips tool approval;
use it only in an appropriately isolated, trusted environment. It does not
enable a sandbox.

| Environment variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Required only when using Anthropic |
| `OPENAI_API_KEY` | Required only when using OpenAI |
| `STRATA_PROVIDER` | Default provider: `anthropic` or `openai` |
| `STRATA_MODEL` | Optional model override for the selected provider |
| `OPENAI_BASE_URL` | Optional OpenAI API endpoint override; credentials and conversation data are sent to this endpoint, so only use one you trust |

[.env.example](.env.example) documents the variables. The application does
not automatically load environment files; set the variables in your shell
or provide them through your process manager.

## Library usage

The package root exports the public API. Importing it does not create a
client, read terminal input, or launch the REPL. Build first when using the
package by name from this repository.

```typescript
import {
  Agent, Client, PermissionManager, buildSystemPrompt, readTool, globTool,
} from "strata";

const agent = new Agent({
  client: new Client(),
  tools: [readTool, globTool],
  permissions: new PermissionManager("deny"),
  systemPrompt: buildSystemPrompt(),
});

for await (const event of agent.query("Summarize the source modules.")) {
  console.log(event.kind);
}
```

`deny` rejects permission-requiring tools; read-only tools still run.
`Client` continues to represent Anthropic. To use OpenAI, import
`OpenAIClient` and pass `new OpenAIClient("gpt-4.1-mini")` instead, or use
the exported `createClient("openai", "gpt-4.1-mini")` factory. The factory
defaults to Anthropic when no provider is supplied; `STRATA_PROVIDER`
is a CLI setting. Both client constructors honor `STRATA_MODEL` when
no explicit model is passed. Exported model constants represent the built-in
defaults, not environment overrides.

Both built-in clients currently print streamed text to stdout.
For custom transport or output handling, inject a `ModelClient` implementation.
See [examples/oneShot.ts](examples/oneShot.ts) for source-level usage.

## Development

| Command | Purpose |
|---|---|
| `npm run dev` | Restart the CLI when source changes |
| `npm run typecheck` | Check source, TypeScript tests, and examples without emitting files |
| `npm test` | Run offline unit and tool regression tests |
| `npm run build` | Emit Node ESM JavaScript, declarations, and source maps into `dist/` |
| `npm run test:package` | Check compiled imports and CLI behavior; run after building |
| `npm pack --dry-run` | Build and inspect the npm package contents without publishing |

Dependencies are recorded in [package-lock.json](package-lock.json).
[CI](.github/workflows/ci.yml) runs type checking, tests, builds, and package
smoke tests on Linux and Windows. Tests use fake model responses, dummy keys,
and a loopback HTTP fixture; no live model APIs are called. Filesystem tests
clean up their temporary directories.

## Adding a tool

1. Add an implementation under `src/tools/` using the `Tool` contract from [src/core/tool.ts](src/core/tool.ts).
2. Define its description, object input schema, `needsPermission`, and async `run` function.
3. Register it in [src/tools/index.ts](src/tools/index.ts).
4. Add focused coverage under `tests/` and include the test file in the `test` script.

Tool schemas describe model inputs; they are not runtime validators.
Set `needsPermission: true` for side-effecting tools. Custom tools that omit
this flag currently bypass the permission prompt.

## Runtime limitations

- No full runtime tool-schema validation, filesystem sandbox, or process isolation.
- No end-to-end cancellation or interrupted-conversation repair.
- Conversation history is memory-only and unbounded; no persistence or compaction.
- No application-level retry/recovery or model fallback beyond SDK behavior.
- Tools execute serially, and the glob matcher implements only a limited subset.

These are runtime concerns to address separately from the repository layout.
See [ARCHITECTURE.md](ARCHITECTURE.md) for the detailed behavior and next steps.

## License

MIT.
