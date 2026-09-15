import OpenAI, { type ClientOptions } from "openai";
import type {
  ChatCompletion,
  ChatCompletionFunctionTool,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";

import type { CompletionOptions, ModelClient, Message, MessageParam, ToolResultBlockParam } from "../core/client.js";
import type { Tool } from "../core/tool.js";

export const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";
export const DEFAULT_OPENAI_MAX_TOKENS = 8192;

export function toOpenAITool(tool: Tool): ChatCompletionFunctionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      strict: false,
    },
  };
}

function toolResultText(result: ToolResultBlockParam): string {
  const content = result.content ?? "";
  const text = typeof content === "string" ? content : content.map((block) => {
    if (block.type !== "text") {
      throw new Error(`OpenAI adapter does not support tool result block: ${block.type}`);
    }
    return block.text;
  }).join("\n");
  return result.is_error ? `Tool error: ${text}` : text;
}

export function toOpenAIMessages(messages: MessageParam[], system: string): ChatCompletionMessageParam[] {
  const converted: ChatCompletionMessageParam[] = [{ role: "system", content: system }];

  for (const message of messages) {
    if (typeof message.content === "string") {
      converted.push({ role: message.role, content: message.content });
      continue;
    }

    const text: string[] = [];
    const toolCalls: ChatCompletionMessageFunctionToolCall[] = [];
    for (const block of message.content) {
      if (block.type === "text") {
        text.push(block.text);
      } else if (message.role === "assistant" && block.type === "tool_use") {
        toolCalls.push({
          type: "function",
          id: block.id,
          function: { name: block.name, arguments: JSON.stringify(block.input) },
        });
      } else if (message.role === "user" && block.type === "tool_result") {
        converted.push({ role: "tool", tool_call_id: block.tool_use_id, content: toolResultText(block) });
      } else {
        throw new Error(`OpenAI adapter does not support ${message.role} content block: ${block.type}`);
      }
    }

    if (message.role === "assistant") {
      converted.push({
        role: "assistant",
        content: text.join("\n") || (toolCalls.length > 0 ? null : ""),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    } else if (text.length > 0) {
      converted.push({ role: "user", content: text.join("\n") });
    }
  }

  return converted;
}

export function fromOpenAICompletion(completion: ChatCompletion): Message {
  const choice = completion.choices[0];
  if (!choice) throw new Error("OpenAI returned no completion choices.");
  if (choice.finish_reason === "content_filter") {
    throw new Error("OpenAI response was blocked by the content filter.");
  }
  if (choice.finish_reason === "function_call") {
    throw new Error("OpenAI returned a deprecated function_call response.");
  }

  const content: Message["content"] = [];
  if (choice.message.content) content.push({ type: "text", text: choice.message.content });
  if (choice.message.refusal) content.push({ type: "text", text: choice.message.refusal });

  if (choice.finish_reason === "tool_calls") {
    if (!choice.message.tool_calls?.length) {
      throw new Error("OpenAI ended with tool_calls but returned no tool calls.");
    }
    for (const call of choice.message.tool_calls) {
      if (call.type !== "function") {
        throw new Error(`OpenAI returned an unsupported tool call type: ${call.type}`);
      }
      let input: unknown;
      try {
        input = JSON.parse(call.function.arguments);
      } catch {
        throw new Error(`OpenAI returned invalid JSON arguments for tool: ${call.function.name}`);
      }
      if (input === null || typeof input !== "object" || Array.isArray(input)) {
        throw new Error(`OpenAI tool arguments must be an object: ${call.function.name}`);
      }
      content.push({ type: "tool_use", id: call.id, name: call.function.name, input });
    }
  }

  return {
    id: completion.id,
    type: "message",
    role: "assistant",
    model: completion.model,
    content,
    stop_reason: choice.finish_reason === "tool_calls" ? "tool_use"
      : choice.finish_reason === "length" ? "max_tokens" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: completion.usage?.prompt_tokens ?? 0,
      output_tokens: completion.usage?.completion_tokens ?? 0,
    },
  };
}

export class OpenAIClient implements ModelClient {
  private client: OpenAI;

  constructor(
    public readonly model: string = process.env.STRATA_MODEL ?? DEFAULT_OPENAI_MODEL,
    public readonly maxTokens: number = DEFAULT_OPENAI_MAX_TOKENS,
    options: ClientOptions = {},
  ) {
    this.client = new OpenAI({ timeout: 120_000, maxRetries: 2, ...options });
  }

  async complete(messages: MessageParam[], system: string, tools: Tool[], options: CompletionOptions = {}): Promise<Message> {
    const stream = this.client.chat.completions.stream({
      model: this.model,
      max_completion_tokens: this.maxTokens,
      messages: toOpenAIMessages(messages, system),
      ...(tools.length > 0 ? { tools: tools.map(toOpenAITool) } : {}),
      stream_options: { include_usage: true },
      store: false,
    }, { signal: options.signal });

    stream.on("content", (delta) => options.onText?.(delta));
    stream.on("refusal.delta", ({ delta }) => options.onText?.(delta));

    const completion = await stream.finalChatCompletion();
    return fromOpenAICompletion(completion);
  }
}