import { parseArgs } from "node:util";

import type { PermissionMode } from "../permissions/manager.js";
import { DEFAULT_PROVIDER, parseProvider, PROVIDERS, type Provider } from "../providers/index.js";

export interface CliOptions {
  provider: Provider;
  model: string;
  mode: PermissionMode;
  prompt?: string;
  help: boolean;
}

export function parseCliArgs(
  args: string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): CliOptions {
  const { values } = parseArgs({
    args,
    options: {
      provider: { type: "string" },
      model: { type: "string" },
      "accept-all": { type: "boolean", default: false },
      prompt: { type: "string", short: "p" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });

  const provider = parseProvider(values.provider ?? environment.STRATA_PROVIDER ?? DEFAULT_PROVIDER);

  return {
    provider,
    model: values.model ?? environment.STRATA_MODEL ?? PROVIDERS[provider].defaultModel,
    mode: values["accept-all"] ? "accept" : "ask",
    prompt: values.prompt,
    help: values.help ?? false,
  };
}