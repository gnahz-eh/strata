/**
 * Embedding Strata in your own script.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/oneShot.ts
 */
import { Agent, Client, buildSystemPrompt, PermissionManager, ALL_TOOLS } from "../src/index.js";

const agent = new Agent({
  client: new Client(),
  tools: ALL_TOOLS,
  // accept = no prompts. Only do this for read-only tasks or sandboxes.
  permissions: new PermissionManager("accept"),
  systemPrompt: buildSystemPrompt(),
});

const prompt = "List the TypeScript files in src/ and tell me which is largest.";
for await (const event of agent.query(prompt)) {
  console.log(`[${event.kind}]`, event);
}
