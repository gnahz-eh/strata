import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Tool, ToolContext } from "../core/tool.js";
import { boundedOutput, isMissing, textLines, toolContext, workspacePath } from "./shared.js";

interface WriteInput {
  path: string;
  content: string;
}

async function run(input: WriteInput, suppliedContext?: ToolContext): Promise<string> {
  const context = toolContext(suppliedContext);
  if (typeof input.content !== "string") throw new Error("content must be a string.");
  const path = await workspacePath(input.path, context, {
    allowMissing: true, rejectSymlink: true,
  });
  let existing;
  try {
    existing = await lstat(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (existing && !existing.isFile()) throw new Error(`Path is not a regular file: ${path}`);

  await mkdir(dirname(path), { recursive: true });
  await workspacePath(input.path, context, { allowMissing: true, rejectSymlink: true });
  const temporary = join(dirname(path), `.strata-write-${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", existing ? 0o600 : 0o666);
  try {
    try {
      await file.writeFile(input.content, { encoding: "utf8", signal: context.signal });
      if (existing) await file.chmod(existing.mode & 0o777);
      await file.sync();
    } finally {
      await file.close();
    }
    await workspacePath(input.path, context, { allowMissing: true, rejectSymlink: true });
    context.signal.throwIfAborted();
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }

  const verb = existing ? "Updated" : "Created";
  return boundedOutput(
    `${verb} ${path} (${input.content.length} chars, ${textLines(input.content).length} lines).`,
    context.maxOutputBytes,
  );
}

export const writeTool: Tool = {
  name: "write",
  description:
    "Write text content to a file, overwriting if it exists. " +
    "Creates parent directories as needed. For surgical edits to existing " +
    "files prefer reading first, then writing the full new content.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string", minLength: 1, description: "Path to write within the workspace." },
      content: { type: "string", description: "Full file contents." },
    },
    required: ["path", "content"],
  },
  needsPermission: true,
  run,
};
