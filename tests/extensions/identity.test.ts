import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, cp, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";

import { loadExtensions } from "../../src/extensions/index.js";
import { fixture } from "./fixtures.js";

test("identities contain canonical roots, versions and both SHA256 hashes, in explicit list order", async (context) => {
  const first = await fixture(context, "export function activate() {}", { name: "first", version: "1.2.3-alpha+build" });
  const second = await fixture(context, "export function activate() {}", { name: "second" });
  const loaded = await loadExtensions([first, second], { trusted: true, cwd: first });
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  assert.deepEqual(JSON.parse(loaded.identities[0]!), {
    name: "first", version: "1.2.3-alpha+build", apiVersion: 1, root: await realpath(first),
    manifestSha256: hash(await readFile(join(first, "strata-extension.json"))),
    entrySha256: hash(await readFile(join(first, "index.mjs"))),
  });
  assert.equal(JSON.parse(loaded.identities[1]!).root, await realpath(second));
  const again = await loadExtensions([".", second], { trusted: true, cwd: first });
  assert.deepEqual(again.identities, loaded.identities);
  const reversed = await loadExtensions([second, first], { trusted: true, cwd: first });
  assert.deepEqual(reversed.identities, [...loaded.identities].reverse());
  await Promise.all([loaded.dispose(), again.dispose(), reversed.dispose()]);
});

test("canonical root aliases have the same identity", async (context) => {
  const directory = await fixture(context, "export function activate() {}");
  const parent = await fixture(context, "export function activate() {}");
  const alias = join(parent, "alias");
  await symlink(directory, alias, process.platform === "win32" ? "junction" : "dir");
  const original = await loadExtensions([directory], { trusted: true, cwd: directory });
  const linked = await loadExtensions([alias], { trusted: true, cwd: parent });
  assert.deepEqual(linked.identities, original.identities);
  await Promise.all([original.dispose(), linked.dispose()]);
});

test("manifest byte changes alter the fingerprint even when parsed metadata is unchanged", async (context) => {
  const directory = await fixture(context, "export function activate() {}");
  const before = await loadExtensions([directory], { trusted: true, cwd: directory });
  await appendFile(join(directory, "strata-extension.json"), "\n");
  const after = await loadExtensions([directory], { trusted: true, cwd: directory });
  assert.notDeepEqual(after.identities, before.identities);
  const previous = JSON.parse(before.identities[0]!);
  const current = JSON.parse(after.identities[0]!);
  assert.equal(current.version, previous.version);
  assert.equal(current.root, previous.root);
  assert.equal(current.entrySha256, previous.entrySha256);
  assert.notEqual(current.manifestSha256, previous.manifestSha256);
  await Promise.all([before.dispose(), after.dispose()]);
});

test("manifest version changes are reflected in identities", async (context) => {
  const directory = await fixture(context, "export function activate() {}");
  const before = await loadExtensions([directory], { trusted: true, cwd: directory });
  const path = join(directory, "strata-extension.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.version = "2.0.0-beta.1+local";
  await writeFile(path, JSON.stringify(manifest));
  const after = await loadExtensions([directory], { trusted: true, cwd: directory });
  assert.notDeepEqual(after.identities, before.identities);
  assert.equal(JSON.parse(after.identities[0]!).version, "2.0.0-beta.1+local");
  await Promise.all([before.dispose(), after.dispose()]);
});

function source(value: string): string {
  return `export function activate(api) { api.registerTool({
    name: "probe", description: "Report a fixture value.",
    inputSchema: { type: "object", additionalProperties: false },
    async run() { return ${JSON.stringify(value)}; },
  }); }`;
}

test("entry byte changes alter the fingerprint and do not reuse the old top-level module", async (context) => {
  const directory = await fixture(context, source("before"));
  const before = await loadExtensions([directory], { trusted: true, cwd: directory });
  await writeFile(join(directory, "index.mjs"), source("after"));
  const after = await loadExtensions([directory], { trusted: true, cwd: directory });
  const previous = JSON.parse(before.identities[0]!);
  const current = JSON.parse(after.identities[0]!);
  assert.notDeepEqual(after.identities, before.identities);
  assert.equal(current.root, previous.root);
  assert.equal(current.manifestSha256, previous.manifestSha256);
  assert.notEqual(current.entrySha256, previous.entrySha256);
  assert.equal(await before.tools[0]!.run({}), "before");
  assert.equal(await after.tools[0]!.run({}), "after");
  await Promise.all([before.dispose(), after.dispose()]);
});

test("fingerprints intentionally do not cover transitive dependency bytes", async (context) => {
  const directory = await fixture(context, `import "./dependency.mjs"; export function activate() {}`);
  await writeFile(join(directory, "dependency.mjs"), "export const value = 1;");
  const before = await loadExtensions([directory], { trusted: true, cwd: directory });
  await writeFile(join(directory, "dependency.mjs"), "export const value = 2;");
  const after = await loadExtensions([directory], { trusted: true, cwd: directory });
  assert.deepEqual(after.identities, before.identities);
  await Promise.all([before.dispose(), after.dispose()]);
});

test("file URL loading preserves spaces and hash characters in canonical directory paths", async (context) => {
  const parent = await fixture(context, "export function activate() {}");
  const directory = join(parent, "project #1");
  await mkdir(directory);
  await writeFile(join(directory, "strata-extension.json"), await readFile(join(parent, "strata-extension.json")));
  await writeFile(join(directory, "index.mjs"), source("encoded path"));
  const loaded = await loadExtensions(["project #1"], { trusted: true, cwd: parent });
  assert.equal(await loaded.tools[0]!.run({}), "encoded path");
  await loaded.dispose();
});

test("the project-info example loads and reports only the supplied cwd and platform", async (context) => {
  const parent = await fixture(context, "export function activate() {}");
  const directory = join(parent, "project-info");
  const example = fileURLToPath(new URL("../../examples/extensions/project-info/", import.meta.url));
  await cp(example, directory, { recursive: true });
  const loaded = await loadExtensions(["project-info"], { trusted: true, cwd: parent });
  assert.equal(loaded.tools.length, 1);
  const tool = loaded.tools[0]!;
  assert.equal(tool.name, "project_info");
  assert.equal(tool.needsPermission, false);
  assert.equal(tool.inputSchema.additionalProperties, false);
  const validate = new Ajv({ strict: true }).compile(tool.inputSchema);
  assert.equal(validate({}), true);
  assert.equal(validate({ extra: true }), false);
  assert.deepEqual(JSON.parse(await tool.run({}, {
    cwd: parent, signal: new AbortController().signal, maxOutputBytes: 4096,
  })), { cwd: parent, platform: process.platform });
  await assert.rejects(tool.run({}), /requires a tool context/);
  await loaded.dispose();
});