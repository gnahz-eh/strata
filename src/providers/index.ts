import type { ModelClient } from "../core/client.js";
import { Client, DEFAULT_MODEL } from "./anthropic.js";
import { OpenAIClient, DEFAULT_OPENAI_MODEL } from "./openai.js";

export const DEFAULT_PROVIDER = "anthropic";

export const PROVIDERS = {
  anthropic: {
    defaultModel: DEFAULT_MODEL,
    apiKeyEnv: "ANTHROPIC_API_KEY",
    createClient: (model?: string) => new Client(model),
  },
  openai: {
    defaultModel: DEFAULT_OPENAI_MODEL,
    apiKeyEnv: "OPENAI_API_KEY",
    createClient: (model?: string) => new OpenAIClient(model),
  },
} as const;

export type Provider = keyof typeof PROVIDERS;

export function parseProvider(value: string): Provider {
  if (!Object.hasOwn(PROVIDERS, value)) {
    throw new Error(`Unsupported provider "${value}". Expected anthropic or openai.`);
  }
  return value as Provider;
}

export function createClient(provider: Provider = DEFAULT_PROVIDER, model?: string): ModelClient {
  return PROVIDERS[parseProvider(provider)].createClient(model);
}