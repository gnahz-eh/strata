import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { Agent, errorMessage, type StopReason } from "../core/agent.js";
import { deadline } from "../core/abort.js";
import { buildSystemPrompt } from "../context/system-prompt.js";
import { loadExtensions } from "../extensions/index.js";
import { PermissionManager } from "../permissions/manager.js";
import { createClient, PROVIDERS } from "../providers/index.js";
import { FileSession } from "../sessions/index.js";
import { ALL_TOOLS } from "../tools/index.js";
import { parseCliArgs } from "./args.js";
import { createRenderer } from "./render.js";
import { readTerminalLine, terminalText } from "./terminal.js";

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  const opts = parseCliArgs(args);
  if (opts.help) {
    console.log("Usage: strata [--provider anthropic|openai] [--model MODEL] [-p PROMPT]");
    console.log("  --cwd DIR                 Workspace for file and shell tools");
    console.log("  --session FILE            Create or resume a private local snapshot");
    console.log("  --read-only               Expose only tools declared read-only");
    console.log("  --accept-all              Approve tool actions (not a sandbox)");
    console.log("  --json                    Emit JSONL events; requires -p");
    console.log("  --extension DIR           Load a local tool extension (repeatable)");
    console.log("  --trust-extensions        Trust selected extensions with host access");
    console.log("  --max-turns N             Model turns per prompt (default 20)");
    console.log("  --max-context-bytes N     Serialized request budget (default 256000)");
    console.log("  --max-run-tokens N        Reported token budget per prompt (default 100000)");
    console.log("  --timeout SECONDS         Total prompt deadline (default 900)");
    console.log("  --request-timeout SECONDS Model request deadline (default 120)");
    console.log("Providers: anthropic (ANTHROPIC_API_KEY), openai (OPENAI_API_KEY)");
    return 0;
  }
  const apiKeyEnv = PROVIDERS[opts.provider].apiKeyEnv;
  if (!process.env[apiKeyEnv]) {
    console.error(`error: ${apiKeyEnv} is not set.`);
    return 2;
  }
  if (opts.prompt === undefined && !process.stdin.isTTY) {
    console.error("error: noninteractive input requires -p PROMPT.");
    return 2;
  }
  const cwd = await realpath(opts.cwd);
  const extensions = await loadExtensions(opts.extensions, { cwd, trusted: opts.trustExtensions });
  let session: FileSession | undefined;
  let agent: Agent | undefined;
  let inputController: AbortController | undefined;
  let interrupted = false;
  const onInterrupt = () => {
    interrupted = true;
    agent?.abort();
    inputController?.abort();
  };
  process.on("SIGINT", onInterrupt);
  const display = createRenderer(opts.json);
  try {
    const allTools = [...ALL_TOOLS, ...extensions.tools];
    if (new Set(allTools.map((tool) => tool.name)).size !== allTools.length) throw new Error("Extension tool names conflict with registered tools.");
    const tools = opts.readOnly ? allTools.filter((tool) => tool.needsPermission === false) : allTools;
    if (opts.session) {
      const path = resolve(cwd, opts.session);
      await mkdir(dirname(path), { recursive: true });
      const toolsHash = createHash("sha256").update(JSON.stringify({
        apiVersion: 1,
        tools: tools.map(({ name, description, inputSchema, needsPermission }) => ({ name, description, inputSchema, needsPermission })),
        extensions: extensions.identities,
      })).digest("hex");
      session = await FileSession.open(path, { cwd, provider: opts.provider, model: opts.model, toolsHash });
    }
    const canPrompt = Boolean(process.stdin.isTTY && process.stderr.isTTY && !opts.json);
    const permissions = new PermissionManager(opts.mode, canPrompt ? async (tool, input, signal) => {
      process.stderr.write(`\nTool: ${tool.name}\n${terminalText(JSON.stringify(input, null, 2)).slice(0, 2000)}\n`);
      return readTerminalLine("Allow? [y]es / [n]o / [a]lways: ", signal);
    } : undefined);
    agent = new Agent({
      client: createClient(opts.provider, opts.model), tools, permissions, cwd,
      systemPrompt: buildSystemPrompt(cwd), limits: opts.limits, messages: session?.messages,
      checkpoint: session ? (messages) => session!.save(messages) : undefined,
    });
    const run = async (prompt: string): Promise<number> => {
      let reason: StopReason = null;
      for await (const event of agent!.query(prompt)) {
        display(event);
        if (event.kind === "end") reason = event.stopReason;
      }
      return reason === "aborted" ? 130 : reason === "end_turn" || reason === "stop_sequence" ? 0 : 3;
    };
    if (opts.prompt !== undefined) return await run(opts.prompt);
    console.error(`Strata (${opts.provider}/${opts.model}) - Ctrl-C cancels; exit or Ctrl-D quits`);
    while (true) {
      interrupted = false;
      inputController = new AbortController();
      const prompt = (await readTerminalLine("\n> ", inputController.signal))?.trim();
      inputController = undefined;
      if (prompt === undefined && interrupted) continue;
      if (prompt === undefined || prompt === "exit" || prompt === "quit") return 0;
      if (!prompt) continue;
      try { await run(prompt); }
      catch (error) { console.error(terminalText(errorMessage(error))); }
      if (interrupted) console.error("Interrupted. Inspect any incomplete tool actions before retrying.");
    }
  } finally {
    process.off("SIGINT", onInterrupt);
    if (agent?.hasPendingOperations) {
      const settling = deadline(2000);
      try { await agent.waitForIdle(settling.signal); } catch {}
      finally { settling.dispose(); }
    }
    if (agent?.hasPendingOperations) throw new Error("An operation did not stop. Session lock retained; verify the process has exited and inspect side effects before removing the lock. Extension cleanup was not run concurrently with active code.");
    try { await extensions.dispose(); }
    catch (error) {
      throw new Error("Extension cleanup failed. Session lock retained; verify all extension code has stopped before removing the lock.", { cause: error });
    }
    await session?.close();
  }
}