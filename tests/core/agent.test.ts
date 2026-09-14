import assert from "node:assert/strict";
import { test } from "node:test";

import { Agent, type AgentOptions } from "../../src/core/agent.js";

type Message = Awaited<ReturnType<AgentOptions["client"]["complete"]>>;
type Messages = Parameters<AgentOptions["client"]["complete"]>[0];

function response(stopReason: Message["stop_reason"], content: Message["content"] = []): Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "offline-test",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

function createAgent(
  responses: Message[],
  tools: AgentOptions["tools"] = [],
  request: AgentOptions["permissions"]["request"] = async () => ({ allowed: true }),
) {
  const requests: Messages[] = [];
  const client = {
    async complete(messages: Messages) {
      requests.push(structuredClone(messages));
      const next = responses.shift();
      assert.ok(next, "Unexpected model request");
      return next;
    },
  };
  const agent = new Agent({
    client,
    permissions: { request },
    tools,
    systemPrompt: "Offline test",
  });
  return { agent, requests };
}

async function collect(agent: Agent, prompt = "Test prompt") {
  const events = [];
  for await (const event of agent.query(prompt)) events.push(event);
  return events;
}

test("preserves conversation history across user turns", async () => {
  const { agent, requests } = createAgent([
    response("end_turn", [{ type: "text", text: "First answer" }]),
    response("end_turn", [{ type: "text", text: "Second answer" }]),
  ]);

  const events = await collect(agent, "First question");
  assert.deepEqual(events.map((event) => event.kind), ["assistant", "end"]);
  await collect(agent, "Second question");

  assert.deepEqual(requests[1], [
    { role: "user", content: "First question" },
    { role: "assistant", content: [{ type: "text", text: "First answer" }] },
    { role: "user", content: "Second question" },
  ]);
});

test("executes tools serially and batches matching results in one user message", async () => {
  const operations: string[] = [];
  const tools = ["first", "second"].map<AgentOptions["tools"][number]>((name) => ({
    name,
    description: name,
    inputSchema: { type: "object" },
    async run() {
      operations.push(`start:${name}`);
      await Promise.resolve();
      operations.push(`end:${name}`);
      return `${name} result`;
    },
  }));
  const { agent, requests } = createAgent([
    response("tool_use", [
      { type: "tool_use", id: "call_first", name: "first", input: {} },
      { type: "tool_use", id: "call_second", name: "second", input: {} },
    ]),
    response("end_turn"),
  ], tools);

  const events = await collect(agent);

  assert.deepEqual(operations, ["start:first", "end:first", "start:second", "end:second"]);
  assert.deepEqual(events.map((event) => event.kind), [
    "assistant", "toolCall", "toolResult", "toolCall", "toolResult", "assistant", "end",
  ]);
  assert.equal(requests.length, 2);
  assert.equal(requests[1]?.length, 3);
  assert.deepEqual(requests[1]?.[2], {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "call_first", content: "first result", is_error: false },
      { type: "tool_result", tool_use_id: "call_second", content: "second result", is_error: false },
    ],
  });
});

test("returns tool errors for unknown, denied, and throwing tools", async () => {
  const requested: string[] = [];
  const { agent, requests } = createAgent([
    response("tool_use", [
      { type: "tool_use", id: "call_unknown", name: "unknown", input: {} },
      { type: "tool_use", id: "call_denied", name: "denied", input: {} },
      { type: "tool_use", id: "call_throwing", name: "throwing", input: {} },
    ]),
    response("end_turn"),
  ], [
    {
      name: "denied",
      description: "Must not execute",
      inputSchema: { type: "object" },
      async run() {
        assert.fail("Denied tool was executed");
      },
    },
    {
      name: "throwing",
      description: "Throws an error",
      inputSchema: { type: "object" },
      async run() {
        throw new Error("Tool failed");
      },
    },
  ], async (tool) => {
    requested.push(tool.name);
    return { allowed: tool.name !== "denied", reason: "Test policy" };
  });

  const events = await collect(agent);
  const results = events.filter((event) => event.kind === "toolResult");

  assert.deepEqual(requested, ["denied", "throwing"]);
  assert.deepEqual(results.map((event) => [event.name, event.isError, event.output]), [
    ["unknown", true, "Unknown tool: unknown"],
    ["denied", true, "Permission denied (Test policy)."],
    ["throwing", true, "Error: Tool failed"],
  ]);
  assert.equal(requests.length, 2);
});

test("ends the turn for non-tool stop reasons", async () => {
  for (const stopReason of ["end_turn", "max_tokens", "stop_sequence", null] as const) {
    const { agent, requests } = createAgent([response(stopReason)]);
    const events = await collect(agent);
    assert.deepEqual(events.map((event) => event.kind), ["assistant", "end"]);
    assert.deepEqual(events.at(-1), { kind: "end", stopReason });
    assert.equal(requests.length, 1);
  }
});