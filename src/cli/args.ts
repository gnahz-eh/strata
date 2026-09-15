import { parseArgs } from "node:util";
import { resolve } from "node:path";

import type { RuntimeLimits } from "../core/agent.js";
import type { PermissionMode } from "../permissions/manager.js";
import { DEFAULT_PROVIDER, parseProvider, PROVIDERS, type Provider } from "../providers/index.js";

export interface CliOptions {
  provider: Provider;
  model: string;
  mode: PermissionMode;
  prompt?: string;
  help: boolean;
  cwd: string;
  session?: string;
  json: boolean;
  readOnly: boolean;
  extensions: string[];
  trustExtensions: boolean;
  limits: Partial<RuntimeLimits>;
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
      cwd: { type: "string" },
      session: { type: "string" },
      json: { type: "boolean", default: false },
      "read-only": { type: "boolean", default: false },
      extension: { type: "string", multiple: true },
      "trust-extensions": { type: "boolean", default: false },
      "max-turns": { type: "string" },
      "max-context-bytes": { type: "string" },
      "max-run-tokens": { type: "string" },
      timeout: { type: "string" },
      "request-timeout": { type: "string" },
    },
    allowPositionals: false,
  });

  const help = values.help ?? false;
  const provider = parseProvider(values.provider ?? (help ? DEFAULT_PROVIDER : environment.STRATA_PROVIDER) ?? DEFAULT_PROVIDER);
  if (!help && values["read-only"] && values["accept-all"]) throw new Error("--read-only and --accept-all cannot be combined.");
  if (!help && values.extension?.length && !values["trust-extensions"]) throw new Error("--extension requires --trust-extensions; extensions execute trusted local code.");
  if (!help && values.prompt !== undefined && !values.prompt.trim()) throw new Error("Prompt must not be empty.");
  if (!help && values.json && values.prompt === undefined) throw new Error("--json requires a one-shot -p prompt.");
  const limits: Partial<RuntimeLimits> = {};
  for (const [flag, property, scale] of [
    ["max-turns", "maxTurns", 1], ["max-context-bytes", "maxContextBytes", 1],
    ["max-run-tokens", "maxRunTokens", 1], ["timeout", "runTimeoutMs", 1000],
    ["request-timeout", "requestTimeoutMs", 1000],
  ] as const) {
    const value = values[flag];
    if (value === undefined) continue;
    const numeric = Number(value) * scale;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(numeric) || numeric < 1 || numeric > 2_147_483_647) {
      throw new Error(`--${flag} must be a positive integer within timer limits.`);
    }
    limits[property] = numeric;
  }

  return {
    provider,
    model: values.model ?? environment.STRATA_MODEL ?? PROVIDERS[provider].defaultModel,
    mode: values["read-only"] ? "deny" : values["accept-all"] ? "accept" : "ask",
    prompt: values.prompt,
    help,
    cwd: resolve(values.cwd ?? process.cwd()),
    session: values.session,
    json: values.json ?? false,
    readOnly: values["read-only"] ?? false,
    extensions: values.extension ?? [],
    trustExtensions: values["trust-extensions"] ?? false,
    limits,
  };
}