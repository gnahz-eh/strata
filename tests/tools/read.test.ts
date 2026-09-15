import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type { ToolContext } from "../../src/core/tool.js";
import { readTool } from "../../src/tools/read.js";

async function workspace(testContext: TestContext): Promise<ToolContext> {
  const cwd = await mkdtemp(join(tmpdir(), "strata-read-"));
  testContext.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, signal: new AbortController().signal, maxOutputBytes: 30_000 };
}

test("read resolves against context and handles CRLF, paging, and trailing newlines", async (testContext) => {
  const context = await workspace(testContext);
  await writeFile(join(context.cwd, "lines.txt"), "alpha\r\nbeta\r\ngamma\r\n");
  assert.equal(await readTool.run({ path: "lines.txt", offset: 1, limit: 1 }, context),
    "     2\tbeta\n<truncated at line 2 of 3>");
  assert.equal(await readTool.run({ path: "lines.txt", offset: 2 }, context), "     3\tgamma");
  assert.equal(await readTool.run({ path: "lines.txt", offset: 3 }, context), "");
  await writeFile(join(context.cwd, "lines.txt"), "\n\n");
  assert.equal(await readTool.run({ path: "lines.txt" }, context), "     1\t\n     2\t");
  await writeFile(join(context.cwd, "lines.txt"), "");
  assert.equal(await readTool.run({ path: "lines.txt" }, context), "");
});

test("read throws for missing paths, directories, escape paths, and invalid ranges", async (testContext) => {
  const context = await workspace(testContext);
  await assert.rejects(readTool.run({ path: "missing.txt" }, context), /ENOENT/);
  await assert.rejects(readTool.run({ path: "." }, context), /not a regular file/);
  await assert.rejects(readTool.run({ path: "../outside.txt" }, context), /outside the workspace/);
  await assert.rejects(readTool.run({ path: "missing.txt", offset: -1 }, context), /offset/);
  await assert.rejects(readTool.run({ path: "missing.txt", limit: 0 }, context), /limit/);
  await assert.rejects(readTool.run({ path: "missing.txt", limit: 2001 }, context), /limit/);
});

test("read rejects invalid UTF-8 and files over one MiB", async (testContext) => {
  const context = await workspace(testContext);
  await writeFile(join(context.cwd, "invalid.txt"), Buffer.from([0xc3, 0x28]));
  await assert.rejects(readTool.run({ path: "invalid.txt" }, context), /encoded data|encoding/i);
  await writeFile(join(context.cwd, "large.txt"), Buffer.alloc(1024 * 1024 + 1, 0x61));
  await assert.rejects(readTool.run({ path: "large.txt" }, context), /byte read limit/);
});

test("read truncates output by bytes without splitting UTF-8", async (testContext) => {
  const context = await workspace(testContext);
  await writeFile(join(context.cwd, "unicode.txt"), "\u{1f600}".repeat(100));
  const output = await readTool.run({ path: "unicode.txt" }, { ...context, maxOutputBytes: 30 });
  assert.ok(Buffer.byteLength(output) <= 30);
  assert.match(output, /<truncated>$/);
  assert.ok(!output.includes("\ufffd"));
});

test("read rejects pre-aborted calls", async (testContext) => {
  const context = await workspace(testContext);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readTool.run({ path: "missing.txt" }, {
    ...context, signal: controller.signal,
  }), { name: "AbortError" });
});

test("read rejects symlink escapes and allows in-workspace file links", async (testContext) => {
  const context = await workspace(testContext);
  const outside = await workspace(testContext);
  await writeFile(join(outside.cwd, "secret.txt"), "secret");
  await mkdir(join(context.cwd, "inside"));
  await writeFile(join(context.cwd, "inside", "ok.txt"), "ok");
  try {
    await symlink(outside.cwd, join(context.cwd, "escape"), process.platform === "win32" ? "junction" : "dir");
    await symlink(join(context.cwd, "inside", "ok.txt"), join(context.cwd, "link.txt"), "file");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      testContext.skip("Symbolic link creation is unavailable on this platform.");
      return;
    }
    throw error;
  }
  await assert.rejects(readTool.run({ path: "escape/secret.txt" }, context), /outside the workspace/);
  assert.equal(await readTool.run({ path: "link.txt" }, context), "     1\tok");
});