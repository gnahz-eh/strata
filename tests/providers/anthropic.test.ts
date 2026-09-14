import assert from "node:assert/strict";
import { test } from "node:test";

import { toApiSchema } from "../../src/providers/anthropic.js";
import { ALL_TOOLS } from "../../src/tools/index.js";

test("built-in tool registration preserves names and ordering", () => {
  assert.deepEqual(ALL_TOOLS.map((tool) => tool.name), ["bash", "read", "write", "glob"]);
  assert.equal(new Set(ALL_TOOLS.map((tool) => tool.name)).size, ALL_TOOLS.length);
});

test("Anthropic schemas contain object inputs but no executable implementation or permission policy", () => {
  for (const tool of ALL_TOOLS) {
    const schema = toApiSchema(tool);
    assert.deepEqual(Object.keys(schema), ["name", "description", "input_schema"]);
    assert.equal(schema.name, tool.name);
    assert.equal(schema.description, tool.description);
    assert.equal(schema.input_schema, tool.inputSchema);
    assert.equal(schema.input_schema.type, "object");
  }
});