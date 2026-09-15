import assert from "node:assert/strict";
import { test } from "node:test";

import { PermissionManager } from "../../src/permissions/manager.js";
import { bashTool, readTool, writeTool, globTool } from "../../src/tools/index.js";

test("accept mode approves permission-requiring tools", async () => {
  const permissions = new PermissionManager("accept");
  assert.deepEqual(await permissions.request(bashTool, { command: "echo test" }), { allowed: true });
  assert.deepEqual(await permissions.request(writeTool, { path: "unused", content: "" }), { allowed: true });
});

test("deny mode rejects permission-requiring tools", async () => {
  const permissions = new PermissionManager("deny");
  for (const tool of [bashTool, writeTool]) {
    assert.equal(tool.needsPermission, true);
    assert.deepEqual(await permissions.request(tool, {}), {
      allowed: false,
      reason: "denied by policy",
    });
  }
});

test("read-only tools bypass prompts in every permission mode", async () => {
  for (const mode of ["ask", "accept", "deny"] as const) {
    const permissions = new PermissionManager(mode);
    for (const tool of [readTool, globTool]) {
      assert.equal(tool.needsPermission, false);
      assert.deepEqual(await permissions.request(tool, {}), { allowed: true });
    }
  }
});

test("missing permission flags and unavailable interaction fail closed", async () => {
  const permissions = new PermissionManager();
  const implicit = { ...writeTool, needsPermission: undefined };
  assert.deepEqual(await permissions.request(implicit, {}), { allowed: false, reason: "interactive approval is unavailable" });
});

test("interactive approvals retry invalid answers and scope always to the tool name", async () => {
  const answers = ["invalid", "always", "no"];
  let prompts = 0;
  const permissions = new PermissionManager("ask", async () => { prompts += 1; return answers.shift(); });
  assert.deepEqual(await permissions.request(writeTool, {}), { allowed: true });
  assert.deepEqual(await permissions.request(writeTool, { path: "another.txt" }), { allowed: true });
  assert.equal(prompts, 2);
  assert.deepEqual(await permissions.request(bashTool, {}), { allowed: false, reason: "user denied" });
  assert.equal(prompts, 3);
});

test("permission cancellation wins over an answer and never remembers an approval", async () => {
  const controller = new AbortController();
  const permissions = new PermissionManager("ask", async () => { controller.abort(); return "always"; });
  await assert.rejects(() => permissions.request(writeTool, {}, {
    cwd: process.cwd(), signal: controller.signal, maxOutputBytes: 128,
  }), /abort/i);
  permissions.mode = "deny";
  assert.equal((await permissions.request(writeTool, {})).allowed, false);
});