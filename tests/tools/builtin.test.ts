import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { bashTool, globTool, readTool, writeTool } from "../../src/tools/index.js";

async function createWorkspace(context: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "strata-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("write creates parent directories and replaces existing content", async (context) => {
  const root = await createWorkspace(context);
  const path = join(root, "nested", "example.txt");

  const created = await writeTool.run({ path, content: "first" });
  assert.ok(created.startsWith("Created "));
  assert.equal(await readFile(path, "utf8"), "first");

  const updated = await writeTool.run({ path, content: "second\nline" });
  assert.ok(updated.startsWith("Updated "));
  assert.equal(await readFile(path, "utf8"), "second\nline");
});

test("read uses zero-based paging and one-based line labels", async (context) => {
  const root = await createWorkspace(context);
  const path = join(root, "example.txt");
  await writeTool.run({ path, content: "alpha\nbeta\ngamma" });

  assert.equal(await readTool.run({ path, offset: 1, limit: 1 }),
    "     2\tbeta\n<truncated at line 2 of 3>");
});

test("read reports missing paths and directories", async (context) => {
  const root = await createWorkspace(context);
  assert.match(await readTool.run({ path: join(root, "missing.txt") }), /^File not found:/);
  assert.match(await readTool.run({ path: root }), /is a directory, not a file/);
});

test("glob returns root-relative paths and skips dependency directories", async (context) => {
  const root = await createWorkspace(context);
  await writeTool.run({ path: join(root, "root.txt"), content: "root" });
  await writeTool.run({ path: join(root, "nested", "child.txt"), content: "child" });
  await writeTool.run({ path: join(root, "node_modules", "ignored.txt"), content: "ignored" });

  assert.equal(await globTool.run({ root, pattern: "*.txt" }), "root.txt");
  assert.equal(await globTool.run({ root, pattern: "nested/*.txt" }), "nested/child.txt");
  assert.match(await globTool.run({ root, pattern: "node_modules/*.txt" }), /^No matches/);
});

test("bash executes a short command using the platform shell", async () => {
  const output = await bashTool.run({ command: "echo strata-test", timeout: 5 });
  assert.ok(output.startsWith("<exit code 0>\n"));
  assert.match(output, /strata-test/);
});