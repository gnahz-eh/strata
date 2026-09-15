import assert from "node:assert/strict";
import { test } from "node:test";

import { Agent } from "../../src/core/agent.js";
import type { Tool } from "../../src/core/tool.js";
import type { CompletionOptions, Message, ModelClient } from "../../src/core/client.js";
import { validateHistory } from "../../src/core/history.js";

const client = { async complete(): Promise<never> { throw new Error("Unexpected request"); } };
const permissions = { async request() { return { allowed: true }; } };
const tool: Tool = {
  name: "example",
  description: "Example tool",
  inputSchema: { type: "object" },
  async run() { return "done"; },
};

test("runtime rejects duplicate and invalid tool registrations", () => {
  const options = { client, permissions, systemPrompt: "test" };
  assert.throws(() => new Agent({ ...options, tools: [tool, { ...tool }] }), /Duplicate tool name/);
  for (const name of ["", "bad.name", "too long ", "x".repeat(65)]) {
    assert.throws(() => new Agent({ ...options, tools: [{ ...tool, name }] }), /Invalid tool name/);
  }
});

test("runtime copies the caller's tool array", () => {
  const tools = [tool];
  const agent = new Agent({ client, permissions, tools, systemPrompt: "test" });
  tools.length = 0;
  assert.equal(agent.tools.length, 1);
});

function answer(calls = false): Message {
  return {
    id: "message", type: "message", role: "assistant", model: "offline",
    content: calls ? [{ type: "tool_use", id: "call", name: "example", input: {} }] : [{ type: "text", text: "done" }],
    stop_reason: calls ? "tool_use" : "end_turn", stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

async function events(agent: Agent, options?: CompletionOptions) {
  const result = [];
  for await (const event of agent.query("test", options)) result.push(event);
  return result;
}

test("invalid input cannot reach permissions or tools", async () => {
  let requests = 0;
  const agent = new Agent({
    client: { async complete() { requests += 1; return answer(requests === 1); } },
    permissions: { async request() { assert.fail("Invalid input reached permission policy"); } },
    tools: [{ ...tool, inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } } }],
    systemPrompt: "test",
  });
  const output = await events(agent);
  const result = output.find((event) => event.kind === "toolResult");
  assert.equal(result?.isError, true);
  assert.match(result?.output ?? "", /Invalid tool input/);
});

test("history is paired and checkpointed before side effects or event consumption", async () => {
  const checkpoints: unknown[] = [];
  let executed = false;
  let requests = 0;
  const agent = new Agent({
    client: { async complete() { requests += 1; return answer(requests === 1); } }, permissions,
    tools: [{ ...tool, async run() {
      assert.equal(checkpoints.length, 2);
      executed = true;
      return "done";
    } }], systemPrompt: "test", checkpoint: async (history) => { checkpoints.push(history); },
  });
  const iterator = agent.query("test");
  assert.equal((await iterator.next()).value?.kind, "assistant");
  assert.equal(executed, false);
  assert.doesNotThrow(() => validateHistory(agent.messages));
  await iterator.return(undefined);
  assert.equal(executed, false);
  assert.match(JSON.stringify(agent.messages), /outcome is unknown/);
  assert.deepEqual((await events(agent)).at(-1), { kind: "end", stopReason: "end_turn" });
});

test("consumer exit after a tool result preserves the completed outcome", async () => {
  const agent = new Agent({ client: { async complete() { return answer(true); } }, permissions, tools: [tool], systemPrompt: "test" });
  for await (const event of agent.query("test")) {
    if (event.kind === "toolResult") break;
  }
  assert.doesNotThrow(() => validateHistory(agent.messages));
  assert.equal(JSON.stringify(agent.messages).includes('"is_error":false'), true);
  const copy = agent.messages;
  copy.length = 0;
  assert.equal(agent.messages.length, 3);
});

test("checkpoint failure prevents tool side effects", async () => {
  let saves = 0;
  const agent = new Agent({
    client: { async complete() { return answer(true); } }, permissions,
    tools: [{ ...tool, async run() { assert.fail("Side effect after failed checkpoint"); } }], systemPrompt: "test",
    checkpoint: async () => { saves += 1; if (saves >= 2) throw new Error("Disk full"); },
  });
  await assert.rejects(() => events(agent), /Disk full/);
});

test("runtime rejects overlapping queries", async () => {
  const agent = new Agent({ client: { async complete() { return answer(); } }, permissions, tools: [], systemPrompt: "test" });
  const iterator = agent.query("first");
  await iterator.next();
  await assert.rejects(() => events(agent), /busy/);
  await iterator.return(undefined);
  assert.equal((await events(agent)).at(-1)?.kind, "end");
});

test("model text is yielded incrementally and cancellation reaches the client", async () => {
  const controller = new AbortController();
  let observed = false;
  const model: ModelClient = { async complete(_messages, _system, _tools, options) {
    options?.onText?.("partial");
    return new Promise<Message>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => { observed = true; reject(options.signal?.reason); }, { once: true });
    });
  } };
  const agent = new Agent({ client: model, permissions, tools: [], systemPrompt: "test" });
  const output = [];
  for await (const event of agent.query("test", { signal: controller.signal })) {
    output.push(event);
    if (event.kind === "textDelta") controller.abort();
  }
  assert.equal(observed, true);
  assert.deepEqual(output, [{ kind: "textDelta", text: "partial" }, { kind: "end", stopReason: "aborted" }]);
});

test("tool cancellation records an error and preserves protocol integrity", async () => {
  const controller = new AbortController();
  const agent = new Agent({
    client: { async complete() { return answer(true); } }, permissions, systemPrompt: "test",
    tools: [{ ...tool, async run(_input, context) {
      controller.abort();
      context?.signal.throwIfAborted();
      return "unreachable";
    } }],
  });
  const output = await events(agent, { signal: controller.signal });
  assert.deepEqual(output.at(-1), { kind: "end", stopReason: "aborted" });
  assert.equal(output.find((event) => event.kind === "toolResult")?.isError, true);
  assert.doesNotThrow(() => validateHistory(agent.messages));
});

test("runtime enforces turn, context, token, and batch budgets", async () => {
  for (const [limits, reason] of [
    [{ maxTurns: 1 }, "max_turns"],
    [{ maxContextBytes: 128 }, "context_limit"],
    [{ maxRunTokens: 1 }, "token_limit"],
  ] as const) {
    const agent = new Agent({ client: { async complete() { return answer(true); } }, permissions, tools: [tool], systemPrompt: "test", limits });
    assert.deepEqual((await events(agent)).at(-1), { kind: "end", stopReason: reason });
    assert.doesNotThrow(() => validateHistory(agent.messages));
  }
  const response = answer(true);
  response.content.push({ type: "tool_use", id: "second", name: "example", input: {} });
  const agent = new Agent({ client: { async complete() { return response; } }, permissions,
    tools: [{ ...tool, async run() { assert.fail("Over-budget tool batch executed"); } }],
    systemPrompt: "test", limits: { maxToolCallsPerTurn: 1 },
  });
  assert.deepEqual((await events(agent)).at(-1), { kind: "end", stopReason: "tool_limit" });
});

test("request timeout stops an unresponsive client", async () => {
  const agent = new Agent({ client: { complete: () => new Promise<Message>(() => {}) }, permissions, tools: [], systemPrompt: "test", limits: { requestTimeoutMs: 20 } });
  await assert.rejects(() => events(agent), /timed out/);
});

test("permission errors and output overflow become bounded tool results", async () => {
  for (const deny of [true, false]) {
    let requests = 0;
    const agent = new Agent({
      client: { async complete() { requests += 1; return answer(requests === 1); } },
      permissions: { async request() { if (deny) throw "Permission unavailable"; return { allowed: true }; } },
      tools: [{ ...tool, async run() { return "\u4e2d".repeat(1000); } }], systemPrompt: "test", limits: { maxToolOutputBytes: 128 },
    });
    const result = (await events(agent)).find((event) => event.kind === "toolResult");
    assert.ok(result);
    assert.equal(result.isError, deny);
    assert.ok(Buffer.byteLength(result.output) <= 128);
    assert.equal(result.output.includes("\ufffd"), false);
  }
});