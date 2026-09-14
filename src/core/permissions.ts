import type { Tool } from "./tool.js";

export interface PermissionDecision {
  allowed: boolean;
  reason?: string;
}

export interface PermissionPolicy {
  request(tool: Tool, input: unknown): Promise<PermissionDecision>;
}