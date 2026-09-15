import { opendir, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { addAbortSignal, type Readable } from "node:stream";
import fastGlob from "fast-glob";

import type { Tool, ToolContext } from "../core/tool.js";
import { boundedOutput, toolContext, workspacePath } from "./shared.js";

const MAX_RESULTS = 200;
const SKIP_DIRS = [
  "node_modules", ".git", ".strata", "dist", "build", ".venv", "venv", "__pycache__",
  "coverage", ".next", ".nuxt", ".output", ".cache", ".turbo", ".yarn", ".pnpm-store", "target", "vendor",
];

interface GlobInput {
  pattern: string;
  root?: string;
}

function validatePattern(pattern: string): void {
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.includes("\0")) {
    throw new Error("Glob pattern must be a nonempty string without null bytes.");
  }
  if (isAbsolute(pattern) || win32.isAbsolute(pattern) || /^[a-z]:/i.test(pattern)
    || pattern.split(/[\\/{}(),|]/).includes("..")) {
    throw new Error("Glob pattern must be relative and stay within its root.");
  }
}

async function run(input: GlobInput, suppliedContext?: ToolContext): Promise<string> {
  const context = toolContext(suppliedContext);
  validatePattern(input.pattern);
  const root = await workspacePath(input.root ?? ".", context, { rejectSymlinks: true });
  if (!(await stat(root)).isDirectory()) throw new Error(`Glob root is not a directory: ${root}`);
  const directory = await opendir(root);
  await directory.close();
  const options: fastGlob.Options = {
    cwd: root,
    onlyFiles: true,
    followSymbolicLinks: false,
    dot: true,
    suppressErrors: false,
    concurrency: 4,
    ignore: [`**/{${SKIP_DIRS.join(",")}}/**`, "**/.strata-write-*.tmp"],
  };
  const tasks = fastGlob.generateTasks(input.pattern, options);
  for (const task of tasks) {
    for (const pattern of task.positive) validatePattern(pattern);
    await workspacePath(resolve(root, task.base), context, {
      allowMissing: true, rejectSymlinks: true,
    });
  }

  const matches: string[] = [];
  if (!relative(resolve(context.cwd), root).split(sep).some((part) => SKIP_DIRS.includes(part))) {
    context.signal.throwIfAborted();
    const stream = addAbortSignal(context.signal, fastGlob.stream(input.pattern, options) as Readable);
    try {
      for await (const entry of stream) {
        context.signal.throwIfAborted();
        matches.push(String(entry));
        if (matches.length > MAX_RESULTS) break;
      }
    } finally {
      stream.destroy();
    }
  }
  context.signal.throwIfAborted();
  const output = matches.length === 0
    ? `No matches for ${input.pattern} under ${root}.`
    : matches.slice(0, MAX_RESULTS).sort().join("\n")
      + (matches.length > MAX_RESULTS ? `\n<truncated: more than ${MAX_RESULTS} results; narrow your pattern>` : "");
  return boundedOutput(output, context.maxOutputBytes);
}

export const globTool: Tool = {
  name: "glob",
  description:
    "Find files by glob pattern (e.g. '**/*.ts', 'src/**/*.test.ts'). " +
    "Returns up to 200 paths relative to the root. Skips dependency/generated directories, .git and .strata. " +
    "Use to discover files before reading them.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      pattern: { type: "string", minLength: 1, description: "Relative glob pattern, e.g. '**/*.ts'." },
      root: { type: "string", minLength: 1, description: "Workspace directory to search from.", default: "." },
    },
    required: ["pattern"],
  },
  needsPermission: false,
  run,
};
