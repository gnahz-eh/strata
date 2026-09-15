import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type { ToolContext } from "../../src/core/tool.js";
import { writeTool } from "../../src/tools/write.js";

async function workspace(testContext: TestContext): Promise<ToolContext> {
  const cwd = await mkdtemp(join(tmpdir(), "strata-write-"));
  testContext.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, signal: new AbortController().signal, maxOutputBytes: 30_000 };
}

test("write creates parents and atomically replaces the full file", async (testContext) => {
  const context = await workspace(testContext);
  const path = join(context.cwd, "nested", "file.txt");
  assert.match(await writeTool.run({ path: "nested/file.txt", content: "original" }, context), /^Created /);
  assert.equal(await readFile(path, "utf8"), "original");
  assert.match(await writeTool.run({ path: "nested/file.txt", content: "new\n" }, context), /Updated .*1 lines/);
  assert.equal(await readFile(path, "utf8"), "new\n");
  assert.deepEqual(await readdir(join(context.cwd, "nested")), ["file.txt"]);
});

test("write refuses workspace escapes, non-directory parents, and directory targets", async (testContext) => {
  const context = await workspace(testContext);
  await writeFile(join(context.cwd, "file.txt"), "original");
  await assert.rejects(writeTool.run({ path: "../outside.txt", content: "bad" }, context), /outside the workspace/);
  await assert.rejects(writeTool.run({ path: ".", content: "bad" }, context), /not a regular file/);
  await assert.rejects(writeTool.run({ path: "file.txt/child.txt", content: "bad" }, context), /not a directory/);
  await assert.rejects(writeTool.run({ path: "", content: "bad" }, context), /nonempty/);
  assert.equal(await readFile(join(context.cwd, "file.txt"), "utf8"), "original");
});

test("write preserves existing file permissions", { skip: process.platform === "win32" }, async (testContext) => {
  const context = await workspace(testContext);
  const path = join(context.cwd, "file.txt");
  await writeFile(path, "original");
  await chmod(path, 0o640);
  await writeTool.run({ path, content: "new" }, context);
  assert.equal((await stat(path)).mode & 0o777, 0o640);
});

test("write checks cancellation before commit and removes its temporary file", async (testContext) => {
  const context = await workspace(testContext);
  const controller = new AbortController();
  const path = join(context.cwd, "file.txt");
  await writeFile(path, "original");
  const throwIfAborted = controller.signal.throwIfAborted.bind(controller.signal);
  testContext.mock.method(controller.signal, "throwIfAborted", () => {
    if (readdirSync(context.cwd).some((name) => name.startsWith(".strata-write-"))) {
      controller.abort(new Error("cancel before commit"));
    }
    throwIfAborted();
  });
  await assert.rejects(writeTool.run({ path, content: "replacement" }, {
    ...context, signal: controller.signal,
  }), /cancel before commit/);
  assert.equal(await readFile(path, "utf8"), "original");
  assert.deepEqual(await readdir(context.cwd), ["file.txt"]);
});

test("write rejects pre-aborted calls without creating directories", async (testContext) => {
  const context = await workspace(testContext);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(writeTool.run({ path: "new/file.txt", content: "bad" }, {
    ...context, signal: controller.signal,
  }), { name: "AbortError" });
  assert.deepEqual(await readdir(context.cwd), []);
});

test("write bounds its response without truncating the actual file", async (testContext) => {
  const context = await workspace(testContext);
  const content = "\u{1f600}".repeat(1000);
  const output = await writeTool.run({ path: "file.txt", content }, { ...context, maxOutputBytes: 20 });
  assert.ok(Buffer.byteLength(output) <= 20);
  assert.match(output, /<truncated>$/);
  assert.equal(await readFile(join(context.cwd, "file.txt"), "utf8"), content);
});

test("write rejects escaping ancestors even when descendant directories do not exist", async (testContext) => {
  const context = await workspace(testContext);
  const outside = await workspace(testContext);
  try {
    await symlink(outside.cwd, join(context.cwd, "escape"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      testContext.skip("Symbolic link creation is unavailable on this platform.");
      return;
    }
    throw error;
  }
  await assert.rejects(writeTool.run({ path: "escape/new/file.txt", content: "bad" }, context), /outside the workspace/);
  assert.deepEqual(await readdir(outside.cwd), []);
});

test("write refuses all final symlinks, including in-workspace and dangling links", async (testContext) => {
  const context = await workspace(testContext);
  await writeFile(join(context.cwd, "target.txt"), "original");
  try {
    await symlink(join(context.cwd, "target.txt"), join(context.cwd, "link.txt"), "file");
    await symlink(join(context.cwd, "missing.txt"), join(context.cwd, "dangling.txt"), "file");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      testContext.skip("Symbolic link creation is unavailable on this platform.");
      return;
    }
    throw error;
  }
  for (const path of ["link.txt", "dangling.txt"]) {
    await assert.rejects(writeTool.run({ path, content: "bad" }, context), /symbolic link/);
  }
  assert.equal(await readFile(join(context.cwd, "target.txt"), "utf8"), "original");
  assert.deepEqual((await readdir(context.cwd)).sort(), ["dangling.txt", "link.txt", "target.txt"]);
});