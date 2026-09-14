import { createInterface } from "node:readline/promises";

import pc from "picocolors";

import { Agent } from "../core/agent.js";
import { createClient, PROVIDERS } from "../providers/index.js";
import { buildSystemPrompt } from "../context/system-prompt.js";
import { PermissionManager } from "../permissions/manager.js";
import { ALL_TOOLS } from "../tools/index.js";
import { parseCliArgs } from "./args.js";
import { render } from "./render.js";

async function runOneTurn(agent: Agent, userInput: string): Promise<void> {
  for await (const event of agent.query(userInput)) {
    render(event);
  }
}

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  const opts = parseCliArgs(args);
  if (opts.help) {
    console.log("Usage: strata [--provider anthropic|openai] [--model MODEL] [--accept-all] [-p PROMPT]");
    console.log("       strata -p \"what are the .ts files in src/?\"");
    console.log("       strata --provider openai --model gpt-4.1-mini -p \"summarize this project\"");
    console.log("Providers: anthropic (ANTHROPIC_API_KEY), openai (OPENAI_API_KEY)");
    return 0;
  }

  const apiKeyEnv = PROVIDERS[opts.provider].apiKeyEnv;
  if (!process.env[apiKeyEnv]) {
    console.error(`error: ${apiKeyEnv} is not set.`);
    return 2;
  }

  const agent = new Agent({
    client: createClient(opts.provider, opts.model),
    tools: ALL_TOOLS,
    permissions: new PermissionManager(opts.mode),
    systemPrompt: buildSystemPrompt(),
  });

  if (opts.prompt) {
    await runOneTurn(agent, opts.prompt);
    return 0;
  }

  console.log(pc.bold(pc.cyan("Strata")) + pc.dim(` (${opts.provider}/${opts.model}) - Ctrl-D or 'exit' to quit`));

  const readline = createInterface({ input: process.stdin, output: process.stdout });
  let cancelRequested = false;
  const onInterrupt = () => {
    cancelRequested = true;
  };
  process.on("SIGINT", onInterrupt);

  try {
    while (true) {
      const userInput = (await readline.question("\n> ")).trim();
      if (!userInput) continue;
      if (userInput === "exit" || userInput === "quit") return 0;

      try {
        await runOneTurn(agent, userInput);
      } catch (err) {
        const error = err as Error;
        console.error(pc.red(`\n${error.name}: ${error.message}`));
        if (cancelRequested) {
          cancelRequested = false;
          if (agent.messages.length > 0 && agent.messages[agent.messages.length - 1]!.role === "user") {
            agent.messages.pop();
          }
        }
      }
    }
  } finally {
    process.off("SIGINT", onInterrupt);
    readline.close();
  }
}