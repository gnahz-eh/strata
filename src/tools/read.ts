/**
 * Read a file with optional line range so the model can page through huge
 * files without blowing the context window. Read-only — no permission gate.
 */
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import type { Tool } from "../core/tool.js";

const DEFAULT_LIMIT = 2000;

interface ReadInput {
  path: string;
  offset?: number;
  limit?: number;
}

async function run(input: ReadInput): Promise<string> {
  const path = resolve(input.path);
  const offset = input.offset ?? 0;
  const limit = input.limit ?? DEFAULT_LIMIT;

  let info;
  try {
    info = await stat(path);
  } catch {
    return `File not found: ${path}`;
  }
  if (info.isDirectory()) return `${path} is a directory, not a file.`;

  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return `<binary or unreadable file, ${info.size} bytes>`;
  }

  const lines = text.split("\n");
  const chunk = lines.slice(offset, offset + limit);
  const numbered = chunk
    .map((line, i) => `${String(offset + i + 1).padStart(6)}\t${line}`)
    .join("\n");

  const truncated =
    offset + limit < lines.length
      ? `\n<truncated at line ${offset + limit} of ${lines.length}>`
      : "";
  return numbered + truncated;
}

export const readTool: Tool = {
  name: "read",
  description:
    "Read a file's contents as text. Returns line-numbered output. " +
    "Use `offset` and `limit` for paging through large files (default reads first 2000 lines).",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file." },
      offset: { type: "integer", description: "0-indexed line to start at.", default: 0 },
      limit: { type: "integer", description: "Max lines to read.", default: DEFAULT_LIMIT },
    },
    required: ["path"],
  },
  needsPermission: false, // read-only — safe to auto-approve
  run,
};
