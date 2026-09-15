/**
 * Embedding Strata in your own script.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/oneShot.ts
 */
import { Agent, Client, buildSystemPrompt, PermissionManager, readTool, globTool } from "../src/index.js";

const agent = new Agent({
  client: new Client(),
  tools: [readTool, globTool],
  permissions: new PermissionManager("deny"),
  systemPrompt: buildSystemPrompt(),
});

const prompt = "List the TypeScript files in src/ and tell me which is largest.";
for await (const event of agent.query(prompt)) {
  if (event.kind === "textDelta") process.stdout.write(event.text);
  if (event.kind === "end") console.log(`\nStopped: ${event.stopReason}`);
}
