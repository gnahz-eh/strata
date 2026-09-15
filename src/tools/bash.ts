import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

import type { Tool, ToolContext } from "../core/tool.js";
import { boundedOutput, toolContext, utf8Prefix } from "./shared.js";

const DEFAULT_TIMEOUT_SECONDS = 60;
const TREE_TIMEOUT_MS = 5000;

interface BashInput {
  command: string;
  timeout?: number;
}

async function terminateTree(pid: number): Promise<void> {
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    return;
  }

  await new Promise<void>((resolvePromise, reject) => {
    const killer = spawn("taskkill.exe", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore", windowsHide: true,
    });
    let failure: Error | undefined;
    const timer = setTimeout(() => {
      failure = new Error("taskkill exceeded its cleanup deadline.");
      killer.kill("SIGKILL");
    }, TREE_TIMEOUT_MS);
    killer.once("error", (error) => { failure = error; });
    killer.once("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`taskkill exited with code ${code}.`));
      else resolvePromise();
    });
  });
}

async function run(input: BashInput, suppliedContext?: ToolContext): Promise<string> {
  const context = toolContext(suppliedContext);
  const timeoutSeconds = input.timeout ?? DEFAULT_TIMEOUT_SECONDS;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 120) {
    throw new Error("timeout must be greater than zero and at most 120 seconds.");
  }
  if (typeof input.command !== "string" || input.command.length === 0 || input.command.includes("\0")) {
    throw new Error("command must be a nonempty string without null bytes.");
  }
  const windows = process.platform === "win32";
  const shell = windows ? "cmd.exe" : "/bin/bash";
  const shellArgs = windows ? ["/d", "/s", "/c", `"${input.command}"`] : ["-c", input.command];
  const output = Buffer.allocUnsafe(context.maxOutputBytes + 4);

  return await new Promise<string>((resolvePromise, reject) => {
    const proc = spawn(shell, shellArgs, {
      cwd: resolve(context.cwd),
      stdio: ["ignore", "pipe", "pipe"],
      detached: !windows,
      windowsHide: true,
      windowsVerbatimArguments: windows,
    });
    let bufferedBytes = 0;
    let totalBytes = 0;
    let outputTruncated = false;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let closed = false;
    let stopReason: "abort" | "timeout" | "error" | undefined;
    let processError: Error | undefined;
    let cleanupError: Error | undefined;
    let termination: Promise<void> | undefined;
    let drainTimer: NodeJS.Timeout | undefined;

    const appendText = (text: string) => {
      const buffer = Buffer.from(text, "utf8");
      const copied = buffer.copy(output, bufferedBytes, 0, output.length - bufferedBytes);
      bufferedBytes += copied;
      outputTruncated ||= copied < buffer.length;
    };
    const append = (buffer: Buffer, decoder: StringDecoder) => {
      totalBytes += buffer.length;
      if (bufferedBytes === output.length) {
        outputTruncated ||= buffer.length > 0;
        return;
      }
      appendText(decoder.write(buffer));
    };
    const onStdout = (buffer: Buffer) => append(buffer, stdoutDecoder);
    const onStderr = (buffer: Buffer) => append(buffer, stderrDecoder);
    const startTermination = () => {
      if (!proc.pid || termination) return;
      termination = terminateTree(proc.pid).catch((error: unknown) => {
        cleanupError = error instanceof Error ? error : new Error(String(error));
        proc.kill("SIGKILL");
      });
      drainTimer = setTimeout(() => {
        cleanupError ??= new Error("Subprocess pipes did not close after termination.");
        proc.kill("SIGKILL");
        proc.stdout.destroy();
        proc.stderr.destroy();
      }, TREE_TIMEOUT_MS + 1000);
    };
    const requestStop = (reason: "abort" | "timeout" | "error") => {
      if (closed) return;
      stopReason ??= reason;
      startTermination();
    };
    const onAbort = () => requestStop("abort");
    const onError = (error: Error) => {
      processError ??= error;
      requestStop("error");
    };
    const onSpawn = () => {
      if (context.signal.aborted) requestStop("abort");
      else if (stopReason) startTermination();
    };
    const timer = setTimeout(() => requestStop("timeout"), timeoutSeconds * 1000);

    const finish = async (code: number | null, exitSignal: NodeJS.Signals | null): Promise<string> => {
      closed = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      context.signal.removeEventListener("abort", onAbort);
      proc.off("spawn", onSpawn);
      proc.off("error", onError);
      proc.stdout.off("data", onStdout);
      proc.stderr.off("data", onStderr);
      proc.stdout.off("error", onError);
      proc.stderr.off("error", onError);
      await termination;
      appendText(stdoutDecoder.end());
      appendText(stderrDecoder.end());

      let status = `<exit code ${code}${exitSignal ? `, signal ${exitSignal}` : ""}>`;
      if (stopReason === "abort") status = "<aborted>";
      else if (stopReason === "timeout") status = `<timeout after ${timeoutSeconds}s>`;
      else if (processError) status = `<shell error: ${processError.message}>`;
      if (cleanupError) status += `\n<process-tree cleanup failed: ${cleanupError.message}>`;
      const text = utf8Prefix(output.subarray(0, bufferedBytes), context.maxOutputBytes).toString("utf8");
      const result = boundedOutput(`${status}\n${text}`, context.maxOutputBytes,
        `\n<truncated, ${totalBytes} bytes total>`, outputTruncated);
      if (stopReason || processError || cleanupError || code !== 0) {
        const error = new Error(result, {
          cause: stopReason === "abort" ? context.signal.reason : processError ?? cleanupError,
        });
        if (stopReason === "abort") error.name = "AbortError";
        else if (stopReason === "timeout") error.name = "TimeoutError";
        throw error;
      }
      return result;
    };

    proc.stdout.on("data", onStdout);
    proc.stderr.on("data", onStderr);
    proc.stdout.on("error", onError);
    proc.stderr.on("error", onError);
    proc.on("error", onError);
    proc.once("spawn", onSpawn);
    proc.once("close", (code, exitSignal) => {
      finish(code, exitSignal).then(resolvePromise, reject);
    });
    context.signal.addEventListener("abort", onAbort, { once: true });
    if (context.signal.aborted) onAbort();
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
    additionalProperties: false,
    properties: {
      command: { type: "string", minLength: 1, description: "Shell command to run." },
      timeout: {
        type: "number", exclusiveMinimum: 0, maximum: 120,
        description: "Timeout in seconds (default 60).", default: DEFAULT_TIMEOUT_SECONDS,
      },
    },
    required: ["command"],
  },
  needsPermission: true,
  run,
};
