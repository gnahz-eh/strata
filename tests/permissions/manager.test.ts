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