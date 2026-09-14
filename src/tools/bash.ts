/**
 * Run a shell command. The 80/20 tool — almost any task can be done with this.
 */
import { spawn } from "node:child_process";

import type { Tool } from "../core/tool.js";

const MAX_OUTPUT = 30_000;
const DEFAULT_TIMEOUT_MS = 60_000;

interface BashInput {
  command: string;
  timeout?: number; // seconds
}

async function run(input: BashInput): Promise<string> {
  const timeoutMs = (input.timeout ?? 60) * 1000;
  const shell = process.platform === "win32" ? "cmd.exe" : "/bin/bash";
  const shellArgs = process.platform === "win32" ? ["/c", input.command] : ["-c", input.command];

  return await new Promise<string>((resolve) => {
    const proc = spawn(shell, shellArgs, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let killed = false;

    const append = (buf: Buffer) => {
      totalBytes += buf.length;
      if (chunks.length === 0 || Buffer.concat(chunks).length < MAX_OUTPUT) {
        chunks.push(buf);
      }
    };
    proc.stdout.on("data", append);
    proc.stderr.on("data", append);

    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGKILL");
    }, timeoutMs || DEFAULT_TIMEOUT_MS);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (killed) {
        resolve(`<timeout after ${input.timeout ?? 60}s>`);
        return;
      }
      let out = Buffer.concat(chunks).toString("utf8");
      if (out.length > MAX_OUTPUT) {
        out = out.slice(0, MAX_OUTPUT) + `\n<truncated, ${totalBytes} bytes total>`;
      }
      resolve(`<exit code ${code}>\n${out}`);
    });
  });
}

export const bashTool: Tool = {
  name: "bash",
  description:
    "Run a shell command and return its combined stdout+stderr. " +
    "Use for git, builds, tests, listing files with ls, anything system-level. " +
    "Do NOT use for reading or writing files — use the read/write tools instead.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to run." },
      timeout: { type: "number", description: "Timeout in seconds (default 60).", default: 60 },
    },
    required: ["command"],
  },
  needsPermission: true,
  run,
};
