import type { MessageParam } from "../core/client.js";
import { validateHistory } from "../core/history.js";

export interface SessionIdentity {
  cwd: string;
  provider: string;
  model: string;
  toolsHash: string;
}

export const MAX_SESSION_BYTES = 16 * 1024 * 1024;

const identityKeys = ["cwd", "provider", "model", "toolsHash"] as const;

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function validateIdentity(value: unknown): SessionIdentity {
  if (!hasExactKeys(value, identityKeys) ||
      identityKeys.some((key) => typeof value[key] !== "string" || value[key].length === 0)) {
    throw new Error("Invalid session identity: expected cwd, provider, model, and toolsHash as nonempty strings.");
  }
  return {
    cwd: value.cwd as string,
    provider: value.provider as string,
    model: value.model as string,
    toolsHash: value.toolsHash as string,
  };
}

export function decodeSnapshot(serialized: string, expected: SessionIdentity, repair = false): MessageParam[] {
  if (Buffer.byteLength(serialized, "utf8") > MAX_SESSION_BYTES) {
    throw new Error("Session snapshot exceeds the 16 MiB limit.");
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (cause) {
    throw new Error("Invalid session JSON.", { cause });
  }
  if (!hasExactKeys(value, ["version", "identity", "messages"])) {
    throw new Error("Invalid session envelope: expected version, identity, and messages only.");
  }
  if (value.version !== 1) throw new Error("Unsupported session version: expected version 1.");
  const identity = validateIdentity(value.identity);
  for (const key of identityKeys) {
    if (identity[key] !== expected[key]) throw new Error(`Incompatible session identity: ${key} does not match.`);
  }
  return validateHistory(value.messages, repair);
}

export function encodeSnapshot(identity: SessionIdentity, messages: MessageParam[]): {
  serialized: string;
  messages: MessageParam[];
} {
  const copied = validateHistory(messages);
  const serialized = JSON.stringify({ version: 1, identity: validateIdentity(identity), messages: copied },
    function (this: Record<string, unknown>, key: string, value: unknown) {
      if (typeof value === "undefined" || typeof value === "bigint" ||
          typeof value === "function" || typeof value === "symbol" ||
          typeof value === "number" && !Number.isFinite(value)) {
        throw new Error("Session snapshots must contain only JSON data.");
      }
      const original = this[key];
      if (original !== null && typeof original === "object" && !Array.isArray(original) &&
          Object.getPrototypeOf(original) !== Object.prototype && Object.getPrototypeOf(original) !== null) {
        throw new Error("Session snapshots must contain only JSON objects and arrays.");
      }
      return value;
    }) + "\n";
  return { serialized, messages: decodeSnapshot(serialized, identity) };
}