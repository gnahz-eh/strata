import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type { ToolContext } from "../../src/core/tool.js";
import { bashTool, globTool, readTool, writeTool } from "../../src/tools/index.js";

async function createWorkspace(context: TestContext): Promise<ToolContext> {
  const root = await mkdtemp(join(tmpdir(), "strata-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return { cwd: root, signal: new AbortController().signal, maxOutputBytes: 30_000 };
}

test("write creates parent directories and replaces existing content", async (context) => {
  const workspace = await createWorkspace(context);
  const path = join(workspace.cwd, "nested", "example.txt");

  const created = await writeTool.run({ path, content: "first" }, workspace);
  assert.ok(created.startsWith("Created "));
  assert.equal(await readFile(path, "utf8"), "first");

  const updated = await writeTool.run({ path, content: "second\nline" }, workspace);
  assert.ok(updated.startsWith("Updated "));
  assert.equal(await readFile(path, "utf8"), "second\nline");
});

test("read uses zero-based paging and one-based line labels", async (context) => {
  const workspace = await createWorkspace(context);
  const path = join(workspace.cwd, "example.txt");
  await writeTool.run({ path, content: "alpha\nbeta\ngamma" }, workspace);

  assert.equal(await readTool.run({ path, offset: 1, limit: 1 }, workspace),
    "     2\tbeta\n<truncated at line 2 of 3>");
});

test("read throws for missing paths and directories", async (context) => {
  const workspace = await createWorkspace(context);
  await assert.rejects(readTool.run({ path: "missing.txt" }, workspace), /ENOENT/);
  await assert.rejects(readTool.run({ path: workspace.cwd }, workspace), /not a regular file/);
});

test("glob returns root-relative paths and skips dependency directories", async (context) => {
  const workspace = await createWorkspace(context);
  await writeTool.run({ path: "root.txt", content: "root" }, workspace);
  await writeTool.run({ path: "nested/child.txt", content: "child" }, workspace);
  await writeTool.run({ path: "node_modules/ignored.txt", content: "ignored" }, workspace);

  assert.equal(await globTool.run({ pattern: "*.txt" }, workspace), "root.txt");
  assert.equal(await globTool.run({ pattern: "nested/*.txt" }, workspace), "nested/child.txt");
  assert.match(await globTool.run({ pattern: "node_modules/*.txt" }, workspace), /^No matches/);
});

test("bash executes a short command using the platform shell", async (context) => {
  const workspace = await createWorkspace(context);
  const output = await bashTool.run({ command: "echo strata-test", timeout: 5 }, workspace);
  assert.ok(output.startsWith("<exit code 0>\n"));
  assert.match(output, /strata-test/);
});

test("direct tool calls default to process.cwd without requiring context", { timeout: 10_000 }, async (context) => {
  const workspace = await createWorkspace(context);
  const previousCwd = process.cwd();
  process.chdir(workspace.cwd);
  try {
    await writeTool.run({ path: "direct.txt", content: "direct" });
    assert.equal(await readTool.run({ path: "direct.txt" }), "     1\tdirect");
    assert.equal(await globTool.run({ pattern: "**/*.txt" }), "direct.txt");
    assert.match(await bashTool.run({ command: "echo direct", timeout: 5 }), /<exit code 0>\n.*direct/);
  } finally {
    process.chdir(previousCwd);
  }
});