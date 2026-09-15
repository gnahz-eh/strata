import { createInterface } from "node:readline";
import { stripVTControlCharacters } from "node:util";

export function terminalText(value: string): string {
  return stripVTControlCharacters(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

export async function readTerminalLine(prompt: string, signal?: AbortSignal): Promise<string | undefined> {
  if (signal?.aborted || process.stdin.readableEnded || process.stdin.destroyed) return undefined;
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (answer?: string) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      readline.removeAllListeners("SIGINT");
      readline.close();
      resolve(answer);
    };
    const onAbort = () => finish();
    readline.once("close", () => finish());
    readline.once("SIGINT", () => {
      process.emit("SIGINT");
      finish();
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    readline.question(prompt, (answer) => finish(answer));
    if (signal?.aborted) finish();
  });
}