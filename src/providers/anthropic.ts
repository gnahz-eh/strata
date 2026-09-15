import Anthropic, { type ClientOptions } from "@anthropic-ai/sdk";

import type { CompletionOptions, ModelClient, Message, MessageParam } from "../core/client.js";
import type { Tool } from "../core/tool.js";

export const DEFAULT_MODEL = "claude-sonnet-4-6";
export const DEFAULT_MAX_TOKENS = 8192;

export function toApiSchema(tool: Tool): Anthropic.Messages.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  };
}

export class Client implements ModelClient {
  private client: Anthropic;

  constructor(
    public readonly model: string = process.env.STRATA_MODEL ?? DEFAULT_MODEL,
    public readonly maxTokens: number = DEFAULT_MAX_TOKENS,
    options: ClientOptions = {},
  ) {
    this.client = new Anthropic({ timeout: 120_000, maxRetries: 2, ...options });
  }

  async complete(
    messages: MessageParam[],
    system: string,
    tools: Tool[],
    options: CompletionOptions = {},
  ): Promise<Message> {
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: this.maxTokens,
      system,
      tools: tools.map(toApiSchema),
      messages,
    }, { signal: options.signal });

    stream.on("text", (textDelta: string) => {
      options.onText?.(textDelta);
    });

    const final = await stream.finalMessage();
    return {
      id: final.id,
      type: "message",
      role: "assistant",
      model: final.model,
      content: final.content.filter((block) => block.type === "text" || final.stop_reason === "tool_use"),
      stop_reason: final.stop_reason,
      stop_sequence: final.stop_sequence,
      usage: { input_tokens: final.usage.input_tokens, output_tokens: final.usage.output_tokens },
    };
  }
}