import Anthropic from "@anthropic-ai/sdk";

import type { ModelClient, Message, MessageParam } from "../core/client.js";
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
  ) {
    this.client = new Anthropic();
  }

  async complete(
    messages: MessageParam[],
    system: string,
    tools: Tool[],
  ): Promise<Message> {
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: this.maxTokens,
      system,
      tools: tools.map(toApiSchema),
      messages,
    });

    stream.on("text", (textDelta: string) => {
      process.stdout.write(textDelta);
    });

    const final = await stream.finalMessage();
    process.stdout.write("\n");
    return final;
  }
}