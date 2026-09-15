import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

export async function fixture(context: TestContext, source: string, manifest: Record<string, unknown> = {}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "strata-extension-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "strata-extension.json"), JSON.stringify({
    name: "test-extension", version: "1.0.0", apiVersion: 1, main: "index.mjs", ...manifest,
  }));
  await writeFile(join(directory, "index.mjs"), source);
  return directory;
}

export function bridge<Value>(context: TestContext, value: Value): string {
  const key = `strata-extension-test-${randomUUID()}`;
  const globals = globalThis as unknown as Record<string, unknown>;
  globals[key] = value;
  context.after(() => { delete globals[key]; });
  return `globalThis[${JSON.stringify(key)}]`;
}

export function deferred<Value = void>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

export const validSource = `
import { writeFile } from "node:fs/promises";
export function activate(api) {
  if (!Object.isFrozen(api) || Object.keys(api).join() !== "registerTool") throw new Error("Unexpected API surface");
  api.registerTool({
    name: "project_info",
    description: "Report the current project directory.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run(input, context) { return context.cwd; },
  });
  return async () => { await writeFile(new URL("./disposed", import.meta.url), "cleaned"); };
}
`;