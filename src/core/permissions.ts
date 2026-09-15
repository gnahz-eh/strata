import type { Tool, ToolContext } from "./tool.js";

export interface PermissionDecision {
  allowed: boolean;
  reason?: string;
}

export interface PermissionPolicy {
  request(tool: Tool, input: unknown, context?: ToolContext): Promise<PermissionDecision>;
}