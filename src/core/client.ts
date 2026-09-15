import type { Tool } from "./tool.js";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlockParam {
  type: "tool_result";
  tool_use_id: string;
  content?: string | TextBlock[];
  is_error?: boolean;
}

export interface MessageParam {
  role: "user" | "assistant";
  content: string | (TextBlock | ToolUseBlock | ToolResultBlockParam)[];
}

export interface Message {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: (TextBlock | ToolUseBlock)[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | null;
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

export interface CompletionOptions {
  signal?: AbortSignal;
  onText?: (delta: string) => void;
}

export interface ModelClient {
  complete(messages: MessageParam[], system: string, tools: Tool[], options?: CompletionOptions): Promise<Message>;
}