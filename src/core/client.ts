import type Anthropic from "@anthropic-ai/sdk";

import type { Tool } from "./tool.js";

export type Message = Anthropic.Messages.Message;
export type MessageParam = Anthropic.Messages.MessageParam;
export type ToolResultBlockParam = Anthropic.Messages.ToolResultBlockParam;

export interface ModelClient {
  complete(messages: MessageParam[], system: string, tools: Tool[]): Promise<Message>;
}