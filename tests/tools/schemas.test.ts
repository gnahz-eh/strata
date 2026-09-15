import assert from "node:assert/strict";
import { test } from "node:test";
import { Ajv } from "ajv";

import { ALL_TOOLS, bashTool, readTool } from "../../src/tools/index.js";

const samples: Record<string, Record<string, unknown>> = {
  bash: { command: "echo test" },
  read: { path: "file.txt" },
  write: { path: "file.txt", content: "" },
  glob: { pattern: "**/*.ts" },
};

test("built-in registry preserves names and explicit permission settings", () => {
  assert.deepEqual(ALL_TOOLS.map((tool) => tool.name), ["bash", "read", "write", "glob"]);
  for (const tool of ALL_TOOLS) {
    assert.equal(tool.needsPermission, tool.name === "bash" || tool.name === "write");
  }
});

for (const tool of ALL_TOOLS) {
  test(`${tool.name} schema is strict and rejects unknown, missing, or empty required fields`, () => {
    const ajv = new Ajv({ strict: true });
    const validate = ajv.compile(tool.inputSchema);
    const sample = samples[tool.name]!;
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(validate(sample), true, ajv.errorsText(validate.errors));
    assert.equal(validate({ ...sample, unexpected: true }), false);
    assert.equal(validate({}), false);
    assert.equal(validate(null), false);
    assert.equal(validate([]), false);
    for (const property of tool.inputSchema.required ?? []) {
      if (property === "content") continue;
      assert.equal(validate({ ...sample, [property]: "" }), false);
    }
  });
}

test("read and bash schemas enforce numeric range boundaries", () => {
  const ajv = new Ajv({ strict: true });
  const read = ajv.compile(readTool.inputSchema);
  for (const input of [
    { path: "file.txt", offset: 0, limit: 1 },
    { path: "file.txt", offset: Number.MAX_SAFE_INTEGER, limit: 2000 },
  ]) assert.equal(read(input), true, ajv.errorsText(read.errors));
  for (const input of [
    { path: "file.txt", offset: -1 }, { path: "file.txt", offset: 0.5 },
    { path: "file.txt", offset: Number.MAX_SAFE_INTEGER + 1 },
    { path: "file.txt", limit: 0 }, { path: "file.txt", limit: 2001 },
    { path: "file.txt", limit: 1.5 }, { path: "file.txt", limit: "1" },
  ]) assert.equal(read(input), false);

  const bash = ajv.compile(bashTool.inputSchema);
  for (const timeout of [0.001, 60, 120]) {
    assert.equal(bash({ command: "echo test", timeout }), true, ajv.errorsText(bash.errors));
  }
  for (const timeout of [0, -1, 120.01, Infinity, "5"]) {
    assert.equal(bash({ command: "echo test", timeout }), false);
  }
});