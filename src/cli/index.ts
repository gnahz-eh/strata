#!/usr/bin/env node
import { main } from "./main.js";
import { errorMessage } from "../core/agent.js";
import { terminalText } from "./terminal.js";

let outputFailed = false;

async function exit(code: number): Promise<void> {
  await Promise.all([process.stdout, process.stderr].map((stream) => new Promise<void>((resolve) => {
    if (stream.destroyed) resolve();
    else stream.write("", (error) => {
      if (error) outputFailed = true;
      resolve();
    });
  })));
  process.exitCode = outputFailed ? 1 : code;
  setTimeout(() => process.exit(outputFailed ? 1 : code), 2000).unref();
}

process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  outputFailed = true;
  process.exitCode = 1;
  process.emit("SIGINT");
  if (error.code !== "EPIPE") console.error(terminalText(error.message));
});
process.stderr.on("error", () => { outputFailed = true; process.exitCode = 1; process.emit("SIGINT"); });

main().then(exit, (error) => {
  console.error(terminalText(errorMessage(error)));
  return exit(1);
});