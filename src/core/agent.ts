import type { ModelClient, Message, MessageParam, ToolResultBlockParam } from "./client.js";
import type { PermissionPolicy } from "./permissions.js";
import type { Tool } from "./tool.js";

export type Event =
  | { kind: "assistant"; message: Message }
  | { kind: "toolCall"; name: string; input: unknown; toolUseId: string }
  | { kind: "toolResult"; toolUseId: string; name: string; output: string; isError: boolean }
  | { kind: "end"; stopReason: Message["stop_reason"] };

export interface AgentOptions {
  client: ModelClient;
  tools: Tool[];
  permissions: PermissionPolicy;
  systemPrompt: string;
}

export class Agent {
  readonly client: ModelClient;
  readonly tools: Tool[];
  readonly toolsByName: Map<string, Tool>;
  readonly permissions: PermissionPolicy;
  readonly systemPrompt: string;
  readonly messages: MessageParam[] = [];

  constructor(opts: AgentOptions) {
    this.client = opts.client;
    this.tools = opts.tools;
    this.toolsByName = new Map(opts.tools.map((tool) => [tool.name, tool]));
    this.permissions = opts.permissions;
    this.systemPrompt = opts.systemPrompt;
  }

  async *query(userInput: string): AsyncGenerator<Event> {
    this.messages.push({ role: "user", content: userInput });

    while (true) {
      const response = await this.client.complete(this.messages, this.systemPrompt, this.tools);
      this.messages.push({ role: "assistant", content: response.content });
      yield { kind: "assistant", message: response };

      if (response.stop_reason !== "tool_use") {
        yield { kind: "end", stopReason: response.stop_reason };
        return;
      }

      const toolResults: ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;

        yield {
          kind: "toolCall",
          name: block.name,
          input: block.input,
          toolUseId: block.id,
        };

        const { output, isError } = await this.runOne(block.name, block.input);
        yield {
          kind: "toolResult",
          toolUseId: block.id,
          name: block.name,
          output,
          isError,
        };

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output,
          is_error: isError,
        });
      }

      this.messages.push({ role: "user", content: toolResults });
    }
  }

  private async runOne(
    name: string,
    input: unknown,
  ): Promise<{ output: string; isError: boolean }> {
    const tool = this.toolsByName.get(name);
    if (!tool) return { output: `Unknown tool: ${name}`, isError: true };

    const decision = await this.permissions.request(tool, input);
    if (!decision.allowed) {
      return { output: `Permission denied (${decision.reason ?? "unspecified"}).`, isError: true };
    }

    try {
      const output = await tool.run(input as Record<string, unknown>);
      return { output, isError: false };
    } catch (err) {
      const error = err as Error;
      return { output: `${error.name}: ${error.message}`, isError: true };
    }
  }
}