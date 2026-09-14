/**
 * Write a file. Creates parent directories. Always requires permission.
 */
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { Tool } from "../core/tool.js";

interface WriteInput {
  path: string;
  content: string;
}

async function run(input: WriteInput): Promise<string> {
  const path = resolve(input.path);
  let existed = true;
  try {
    await stat(path);
  } catch {
    existed = false;
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, input.content, "utf8");

  const verb = existed ? "Updated" : "Created";
  const lines = input.content.split("\n").length;
  return `${verb} ${path} (${input.content.length} chars, ${lines} lines).`;
}

export const writeTool: Tool = {
  name: "write",
  description:
    "Write text content to a file, overwriting if it exists. " +
    "Creates parent directories as needed. For surgical edits to existing " +
    "files prefer reading first, then writing the full new content.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to write." },
      content: { type: "string", description: "Full file contents." },
    },
    required: ["path", "content"],
  },
  needsPermission: true,
  run,
};
