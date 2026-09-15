import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type { ToolContext } from "../../src/core/tool.js";
import { globTool } from "../../src/tools/glob.js";

async function workspace(testContext: TestContext): Promise<ToolContext> {
  const cwd = await mkdtemp(join(tmpdir(), "strata-glob-"));
  testContext.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, signal: new AbortController().signal, maxOutputBytes: 30_000 };
}

test("glob supports zero-directory ** matches, direct paths, braces, and nested roots", async (testContext) => {
  const context = await workspace(testContext);
  await mkdir(join(context.cwd, "nested", "child"), { recursive: true });
  for (const path of ["root.ts", "nested/direct.ts", "nested/child/deep.ts", "nested/note.md"]) {
    await writeFile(join(context.cwd, path), "content");
  }
  assert.equal(await globTool.run({ pattern: "**/*.ts" }, context),
    "nested/child/deep.ts\nnested/direct.ts\nroot.ts");
  assert.equal(await globTool.run({ pattern: "nested/**/*.ts" }, context),
    "nested/child/deep.ts\nnested/direct.ts");
  assert.equal(await globTool.run({ pattern: "root.ts" }, context), "root.ts");
  assert.equal(await globTool.run({ root: "nested", pattern: "*.{ts,md}" }, context), "direct.ts\nnote.md");
  assert.match(await globTool.run({ pattern: "missing/*.ts" }, context), /^No matches/);
});

test("glob is files-only and skips dependency, generated, git, and strata directories", async (testContext) => {
  const context = await workspace(testContext);
  await mkdir(join(context.cwd, "directory.txt"));
  await writeFile(join(context.cwd, "visible.txt"), "visible");
  await writeFile(join(context.cwd, ".hidden.txt"), "visible");
  for (const directory of ["node_modules", ".git", ".strata", "dist", "build", "coverage", ".venv"]) {
    await mkdir(join(context.cwd, directory));
    await writeFile(join(context.cwd, directory, "ignored.txt"), "ignored");
    assert.match(await globTool.run({ pattern: `${directory}/*.txt` }, context), /^No matches/);
    assert.match(await globTool.run({ root: directory, pattern: "*.txt" }, context), /^No matches/);
  }
  assert.equal(await globTool.run({ pattern: "**/*.txt" }, context), ".hidden.txt\nvisible.txt");
  assert.match(await globTool.run({ pattern: "directory.txt" }, context), /^No matches/);
});

test("glob throws for missing, non-directory, and escaping roots and patterns", async (testContext) => {
  const context = await workspace(testContext);
  await writeFile(join(context.cwd, "file.txt"), "file");
  await assert.rejects(globTool.run({ root: "missing", pattern: "*" }, context), /ENOENT/);
  await assert.rejects(globTool.run({ root: "file.txt", pattern: "*" }, context), /not a directory/);
  await assert.rejects(globTool.run({ root: "..", pattern: "*" }, context), /outside the workspace/);
  for (const pattern of ["../*", "{../outside,nested}/*.txt", "@(../outside|nested)/*.txt", "/tmp/*", "C:/Windows/*", ""]) {
    await assert.rejects(globTool.run({ pattern }, context), /pattern.*(?:root|relative|nonempty)/i, pattern);
  }
});

test("glob caps results at 200 and reports overflow only when another match exists", async (testContext) => {
  const context = await workspace(testContext);
  await Promise.all(Array.from({ length: 200 }, (_, index) =>
    writeFile(join(context.cwd, `${String(index).padStart(3, "0")}.txt`), "")));
  const exact = await globTool.run({ pattern: "*.txt" }, context);
  assert.equal(exact.split("\n").length, 200);
  assert.ok(!exact.includes("truncated"));
  await writeFile(join(context.cwd, "extra.txt"), "");
  const capped = await globTool.run({ pattern: "*.txt" }, context);
  assert.equal(capped.split("\n").filter((line) => line.endsWith(".txt")).length, 200);
  assert.match(capped, /<truncated: more than 200 results/);
});

test("glob bounds UTF-8 output and rejects cancellation", async (testContext) => {
  const context = await workspace(testContext);
  await writeFile(join(context.cwd, `${"\u00e9".repeat(40)}.txt`), "");
  const output = await globTool.run({ pattern: "*.txt" }, { ...context, maxOutputBytes: 25 });
  assert.ok(Buffer.byteLength(output) <= 25);
  assert.ok(!output.includes("\ufffd"));
  assert.match(output, /<truncated>$/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(globTool.run({ pattern: "*" }, { ...context, signal: controller.signal }), { name: "AbortError" });
});

test("glob never follows linked files or directories, including explicit pattern bases", async (testContext) => {
  const context = await workspace(testContext);
  const outside = await workspace(testContext);
  await writeFile(join(outside.cwd, "secret.txt"), "secret");
  await mkdir(join(context.cwd, "inside"));
  await writeFile(join(context.cwd, "inside", "ok.txt"), "ok");
  try {
    const directoryType = process.platform === "win32" ? "junction" : "dir";
    await symlink(outside.cwd, join(context.cwd, "escape"), directoryType);
    await symlink(outside.cwd, join(context.cwd, "escape[dir]"), directoryType);
    await symlink(join(context.cwd, "inside"), join(context.cwd, "linked"), directoryType);
    await symlink(join(context.cwd, "inside", "ok.txt"), join(context.cwd, "link.txt"), "file");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      testContext.skip("Symbolic link creation is unavailable on this platform.");
      return;
    }
    throw error;
  }
  assert.equal(await globTool.run({ pattern: "**/*.txt" }, context), "inside/ok.txt");
  assert.match(await globTool.run({ pattern: "link.txt" }, context), /^No matches/);
  for (const root of ["escape", "linked"]) {
    await assert.rejects(globTool.run({ root, pattern: "*" }, context), /symbolic link/);
    await assert.rejects(globTool.run({ pattern: `${root}/*.txt` }, context), /symbolic link/);
    await assert.rejects(globTool.run({ pattern: `${root}/ok.txt` }, context), /symbolic link/);
  }
  for (const pattern of ["escape\\[dir\\]/*.txt", "escape\\[dir\\]/secret.txt"]) {
    await assert.rejects(globTool.run({ pattern }, context), /symbolic link/, pattern);
  }
});

test("glob rejects inaccessible roots", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, async (testContext) => {
  const context = await workspace(testContext);
  const root = join(context.cwd, "locked");
  await mkdir(root);
  await chmod(root, 0);
  try {
    await assert.rejects(globTool.run({ root, pattern: "*" }, context), /EACCES|EPERM/);
  } finally {
    await chmod(root, 0o700);
  }
});