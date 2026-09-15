# Trusted Local Extensions

Extensions add tools to Strata v1. They are explicitly selected local modules,
not a marketplace, remote plugin service, or sandbox. Importing an extension
and running its activation code grants it the privileges of the Strata process,
including filesystem, network, environment, and subprocess access.

## Run The Example

From the repository root, after installing dependencies, building, and setting
the selected provider's key as described in [README.md](../README.md):

```sh
node dist/cli/index.js --read-only --extension examples/extensions/project-info --trust-extensions -p "Use project_info to report the workspace and platform."
```

The [example implementation](../examples/extensions/project-info/index.mjs)
registers the read-only tool `project_info`, which returns the workspace path
and operating-system platform. Repeat `--extension DIR` to select additional
directories. Relative directories resolve against `--cwd`, not necessarily the
directory from which the CLI was launched. There is no automatic discovery or
dependency installation.

`--trust-extensions` is required even with `--read-only`. Import and activation
happen before read-only tool filtering. A tool declaring itself read-only is a
trust assertion by its author, not a restriction enforced on extension code.

## Manifest And Entry

Each directory contains a `strata-extension.json` manifest. The
[example manifest](../examples/extensions/project-info/strata-extension.json) is:

```json
{
  "name": "project-info",
  "version": "1.0.0",
  "apiVersion": 1,
  "main": "index.mjs"
}
```

These four fields are required; unknown fields are rejected. `version` must
be a semantic version and `apiVersion` must be `1`. `main` must be a relative
local `.js` or `.mjs` entry within the canonical extension root, not a URL or
parent-directory escape. Use ESM; `.mjs` avoids ambiguity about Node's module
mode. Manifest and entry reads are limited to 64 KiB and 1 MiB respectively.

The entry exports `activate(api)`. It may be synchronous or asynchronous and
may return a cleanup function, also synchronous or asynchronous. The v1 API
has exactly one method: `api.registerTool(tool)`.

## Tool Contract

See [src/core/tool.ts](../src/core/tool.ts) and the complete example above.

- Register during `activate`, including its awaited work. Registration after
  activation finishes or times out is rejected.
- Supply a unique name, nonempty description, object `inputSchema`, and async
  `run(input, context)` returning a string. Tool names use 1-64 letters, digits,
  underscores, or hyphens.
- Schemas must be synchronous JSON data and compile under strict AJV. Inputs
  are validated before approval and execution without coercion or defaults.
  Use `additionalProperties: false` when unexpected fields should be rejected.
- `needsPermission` defaults to `true`. Set it to `false` only for tools you
  deliberately trust to run without approval. Throw on failure; an error-looking
  string is still a successful return value.
- The agent supplies `context.cwd`, `context.signal`, and `context.maxOutputBytes`.
  Honor cancellation and bound work/output inside the tool. Runtime output
  truncation does not prevent an extension from allocating excessive memory.

Registration copies and freezes metadata and schemas, not the tool's closure
or dependencies. Duplicate tool names across extensions are rejected. The CLI
also rejects collisions with built-ins, even when read-only filtering would
remove the conflicting built-in; `Agent` rejects duplicate names for embedders.

## Lifecycle And Identity

Import plus activation has a 10-second waiting deadline; each cleanup has a
5-second waiting deadline. Cleanup runs in reverse activation order on disposal
and after a load failure, for extensions that supplied cleanup. These timers
cannot terminate JavaScript, undo effects, or interrupt a blocked event loop.
An extension can keep executing after a timeout; do not treat failure to load
as evidence that no code ran.

The loader fingerprints manifest and entry bytes and records the canonical
root, name, version, and API version. The CLI includes those identities in its
session tool-configuration hash. Moving an extension or changing its manifest
or entry invalidates that session identity. Transitive dependencies are **not**
fingerprinted; this is compatibility detection, not integrity verification or
code signing. Review the full dependency tree before granting trust.

Embedders import `loadExtensions` from the package root and call
`loadExtensions(directories, { cwd, trusted: true })`. It returns `tools`,
`identities`, and an asynchronous `dispose()`. Pass the tools to `Agent`, include
the identities in any session configuration hash, and await `dispose()` in
`finally` only after tools have settled. If cleanup fails or times out, keep
session ownership until process termination is confirmed; a timed-out cleanup
may still be running. Neither core nor the loader automatically attaches a file session.

Implementation: [src/extensions/index.ts](../src/extensions/index.ts) and
[src/extensions/lifecycle.ts](../src/extensions/lifecycle.ts).