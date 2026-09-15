import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessage,
} from "openai/resources/chat/completions";

import { Agent } from "../../src/core/agent.js";
import type { MessageParam } from "../../src/core/client.js";
import type { Tool } from "../../src/core/tool.js";
import { fromOpenAICompletion, OpenAIClient, toOpenAIMessages, toOpenAITool } from "../../src/providers/openai.js";
import { readTool } from "../../src/tools/read.js";

function completion(
  finishReason: ChatCompletion.Choice["finish_reason"] = "stop",
  message: Partial<ChatCompletionMessage> = {},
): ChatCompletion {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 0,
    model: "gpt-4.1-mini",
    choices: [{
      index: 0,
      finish_reason: finishReason,
      logprobs: null,
      message: { role: "assistant", content: "Hello", refusal: null, ...message },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function chunk(
  delta: ChatCompletionChunk.Choice.Delta,
  finishReason: ChatCompletionChunk.Choice["finish_reason"] = null,
): ChatCompletionChunk {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 0,
    model: "gpt-4.1-mini",
    choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
  };
}

function streamResponse(chunks: ChatCompletionChunk[]): Response {
  const data = chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("");
  return new Response(`${data}data: [DONE]\n\n`, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

test("OpenAI preserves text history and converts batched results to tool messages", () => {
  assert.deepEqual(toOpenAIMessages([
    { role: "user", content: "Inspect files" },
    { role: "assistant", content: [
      { type: "text", text: "Reading files" },
      { type: "tool_use", id: "call_one", name: "read", input: { path: "one.txt" } },
      { type: "tool_use", id: "call_two", name: "read", input: { path: "two.txt" } },
    ] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "call_one", content: "First file" },
      { type: "tool_result", tool_use_id: "call_two", content: [{ type: "text", text: "Denied" }], is_error: true },
      { type: "text", text: "Continue with the first file" },
    ] },
    { role: "assistant", content: "Summary" },
  ], "System instructions"), [
    { role: "system", content: "System instructions" },
    { role: "user", content: "Inspect files" },
    { role: "assistant", content: "Reading files", tool_calls: [
      { type: "function", id: "call_one", function: { name: "read", arguments: '{"path":"one.txt"}' } },
      { type: "function", id: "call_two", function: { name: "read", arguments: '{"path":"two.txt"}' } },
    ] },
    { role: "tool", tool_call_id: "call_one", content: "First file" },
    { role: "tool", tool_call_id: "call_two", content: "Tool error: Denied" },
    { role: "user", content: "Continue with the first file" },
    { role: "assistant", content: "Summary" },
  ]);
});

test("OpenAI declares function schemas without forcing optional arguments to be required", () => {
  assert.deepEqual(toOpenAITool(readTool), {
    type: "function",
    function: {
      name: "read",
      description: readTool.description,
      parameters: readTool.inputSchema,
      strict: false,
    },
  });
});

test("OpenAI rejects unsupported content instead of silently dropping it", () => {
  assert.throws(() => toOpenAIMessages([{ role: "user", content: [{
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "test" },
  }] }] as unknown as MessageParam[], "System"), /does not support user content block: image/);
});

test("OpenAI normalizes text, usage, and completed function calls", () => {
  const text = fromOpenAICompletion(completion());
  assert.equal(text.stop_reason, "end_turn");
  assert.deepEqual(text.content, [{ type: "text", text: "Hello" }]);
  assert.deepEqual(text.usage, { input_tokens: 10, output_tokens: 5 });

  const calls = fromOpenAICompletion(completion("tool_calls", {
    content: null,
    tool_calls: [{ type: "function", id: "call_read", function: { name: "read", arguments: '{"path":"README.md"}' } }],
  }));
  assert.equal(calls.stop_reason, "tool_use");
  assert.deepEqual(calls.content, [{ type: "tool_use", id: "call_read", name: "read", input: { path: "README.md" } }]);
});

test("OpenAI exposes refusals as text and does not execute truncated tool calls", () => {
  const refusal = fromOpenAICompletion(completion("stop", { content: null, refusal: "Cannot comply" }));
  assert.deepEqual(refusal.content, [{ type: "text", text: "Cannot comply" }]);
  assert.equal(refusal.stop_reason, "end_turn");

  const truncated = fromOpenAICompletion(completion("length", {
    content: "Partial response",
    tool_calls: [{ type: "function", id: "call_read", function: { name: "read", arguments: '{"path":' } }],
  }));
  assert.equal(truncated.stop_reason, "max_tokens");
  assert.deepEqual(truncated.content, [{ type: "text", text: "Partial response" }]);
});

test("OpenAI rejects malformed and non-object tool arguments", () => {
  for (const args of ['{"path":', "null", "[]", "42", '"text"']) {
    assert.throws(() => fromOpenAICompletion(completion("tool_calls", {
      tool_calls: [{ type: "function", id: "call_read", function: { name: "read", arguments: args } }],
    })), /invalid JSON arguments|arguments must be an object/);
  }
  assert.throws(() => fromOpenAICompletion(completion("tool_calls", { tool_calls: [] })), /returned no tool calls/);
});

test("OpenAI surfaces missing choices and filtered responses", () => {
  assert.throws(() => fromOpenAICompletion({ ...completion(), choices: [] }), /no completion choices/);
  assert.throws(() => fromOpenAICompletion(completion("content_filter")), /content filter/);
  assert.throws(() => fromOpenAICompletion(completion("function_call")), /deprecated function_call/);
});

test("OpenAI streams through the SDK and completes a multi-tool Agent round trip offline", async () => {
  const requests: ChatCompletionCreateParamsStreaming[] = [];
  const responses = [
    [
      chunk({ role: "assistant", content: "Reading files" }),
      chunk({ tool_calls: [{ index: 0, type: "function", id: "call_one", function: { name: "read", arguments: '{"path":' } }] }),
      chunk({ tool_calls: [
        { index: 0, function: { arguments: '"one.txt"}' } },
        { index: 1, type: "function", id: "call_two", function: { name: "read", arguments: '{"path":"two.txt"}' } },
      ] }),
      chunk({}, "tool_calls"),
    ],
    [
      chunk({ role: "assistant", content: "Sum" }),
      chunk({ content: "mary" }),
      chunk({}, "stop"),
      { ...chunk({}), choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ],
  ];
  const client = new OpenAIClient("gpt-4.1-mini", 512, {
    apiKey: "offline-test-key",
    baseURL: "https://openai.invalid/v1",
    maxRetries: 0,
    fetch: async (_url, init) => {
      const body = init?.body;
      assert.ok(typeof body === "string", "Expected a JSON request body");
      requests.push(JSON.parse(body));
      const next = responses.shift();
      assert.ok(next, "Unexpected OpenAI request");
      return streamResponse(next);
    },
  });
  const executed: unknown[] = [];
  const tool: Tool = {
    ...readTool,
    async run(input: unknown) {
      executed.push(input);
      return "File content";
    },
  };
  const agent = new Agent({
    client,
    tools: [tool],
    permissions: { request: async () => ({ allowed: true }) },
    systemPrompt: "Offline system",
  });
  const output: string[] = [];
  const events = [];
  for await (const event of agent.query("Inspect files", { onText: (delta) => output.push(delta) })) events.push(event);

  assert.equal(output.join(""), "Reading filesSummary");
  assert.deepEqual(executed, [{ path: "one.txt" }, { path: "two.txt" }]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.model, "gpt-4.1-mini");
  assert.equal(requests[0]?.max_completion_tokens, 512);
  assert.equal(requests[0]?.stream, true);
  assert.equal(requests[0]?.store, false);
  assert.deepEqual(requests[0]?.tools, [toOpenAITool(tool)]);
  assert.deepEqual(requests[1]?.messages.map((message) => message.role), ["system", "user", "assistant", "tool", "tool"]);
  assert.deepEqual(requests[1]?.messages.slice(-2), [
    { role: "tool", tool_call_id: "call_one", content: "File content" },
    { role: "tool", tool_call_id: "call_two", content: "File content" },
  ]);
  assert.deepEqual(events.at(-1), { kind: "end", stopReason: "end_turn" });
  const lastAssistant = events.filter((event) => event.kind === "assistant").at(-1);
  assert.deepEqual(lastAssistant?.message.usage, { input_tokens: 10, output_tokens: 5 });
});

test("OpenAI propagates SDK request errors without executing tools", async () => {
  const client = new OpenAIClient("gpt-4.1-mini", 512, {
    apiKey: "offline-test-key",
    baseURL: "https://openai.invalid/v1",
    maxRetries: 0,
    fetch: async () => new Response(JSON.stringify({ error: { message: "Invalid request" } }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    }),
  });
  await assert.rejects(() => client.complete([{ role: "user", content: "Hello" }], "System", []), /Invalid request/);
});