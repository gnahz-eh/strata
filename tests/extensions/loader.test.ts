import assert from "node:assert/strict";
import { access, copyFile, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { loadExtensions } from "../../src/extensions/index.js";
import type { Tool } from "../../src/core/tool.js";
import { bridge, fixture, validSource } from "./fixtures.js";

test("untrusted directories never evaluate entry code, including top-level side effects", async (context) => {
  const directory = await fixture(context, `
    import { writeFileSync } from "node:fs";
    writeFileSync(new URL("./executed", import.meta.url), "executed");
    export function activate() {}
  `);
  await assert.rejects(loadExtensions([directory], { trusted: false, cwd: directory }), /trust/i);
  await assert.rejects(access(join(directory, "executed")), { code: "ENOENT" });
  await assert.rejects(loadExtensions([join(directory, "missing")], { trusted: false, cwd: directory }), /trust/i);
});

test("an empty explicit list needs no trust or filesystem access", async () => {
  const loaded = await loadExtensions([], { trusted: false, cwd: "nonexistent-extension-cwd" });
  assert.deepEqual(loaded.tools, []);
  assert.deepEqual(loaded.identities, []);
  await loaded.dispose();
});

test("trusted activation returns frozen tools, defaults permission, forwards context, and disposes once", async (context) => {
  const directory = await fixture(context, validSource);
  const loaded = await loadExtensions([directory], { trusted: true, cwd: directory });
  context.after(() => loaded.dispose());
  assert.equal(loaded.tools.length, 1);
  const tool = loaded.tools[0]!;
  assert.equal(tool.name, "project_info");
  assert.equal(tool.needsPermission, true);
  assert.equal(Object.isFrozen(tool), true);
  assert.equal(Object.isFrozen(tool.inputSchema), true);
  assert.equal(Object.isFrozen(tool.inputSchema.properties), true);
  assert.equal(await tool.run({}, { cwd: directory, signal: new AbortController().signal, maxOutputBytes: 128 }), directory);
  assert.equal(loaded.identities.length, 1);
  const disposal = loaded.dispose();
  assert.strictEqual(loaded.dispose(), disposal);
  await disposal;
  await loaded.dispose();
  assert.equal(await readFile(join(directory, "disposed"), "utf8"), "cleaned");
});

const markerSource = `
import { writeFileSync } from "node:fs";
writeFileSync(new URL("./executed", import.meta.url), "executed");
export function activate() {}
`;

test("trust must be the boolean true, not a truthy value", async (context) => {
  const directory = await fixture(context, markerSource);
  await assert.rejects(loadExtensions([directory], { trusted: "true" as unknown as boolean, cwd: directory }), /trust/i);
  await assert.rejects(access(join(directory, "executed")), { code: "ENOENT" });
});

test("only the original explicit list is loaded, with no discovery or late additions", async (context) => {
  const unlisted = await fixture(context, markerSource);
  const directories: string[] = [];
  const shared = bridge(context, { directories, unlisted });
  const listed = await fixture(context, `export function activate() { ${shared}.directories.push(${shared}.unlisted); }`);
  await mkdir(join(listed, "unlisted-child"));
  await copyFile(join(unlisted, "strata-extension.json"), join(listed, "unlisted-child", "strata-extension.json"));
  await copyFile(join(unlisted, "index.mjs"), join(listed, "unlisted-child", "index.mjs"));
  directories.push(listed);
  const loaded = await loadExtensions(directories, { trusted: true, cwd: listed });
  assert.equal(loaded.identities.length, 1);
  await loaded.dispose();
  await assert.rejects(access(join(unlisted, "executed")), { code: "ENOENT" });
  await assert.rejects(access(join(listed, "unlisted-child", "executed")), { code: "ENOENT" });
});

const invalidManifests: [string, Record<string, unknown>][] = [
  ["empty name", { name: "" }],
  ["non-string name", { name: 7 }],
  ["unsafe name", { name: "../extension" }],
  ["name with trailing newline", { name: "extension\n" }],
  ["missing version", { version: undefined }],
  ["non-string version", { version: 1 }],
  ["partial version", { version: "1.2" }],
  ["prefixed version", { version: "v1.2.3" }],
  ["leading-zero version", { version: "01.2.3" }],
  ["leading-zero prerelease", { version: "1.2.3-01" }],
  ["empty prerelease identifier", { version: "1.2.3-alpha..1" }],
  ["empty build metadata", { version: "1.2.3+" }],
  ["version with trailing newline", { version: "1.2.3\n" }],
  ["unsupported API version", { apiVersion: 2 }],
  ["string API version", { apiVersion: "1" }],
  ["missing main", { main: undefined }],
  ["non-string main", { main: [] }],
  ["unknown manifest property", { extra: true }],
];

for (const [label, manifest] of invalidManifests) {
  test(`rejects manifest with ${label} before evaluating the entry`, async (context) => {
    const directory = await fixture(context, markerSource, manifest);
    await assert.rejects(loadExtensions([directory], { trusted: true, cwd: directory }), /Invalid extension manifest/);
    await assert.rejects(access(join(directory, "executed")), { code: "ENOENT" });
  });
}

for (const manifest of ["{", "null", "[]", "42"]) {
  test(`rejects malformed or non-object manifest ${JSON.stringify(manifest)}`, async (context) => {
    const directory = await fixture(context, markerSource);
    await writeFile(join(directory, "strata-extension.json"), manifest);
    await assert.rejects(loadExtensions([directory], { trusted: true, cwd: directory }));
    await assert.rejects(access(join(directory, "executed")), { code: "ENOENT" });
  });
}

for (const version of ["0.0.0", "1.2.3-alpha.0+build.001", "12.34.56-1a.0.x-y+001.build"]) {
  test(`accepts SemVer ${version}`, async (context) => {
    const directory = await fixture(context, "export function activate() {}", { version });
    const loaded = await loadExtensions([directory], { trusted: true, cwd: directory });
    assert.equal(JSON.parse(loaded.identities[0]!).version, version);
    await loaded.dispose();
  });
}

for (const main of [
  "../index.mjs", "nested/../../index.mjs", "..\\index.mjs", "/tmp/entry.mjs", "C:\\outside\\entry.mjs",
  "C:entry.mjs", "\\\\host\\share\\entry.mjs", "file:///tmp/entry.mjs", "https://example.invalid/entry.mjs",
  "npm:package/index.js", "node:fs", "ajv", "@scope/package", "index.cjs", "index.ts", "index.json",
  "index.mjs?query", "index.mjs#fragment", "index.mjs\n", "index\u0000.mjs",
]) {
  test(`rejects non-local or unsupported main ${JSON.stringify(main)}`, async (context) => {
    const directory = await fixture(context, markerSource, { main });
    await assert.rejects(loadExtensions([directory], { trusted: true, cwd: directory }), /relative local \.js or \.mjs/);
    await assert.rejects(access(join(directory, "executed")), { code: "ENOENT" });
  });
}

test("main never uses npm package resolution, even when the package is installed", async (context) => {
  const directory = await fixture(context, markerSource, { main: "ajv/dist/ajv.js" });
  await assert.rejects(loadExtensions([directory], { trusted: true, cwd: directory }), { code: "ENOENT" });
  await assert.rejects(access(join(directory, "executed")), { code: "ENOENT" });
});

test("entry realpath cannot escape through a directory symlink or Windows junction", async (context) => {
  const outside = await fixture(context, markerSource);
  const directory = await fixture(context, markerSource, { main: "./linked/index.mjs" });
  await symlink(outside, join(directory, "linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(loadExtensions([directory], { trusted: true, cwd: directory }), /inside its canonical root/);
  await assert.rejects(access(join(outside, "executed")), { code: "ENOENT" });
});

test("a symlink to a sibling sharing the root's name prefix is still outside", async (context) => {
  const parent = await fixture(context, "export function activate() {}");
  const directory = join(parent, "extension");
  const outside = join(parent, "extension-other");
  await mkdir(directory);
  await mkdir(outside);
  await writeFile(join(directory, "strata-extension.json"), JSON.stringify({ name: "test", version: "1.0.0", apiVersion: 1, main: "linked/entry.mjs" }));
  await writeFile(join(outside, "entry.mjs"), markerSource);
  await symlink(outside, join(directory, "linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(loadExtensions([directory], { trusted: true, cwd: parent }), /inside its canonical root/);
  await assert.rejects(access(join(outside, "executed")), { code: "ENOENT" });
});

test("internal symlinks and relative .js ESM files remain usable", async (context) => {
  const directory = await fixture(context, "export function activate() {}", { main: "./linked/entry.js" });
  const moduleDirectory = join(directory, "module space");
  await mkdir(moduleDirectory);
  await writeFile(join(moduleDirectory, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(join(moduleDirectory, "entry.js"), "export function activate() {}");
  await symlink(moduleDirectory, join(directory, "linked"), process.platform === "win32" ? "junction" : "dir");
  const loaded = await loadExtensions([directory], { trusted: true, cwd: directory });
  assert.equal(loaded.identities.length, 1);
  await loaded.dispose();
});

for (const [file, limit] of [["strata-extension.json", 64 * 1024], ["index.mjs", 1024 * 1024]] as const) {
  test(`${file} must be bounded in bytes`, async (context) => {
    const directory = await fixture(context, markerSource);
    await writeFile(join(directory, file), Buffer.alloc(limit + 1, 32));
    await assert.rejects(loadExtensions([directory], { trusted: true, cwd: directory }), /exceeds.*bytes/);
    await assert.rejects(access(join(directory, "executed")), { code: "ENOENT" });
  });

  test(`${file} must be a regular file`, async (context) => {
    const directory = await fixture(context, markerSource);
    await rm(join(directory, file));
    await mkdir(join(directory, file));
    await assert.rejects(loadExtensions([directory], { trusted: true, cwd: directory }));
  });
}

function tool(overrides: Record<string, unknown> = {}) {
  return {
    name: "probe", description: "A fixture tool.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run() { return "original"; }, ...overrides,
  };
}

const cyclicSchema: Record<string, unknown> = { type: "object" };
cyclicSchema.properties = { loop: cyclicSchema };
const invalidTools: [string, unknown][] = [
  ["null descriptor", null], ["array descriptor", []],
  ["empty name", tool({ name: "" })], ["non-string name", tool({ name: 7 })],
  ["unsafe name", tool({ name: "path/tool" })], ["overlong name", tool({ name: "a".repeat(65) })],
  ["name with newline", tool({ name: "probe\n" })],
  ["empty description", tool({ description: " " })], ["non-string description", tool({ description: {} })],
  ["non-callable run", tool({ run: "run" })], ["invalid permission flag", tool({ needsPermission: "false" })],
  ["missing schema", tool({ inputSchema: undefined })], ["boolean schema", tool({ inputSchema: true })],
  ["array root schema", tool({ inputSchema: { type: "array" } })],
  ["invalid schema type", tool({ inputSchema: { type: "object", properties: { value: { type: "bogus" } } } })],
  ["unknown strict schema keyword", tool({ inputSchema: { type: "object", misspelled: true } })],
  ["invalid required list", tool({ inputSchema: { type: "object", required: "value" } })],
  ["remote schema reference", tool({ inputSchema: { type: "object", $ref: "https://example.invalid/schema.json" } })],
  ["asynchronous schema", tool({ inputSchema: { type: "object", $async: true } })],
  ["cyclic schema", tool({ inputSchema: cyclicSchema })],
  ["non-JSON schema data", tool({ inputSchema: { type: "object", default: new Date() } })],
  ["non-finite schema data", tool({ inputSchema: { type: "object", default: Infinity } })],
  ["executable schema data", tool({ inputSchema: { type: "object", default() {} } })],
];

for (const [label, candidate] of invalidTools) {
  test(`rejects a tool with ${label}`, async (context) => {
    const shared = bridge(context, { candidate });
    const directory = await fixture(context, `export function activate(api) { api.registerTool(${shared}.candidate); }`);
    await assert.rejects(loadExtensions([directory], { trusted: true, cwd: directory }));
  });
}

test("registration snapshots and deeply freezes descriptors without freezing the extension's own objects", async (context) => {
  const schema = { type: "object", properties: { label: { type: "string", enum: ["original"] } }, required: ["label"], additionalProperties: false };
  const original = tool({ name: "read", needsPermission: false, inputSchema: schema });
  const shared = bridge(context, { original });
  const directory = await fixture(context, `export function activate(api) { api.registerTool(${shared}.original); }`);
  const loaded = await loadExtensions([directory], { trusted: true, cwd: directory });
  original.name = "changed";
  original.description = "changed";
  original.run = async () => "changed";
  schema.properties.label.enum.push("changed");
  schema.required.push("changed");
  const registered = loaded.tools[0]!;
  assert.equal(registered.name, "read");
  assert.equal(registered.description, "A fixture tool.");
  assert.equal(registered.needsPermission, false);
  assert.equal(await registered.run({ label: "original" }), "original");
  assert.deepEqual(registered.inputSchema.required, ["label"]);
  const frozenLabel = registered.inputSchema.properties!.label as { enum: string[] };
  assert.deepEqual(frozenLabel.enum, ["original"]);
  assert.throws(() => frozenLabel.enum.push("later"), TypeError);
  assert.throws(() => { registered.name = "later"; }, TypeError);
  assert.equal(Object.isFrozen(original), false);
  await loaded.dispose();
});

test("late registration is rejected after activation and after disposal", async (context) => {
  const state = { register: undefined as ((value: Tool) => void) | undefined };
  const shared = bridge(context, state);
  const directory = await fixture(context, `export function activate(api) { ${shared}.register = api.registerTool; }`);
  const loaded = await loadExtensions([directory], { trusted: true, cwd: directory });
  assert.throws(() => state.register!({} as Tool), /only.*during activation/);
  await loaded.dispose();
  assert.throws(() => state.register!({} as Tool), /only.*during activation/);
  assert.deepEqual(loaded.tools, []);
});

test("trusted entries retain normal Node imports outside the selected directory", async (context) => {
  const dependency = await fixture(context, 'export const value = "outside dependency";');
  const dependencyUrl = pathToFileURL(join(dependency, "index.mjs")).href;
  const directory = await fixture(context, `
    import { value } from ${JSON.stringify(dependencyUrl)};
    export function activate(api) {
      api.registerTool({ name: "external", description: "Report an imported value.",
        inputSchema: { type: "object", additionalProperties: false }, async run() { return value; } });
    }
  `);
  const loaded = await loadExtensions([directory], { trusted: true, cwd: directory });
  assert.equal(await loaded.tools[0]!.run({}), "outside dependency");
  await loaded.dispose();
});