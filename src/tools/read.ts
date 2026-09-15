import { open, stat } from "node:fs/promises";

import type { Tool, ToolContext } from "../core/tool.js";
import { boundedOutput, textLines, toolContext, workspacePath } from "./shared.js";

const DEFAULT_LIMIT = 2000;
const MAX_FILE_BYTES = 1024 * 1024;

interface ReadInput {
  path: string;
  offset?: number;
  limit?: number;
}

async function run(input: ReadInput, suppliedContext?: ToolContext): Promise<string> {
  const context = toolContext(suppliedContext);
  const offset = input.offset ?? 0;
  const limit = input.limit ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("offset must be a nonnegative safe integer.");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > DEFAULT_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${DEFAULT_LIMIT}.`);
  }
  const path = await workspacePath(input.path, context);
  if (!(await stat(path)).isFile()) throw new Error(`Path is not a regular file: ${path}`);

  const file = await open(path, "r");
  let text: string;
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error(`Path is not a regular file: ${path}`);
    if (info.size > MAX_FILE_BYTES) {
      throw new Error(`File exceeds the ${MAX_FILE_BYTES} byte read limit: ${path}`);
    }
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      context.signal.throwIfAborted();
      const result = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    context.signal.throwIfAborted();
    if (bytesRead > MAX_FILE_BYTES) {
      throw new Error(`File exceeds the ${MAX_FILE_BYTES} byte read limit: ${path}`);
    }
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      buffer.subarray(0, bytesRead),
    );
  } finally {
    await file.close();
  }

  const lines = textLines(text);
  const chunk = lines.slice(offset, offset + limit);
  const numbered = chunk
    .map((line, index) => `${String(offset + index + 1).padStart(6)}\t${line}`)
    .join("\n");

  const truncated =
    offset + limit < lines.length
      ? `\n<truncated at line ${offset + limit} of ${lines.length}>`
      : "";
  return boundedOutput(numbered + truncated, context.maxOutputBytes);
}

export const readTool: Tool = {
  name: "read",
  description:
    "Read a file's contents as text. Returns line-numbered output. " +
    "Use `offset` and `limit` for paging through large files (default reads first 2000 lines).",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string", minLength: 1, description: "Path to the file within the workspace." },
      offset: {
        type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER,
        description: "0-indexed line to start at.", default: 0,
      },
      limit: {
        type: "integer", minimum: 1, maximum: DEFAULT_LIMIT,
        description: "Max lines to read.", default: DEFAULT_LIMIT,
      },
    },
    required: ["path"],
  },
  needsPermission: false,
  run,
};
