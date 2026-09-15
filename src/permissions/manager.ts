import type { PermissionDecision, PermissionPolicy } from "../core/permissions.js";
import type { Tool, ToolContext } from "../core/tool.js";

export type PermissionMode = "ask" | "accept" | "deny";

export class PermissionManager implements PermissionPolicy {
  private allowed = new Set<string>();

  constructor(
    public mode: PermissionMode = "ask",
    private readonly prompt?: (tool: Tool, input: unknown, signal?: AbortSignal) => Promise<string | undefined>,
  ) {
    if (!["ask", "accept", "deny"].includes(mode)) throw new Error(`Invalid permission mode: ${mode}`);
  }

  async request(tool: Tool, input: unknown, context?: ToolContext): Promise<PermissionDecision> {
    context?.signal.throwIfAborted();
    if (tool.needsPermission === false) return { allowed: true };
    if (this.mode === "accept") return { allowed: true };
    if (this.mode === "deny") return { allowed: false, reason: "denied by policy" };
    if (this.allowed.has(tool.name)) return { allowed: true };
    if (!this.prompt) return { allowed: false, reason: "interactive approval is unavailable" };
    while (true) {
      const answer = (await this.prompt(tool, input, context?.signal))?.trim().toLowerCase();
      context?.signal.throwIfAborted();
      if (answer === "y" || answer === "yes") return { allowed: true };
      if (answer === undefined || answer === "n" || answer === "no" || answer === "") return { allowed: false, reason: "user denied" };
      if (answer === "a" || answer === "always") {
        this.allowed.add(tool.name);
        return { allowed: true };
      }
    }
  }
}