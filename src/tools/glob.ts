/**
 * Find files matching a glob pattern. The "where does X live" tool.
 *
 * We hand-roll a minimal recursive walker so this works on Node 20+
 * without relying on `fs.glob` (Node 22+). Supports `*`, `**`, `?` and
 * directory separators. Good enough for an educational agent.
 */
import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import type { Tool } from "../core/tool.js";

const MAX_RESULTS = 200;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".venv", "__pycache__"]);

interface GlobInput {
  pattern: string;
  root?: string;
}

/** Compile a glob pattern into a RegExp anchored end-to-end. */
function globToRegExp(pattern: string): RegExp {
  // Split by `**` first so we can treat it specially (matches across `/`).
  const parts = pattern.split("**");
  const compiled = parts
    .map((part) =>
      part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]"),
    )
    .join(".*");
  return new RegExp(`^${compiled}$`);
}

async function* walk(dir: string, base: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full, base);
    } else if (entry.isFile()) {
      yield relative(base, full).split("\\").join("/");
    }
  }
}

async function run(input: GlobInput): Promise<string> {
  const root = resolve(input.root ?? ".");
  const re = globToRegExp(input.pattern);
  const matches: string[] = [];

  for await (const rel of walk(root, root)) {
    if (re.test(rel)) {
      matches.push(rel);
      if (matches.length >= MAX_RESULTS) {
        matches.push(`... (>${MAX_RESULTS} results, narrow your pattern)`);
        break;
      }
    }
  }

  if (matches.length === 0) {
    return `No matches for ${input.pattern} under ${root}.`;
  }
  return matches.join("\n");
}

export const globTool: Tool = {
  name: "glob",
  description:
    "Find files by glob pattern (e.g. '**/*.ts', 'src/**/*.test.ts'). " +
    "Returns up to 200 paths relative to the root. Skips node_modules, .git, dist, build. " +
    "Use to discover files before reading them.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern, e.g. '**/*.ts'." },
      root: { type: "string", description: "Root directory to search from.", default: "." },
    },
    required: ["pattern"],
  },
  needsPermission: false,
  run,
};
