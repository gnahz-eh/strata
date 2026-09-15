import pc from "picocolors";

import type { Event } from "../core/agent.js";
import { terminalText } from "./terminal.js";

const MAX_RESULT_PREVIEW = 1200;
const MAX_INPUT_PREVIEW = 400;

export function createRenderer(json = false): (event: Event) => void {
  let streamed = false;
  return (event) => {
    if (json) {
      process.stdout.write(JSON.stringify(event) + "\n");
      return;
    }
    if (event.kind === "textDelta") {
      streamed = true;
      process.stdout.write(terminalText(event.text));
      return;
    }
    if (event.kind === "assistant") {
      if (!streamed) process.stdout.write(terminalText(event.message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")));
      process.stdout.write("\n");
      streamed = false;
      return;
    }
    render(event);
  };
}

export function render(event: Event): void {
  switch (event.kind) {
    case "assistant":
      return;

    case "toolCall": {
      let args = JSON.stringify(event.input, null, 2);
      if (args.length > MAX_INPUT_PREVIEW) {
        args = args.slice(0, MAX_INPUT_PREVIEW) + "\n... (truncated)";
      }
      console.log();
      console.log(pc.cyan(`╭─ → ${terminalText(event.name)}`));
      for (const line of args.split("\n")) console.log(pc.cyan("│ ") + pc.dim(terminalText(line)));
      console.log(pc.cyan("╰─"));
      return;
    }

    case "toolResult": {
      const color = event.isError ? pc.red : pc.green;
      let preview = event.output;
      if (preview.length > MAX_RESULT_PREVIEW) {
        preview = preview.slice(0, MAX_RESULT_PREVIEW) + `\n... (${event.output.length} chars total)`;
      }
      const name = terminalText(event.name);
      const tag = event.isError ? ` ${name} (error)` : ` ${name}`;
      console.log(color(`╭─ ←${tag}`));
      for (const line of preview.split("\n")) console.log(color("│ ") + terminalText(line));
      console.log(color("╰─"));
      return;
    }

    case "end":
      if (event.stopReason && event.stopReason !== "end_turn" && event.stopReason !== "tool_use") {
        console.log(pc.dim(`(stop_reason: ${event.stopReason})`));
      }
      return;
  }
}