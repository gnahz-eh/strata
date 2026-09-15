import assert from "node:assert/strict";
import { test } from "node:test";

import type { MessageParam } from "../../src/core/client.js";
import { INTERRUPTED_RESULT } from "../../src/core/history.js";
import { decodeSnapshot, encodeSnapshot, MAX_SESSION_BYTES } from "../../src/sessions/snapshot.js";

const identity = { cwd: "/workspace", provider: "offline", model: "test", toolsHash: "tools-v1" };
const messages: MessageParam[] = [{ role: "user", content: "hello" }];

function envelope(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ version: 1, identity, messages, ...overrides });
}

test("snapshots round trip through a strict versioned envelope and copy state", () => {
  const snapshot = encodeSnapshot(identity, messages);
  assert.deepEqual(JSON.parse(snapshot.serialized), { version: 1, identity, messages });
  assert.deepEqual(snapshot.messages, messages);
  assert.notEqual(snapshot.messages, messages);
  assert.notEqual(snapshot.messages[0], messages[0]);
});

test("snapshots reject malformed envelopes, versions, identities, and histories", () => {
  for (const serialized of [
    "{", "null", "[]", "{}", envelope({ extra: true }), envelope({ version: "1" }),
    envelope({ version: 2 }), envelope({ identity: { ...identity, extra: true } }),
    envelope({ identity: { ...identity, provider: 1 } }), envelope({ messages: {} }),
    envelope({ messages: [{ role: "system", content: "bad" }] }),
    envelope({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "missing" }] }] }),
  ]) {
    assert.throws(() => decodeSnapshot(serialized, identity), /session/i);
  }
  for (const key of ["cwd", "provider", "model", "toolsHash"] as const) {
    assert.throws(() => decodeSnapshot(envelope({ identity: { ...identity, [key]: "other" } }), identity),
      new RegExp(`Incompatible session identity: ${key}`));
  }
  const reordered = { toolsHash: identity.toolsHash, model: identity.model, provider: identity.provider, cwd: identity.cwd };
  assert.deepEqual(decodeSnapshot(envelope({ identity: reordered }), identity), messages);
});

test("recovery repairs only terminal unanswered tool calls", () => {
  const pending: MessageParam[] = [{ role: "assistant", content: [
    { type: "tool_use", id: "first", name: "example", input: {} },
    { type: "tool_use", id: "second", name: "example", input: {} },
  ] }];
  assert.throws(() => decodeSnapshot(envelope({ messages: pending }), identity), /unanswered/);
  const repaired = decodeSnapshot(envelope({ messages: pending }), identity, true);
  assert.deepEqual(repaired, [...pending, { role: "user", content: [
    { type: "tool_result", tool_use_id: "first", content: INTERRUPTED_RESULT, is_error: true },
    { type: "tool_result", tool_use_id: "second", content: INTERRUPTED_RESULT, is_error: true },
  ] }]);
  assert.equal(pending.length, 1);
  assert.throws(() => decodeSnapshot(envelope({ messages: [...pending, ...messages] }), identity, true), /unmatched/);
});

test("snapshots enforce a byte limit and reject lossy non-JSON values", () => {
  assert.throws(() => decodeSnapshot(" ".repeat(MAX_SESSION_BYTES + 1), identity), /16 MiB/);
  assert.throws(() => encodeSnapshot(identity, [{ role: "user", content: "\u00e9".repeat(MAX_SESSION_BYTES / 2) }]), /16 MiB/);
  for (const input of [{ value: undefined }, { value: Infinity }, new Map([["key", "value"]]), new Date(0)]) {
    const history: MessageParam[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "call", name: "example", input }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: "done" }] },
    ];
    assert.throws(() => encodeSnapshot(identity, history), /JSON/);
  }
});

test("the size bound includes the entire UTF-8 envelope and final newline", () => {
  const overhead = Buffer.byteLength(encodeSnapshot(identity, [{ role: "user", content: "" }]).serialized);
  const content = "a".repeat(MAX_SESSION_BYTES - overhead);
  const snapshot = encodeSnapshot(identity, [{ role: "user", content }]);
  assert.equal(Buffer.byteLength(snapshot.serialized), MAX_SESSION_BYTES);
  assert.deepEqual(snapshot.messages, [{ role: "user", content }]);
  assert.throws(() => encodeSnapshot(identity, [{ role: "user", content: content + "a" }]), /16 MiB/);
});