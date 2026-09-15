import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClientOptions } from "@anthropic-ai/sdk";

import { Client, toApiSchema } from "../../src/providers/anthropic.js";
import { Agent } from "../../src/core/agent.js";
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

type SdkResponse = Awaited<ReturnType<NonNullable<ClientOptions["fetch"]>>>;

function response(calls = false, truncated = false): SdkResponse {
  const events = [
    { type: "message_start", message: {
      id: "msg_offline", type: "message", role: "assistant", model: "offline-model",
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, output_tokens: 0 },
    } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
    { type: "content_block_stop", index: 0 },
    ...(calls ? [
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call_read", name: "read", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"README.md"}' } },
      { type: "content_block_stop", index: 1 },
    ] : []),
    { type: "message_delta", delta: { stop_reason: truncated ? "max_tokens" : calls ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } },
    { type: "message_stop" },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "Content-Type": "text/event-stream" },
  }) as unknown as SdkResponse;
}

test("Anthropic streams text and tool arguments through the SDK without terminal writes", async () => {
  const requests: Record<string, any>[] = [];
  const client = new Client("offline-model", 512, {
    apiKey: "offline-test-key", baseURL: "https://anthropic.invalid", maxRetries: 0,
    fetch: async (_url, init) => {
      assert.equal(typeof init?.body, "string");
      requests.push(JSON.parse(init!.body as string));
      return response(requests.length === 1);
    },
  });
  const read = ALL_TOOLS.find((tool) => tool.name === "read")!;
  const agent = new Agent({ client, tools: [{ ...read, async run(input: { path: string }) {
    assert.equal(input.path, "README.md");
    return "Offline file";
  } }], permissions: { async request() { return { allowed: true }; } }, systemPrompt: "System" });
  const output = [];
  for await (const event of agent.query("Read the file")) output.push(event);
  assert.deepEqual(output.filter((event) => event.kind === "textDelta").map((event) => event.text), ["Hello", "Hello"]);
  assert.deepEqual(output.at(-1), { kind: "end", stopReason: "end_turn" });
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.max_tokens, 512);
  assert.equal(requests[0]?.model, "offline-model");
  assert.deepEqual(requests[1]?.messages[2], { role: "user", content: [{
    type: "tool_result", tool_use_id: "call_read", content: "Offline file", is_error: false,
  }] });
  assert.deepEqual(output.filter((event) => event.kind === "assistant")[0]?.message.usage, { input_tokens: 8, output_tokens: 4 });
});

test("Anthropic truncation does not expose incomplete tool calls for execution", async () => {
  const client = new Client("offline-model", 512, {
    apiKey: "offline-test-key", baseURL: "https://anthropic.invalid", maxRetries: 0,
    fetch: async () => response(true, true),
  });
  const result = await client.complete([{ role: "user", content: "test" }], "System", ALL_TOOLS);
  assert.equal(result.stop_reason, "max_tokens");
  assert.deepEqual(result.content, [{ type: "text", text: "Hello" }]);
});

test("Anthropic propagates AbortSignal into an in-flight SDK request", { timeout: 5000 }, async () => {
  const controller = new AbortController();
  let started: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let observed = false;
  const client = new Client("offline-model", 512, {
    apiKey: "offline-test-key", baseURL: "https://anthropic.invalid", maxRetries: 0,
    fetch: async (_url, init) => {
      started?.();
      return new Promise<SdkResponse>((_resolve, reject) => {
        const signal = init?.signal;
        const abort = () => { observed = true; reject(new DOMException("Aborted", "AbortError")); };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    },
  });
  const request = client.complete([{ role: "user", content: "test" }], "System", [], { signal: controller.signal });
  const rejected = assert.rejects(request, /abort/i);
  await ready;
  controller.abort();
  await rejected;
  assert.equal(observed, true);
});