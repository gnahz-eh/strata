import assert from "node:assert/strict";
import { test } from "node:test";

import { Agent, type RuntimeLimits } from "../../src/core/agent.js";
import type { Message } from "../../src/core/client.js";
import type { Tool } from "../../src/core/tool.js";

const tool: Tool = { name: "example", description: "Example", inputSchema: { type: "object" }, async run() { return "done"; } };
const permissions = { async request() { return { allowed: true }; } };
function answer(calls = false): Message {
  return { id: "message", type: "message", role: "assistant", model: "offline",
    content: calls ? [{ type: "tool_use", id: "call", name: "example", input: {} }] : [{ type: "text", text: "done" }],
    stop_reason: calls ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
}
async function collect(agent: Agent) {
  const output = [];
  for await (const event of agent.query("test")) output.push(event);
  return output;
}

test("runtime rejects async schemas and tool name controls", () => {
  const options = { client: { async complete() { return answer(); } }, permissions, systemPrompt: "test" };
  assert.throws(() => new Agent({ ...options, tools: [{ ...tool, inputSchema: { type: "object", $async: true } }] }), /synchronous/);
  assert.throws(() => new Agent({ ...options, tools: [{ ...tool, name: "example\n" }] }), /Invalid tool name/);
});

test("persistence failure blocks subsequent side effects", async () => {
  const agent = new Agent({ client: { async complete() { return answer(); } }, permissions, tools: [], systemPrompt: "test",
    checkpoint: async () => { throw new Error("Disk full"); },
  });
  await assert.rejects(() => collect(agent), /Disk full/);
  await assert.rejects(() => collect(agent), /persistence failed/);
});

test("terminal event follows the last required checkpoint", async () => {
  let saved = 0;
  const agent = new Agent({ client: { async complete() { return answer(); } }, permissions, tools: [], systemPrompt: "test",
    checkpoint: async () => { saved += 1; if (saved > 2) throw new Error("Unexpected redundant checkpoint"); },
  });
  assert.deepEqual((await collect(agent)).at(-1), { kind: "end", stopReason: "end_turn" });
  assert.equal(saved, 2);
});

test("cancellation at a final assistant yield does not report success", async () => {
  const controller = new AbortController();
  const agent = new Agent({ client: { async complete() { return answer(); } }, permissions, tools: [], systemPrompt: "test" });
  const output = [];
  for await (const event of agent.query("test", { signal: controller.signal })) {
    output.push(event);
    if (event.kind === "assistant") controller.abort();
  }
  assert.deepEqual(output.at(-1), { kind: "end", stopReason: "aborted" });
});

test("validation and denial failures obey the output budget", async () => {
  for (const invalid of [true, false]) {
    let requests = 0;
    const agent = new Agent({
      client: { async complete() { requests += 1; return answer(requests === 1); } },
      permissions: { async request() { return { allowed: false, reason: "long".repeat(1000) }; } },
      tools: [{ ...tool, inputSchema: invalid ? {
        type: "object", properties: Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`field${index}`, { type: "string" }])),
        required: Array.from({ length: 30 }, (_, index) => `field${index}`),
      } : tool.inputSchema }], systemPrompt: "test", limits: { maxToolOutputBytes: 128 },
    });
    const result = (await collect(agent)).find((event) => event.kind === "toolResult");
    assert.ok(result?.isError);
    assert.ok(Buffer.byteLength(result.output) <= 128);
  }
});

test("a client ignoring cancellation keeps runtime busy until settlement", async () => {
  let release: ((message: Message) => void) | undefined;
  const agent = new Agent({ client: { complete: () => new Promise<Message>((resolve) => { release = resolve; }) },
    permissions, tools: [], systemPrompt: "test", limits: { requestTimeoutMs: 20 },
  });
  await assert.rejects(() => collect(agent), /timed out/);
  assert.equal(agent.hasPendingOperations, true);
  await assert.rejects(() => collect(agent), /busy/);
  release?.(answer());
  await agent.waitForIdle();
  assert.equal(agent.hasPendingOperations, false);
});

test("unknown runtime budget keys fail closed for JavaScript callers", () => {
  assert.throws(() => new Agent({
    client: { async complete() { return answer(); } }, permissions, tools: [], systemPrompt: "test",
    limits: { maxTurns: 1, maxTurn: 1 } as Partial<RuntimeLimits>,
  }), /Unknown runtime limit: maxTurn/);
});