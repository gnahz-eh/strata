import { createInterface } from "node:readline/promises";

import type { PermissionDecision, PermissionPolicy } from "../core/permissions.js";
import type { Tool } from "../core/tool.js";

export type PermissionMode = "ask" | "accept" | "deny";

export class PermissionManager implements PermissionPolicy {
  private allowed = new Set<string>();

  constructor(public mode: PermissionMode = "ask") {}

  async request(tool: Tool, input: unknown): Promise<PermissionDecision> {
    if (!tool.needsPermission) return { allowed: true };
    if (this.mode === "accept") return { allowed: true };
    if (this.mode === "deny") return { allowed: false, reason: "denied by policy" };
    if (this.allowed.has(tool.name)) return { allowed: true };

    console.log();
    console.log(`  Tool:  ${tool.name}`);
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      let preview = typeof value === "string" ? value : JSON.stringify(value);
      if (preview.length > 200) preview = preview.slice(0, 200) + "...";
      console.log(`  ${key}: ${preview}`);
    }

    const readline = createInterface({ input: process.stdin, output: process.stdout });
    try {
      while (true) {
        const answer = (await readline.question("  Allow? [y]es / [n]o / [a]lways: ")).trim().toLowerCase();
        if (answer === "y" || answer === "yes") return { allowed: true };
        if (answer === "n" || answer === "no" || answer === "") {
          return { allowed: false, reason: "user denied" };
        }
        if (answer === "a" || answer === "always") {
          this.allowed.add(tool.name);
          return { allowed: true };
        }
      }
    } finally {
      readline.close();
    }
  }
}