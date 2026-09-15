import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { ToolContext } from "../core/tool.js";

const DEFAULT_MAX_OUTPUT_BYTES = 30_000;

export function toolContext(context?: ToolContext): ToolContext {
  const result = context ?? {
    cwd: process.cwd(),
    signal: new AbortController().signal,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
  };
  if (!Number.isSafeInteger(result.maxOutputBytes) || result.maxOutputBytes < 1) {
    throw new Error("maxOutputBytes must be a positive safe integer.");
  }
  result.signal.throwIfAborted();
  return result;
}

function assertWithin(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Path is outside the workspace: ${path}`);
  }
}

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

export async function workspacePath(
  input: string,
  context: ToolContext,
  options: { allowMissing?: boolean; rejectSymlink?: boolean; rejectSymlinks?: boolean } = {},
): Promise<string> {
  context.signal.throwIfAborted();
  if (typeof input !== "string" || input.length === 0 || input.includes("\0")) {
    throw new Error("Path must be a nonempty string without null bytes.");
  }
  const root = resolve(context.cwd);
  const realRoot = await realpath(root);
  if (!(await stat(realRoot)).isDirectory()) {
    throw new Error(`Workspace is not a directory: ${root}`);
  }
  const path = resolve(root, input);
  assertWithin(root, path);

  const parts = relative(root, path).split(sep).filter(Boolean);
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = resolve(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (options.allowMissing && isMissing(error)) break;
      throw error;
    }
    if (options.rejectSymlinks && info.isSymbolicLink()) {
      throw new Error(`Refusing to follow a symbolic link: ${current}`);
    }
    if (options.rejectSymlink && index === parts.length - 1 && info.isSymbolicLink()) {
      throw new Error(`Refusing to overwrite a symbolic link: ${path}`);
    }
    const realCurrent = await realpath(current);
    assertWithin(realRoot, realCurrent);
    if (index < parts.length - 1 && !(await stat(realCurrent)).isDirectory()) {
      throw new Error(`Path ancestor is not a directory: ${current}`);
    }
    context.signal.throwIfAborted();
  }
  context.signal.throwIfAborted();
  return path;
}

export function utf8Prefix(buffer: Buffer, limit: number): Buffer {
  let end = Math.min(buffer.length, Math.max(0, limit));
  if (end < buffer.length) {
    while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
  }
  return buffer.subarray(0, end);
}

export function boundedOutput(
  text: string,
  maxBytes: number,
  marker = "\n<truncated>",
  truncated = false,
): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes && !truncated) return text;
  if (maxBytes < Buffer.byteLength(marker)) marker = "\n<truncated>";
  if (maxBytes < Buffer.byteLength(marker)) return ".".repeat(Math.min(3, maxBytes));
  return utf8Prefix(buffer, maxBytes - Buffer.byteLength(marker)).toString("utf8") + marker;
}

export function textLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}