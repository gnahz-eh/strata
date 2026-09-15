import { Ajv } from "ajv";

import type { MessageParam, ToolUseBlock } from "./client.js";

export const INTERRUPTED_RESULT = "Execution interrupted before its result was recorded. The outcome is unknown; inspect the workspace before repeating any side effect.";

const text = {
  type: "object", additionalProperties: false, required: ["type", "text"],
  properties: { type: { const: "text" }, text: { type: "string" } },
};
const toolUse = {
  type: "object", additionalProperties: false, required: ["type", "id", "name", "input"],
  properties: {
    type: { const: "tool_use" }, id: { type: "string", minLength: 1, maxLength: 256 },
    name: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,64}(?![\\s\\S])" }, input: {},
  },
};
const result = {
  type: "object", additionalProperties: false, required: ["type", "tool_use_id"],
  properties: {
    type: { const: "tool_result" }, tool_use_id: { type: "string", minLength: 1, maxLength: 256 },
    content: { anyOf: [{ type: "string" }, { type: "array", items: text }] }, is_error: { type: "boolean" },
  },
};
const validate = new Ajv({ allErrors: true }).compile({
  type: "array",
  items: {
    type: "object", additionalProperties: false, required: ["role", "content"],
    properties: {
      role: { enum: ["user", "assistant"] },
      content: { anyOf: [{ type: "string" }, { type: "array", items: { anyOf: [text, toolUse, result] } }] },
    },
  },
});

export function validateHistory(value: unknown, repair = false): MessageParam[] {
  if (!validate(value)) throw new Error("Invalid session message format.");
  const messages = structuredClone(value) as MessageParam[];
  let pending: ToolUseBlock[] = [];
  for (const message of messages) {
    const blocks = typeof message.content === "string" ? [] : message.content;
    const calls = blocks.filter((block) => block.type === "tool_use");
    const results = blocks.filter((block) => block.type === "tool_result");
    if (message.role === "user" && calls.length || message.role === "assistant" && results.length) {
      throw new Error("Invalid tool block role in session.");
    }
    if (pending.length) {
      if (message.role !== "user" || results.length !== pending.length ||
          results.some((block, index) => block.tool_use_id !== pending[index]?.id)) {
        throw new Error("Session has unmatched tool calls or results.");
      }
      pending = [];
    } else if (results.length) {
      throw new Error("Session has unexpected tool results.");
    }
    if (new Set(calls.map((call) => call.id)).size !== calls.length) {
      throw new Error("Session has duplicate tool call IDs.");
    }
    pending = calls;
  }
  if (pending.length) {
    if (!repair) throw new Error("Session has unanswered tool calls.");
    messages.push({ role: "user", content: pending.map((call) => ({
      type: "tool_result", tool_use_id: call.id, content: INTERRUPTED_RESULT, is_error: true,
    })) });
  }
  return messages;
}