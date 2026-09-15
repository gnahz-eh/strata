import type { Tool } from "../core/tool.js";

export type Cleanup = () => void | Promise<void>;

const ACTIVATION_TIMEOUT_MS = 10_000;
const CLEANUP_TIMEOUT_MS = 5_000;

async function withDeadline<Result>(
  operation: () => Result | Promise<Result>,
  milliseconds: number,
  label: string,
  onTimeout: () => void = () => {},
): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`${label} timed out after ${milliseconds} ms.`));
    }, milliseconds);
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), expired]);
  } finally {
    clearTimeout(timer);
  }
}

export function cleanupExtension(name: string, cleanup: Cleanup): Promise<void> {
  return withDeadline(() => cleanup(), CLEANUP_TIMEOUT_MS, `Cleanup for extension ${name}`);
}

export async function activateExtension(
  url: string,
  name: string,
  registerTool: (tool: Tool) => void,
): Promise<Cleanup | undefined> {
  let registering = false;
  let abandoned = false;
  const api = Object.freeze({
    registerTool(tool: Tool): void {
      if (!registering) throw new Error("Tools can only be registered during activation.");
      registerTool(tool);
    },
  });
  try {
    return await withDeadline(async () => {
      const extension = await import(url);
      if (abandoned) return;
      const activate: unknown = extension.activate;
      if (typeof activate !== "function") throw new Error(`Extension ${name} must export activate(api).`);
      let cleanup: unknown;
      registering = true;
      try {
        const result: unknown = activate(api);
        cleanup = result === undefined || typeof result === "function" ? result : await result;
      } finally {
        registering = false;
      }
      if (cleanup !== undefined && typeof cleanup !== "function") {
        throw new Error(`Extension ${name} activate() must return void or a cleanup function.`);
      }
      if (abandoned) {
        if (cleanup) await cleanupExtension(name, cleanup as Cleanup);
        return;
      }
      return cleanup as Cleanup | undefined;
    }, ACTIVATION_TIMEOUT_MS, `Import/activation for extension ${name}`, () => {
      abandoned = true;
      registering = false;
    });
  } finally {
    registering = false;
  }
}