import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { terminalText } from "../../src/cli/terminal.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const terminalModule = new URL("../../src/cli/terminal.ts", import.meta.url).href;
const rendererModule = new URL("../../src/cli/render.ts", import.meta.url).href;

async function runTerminal(source: string, closeInput = true) {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (/^(STRATA|ANTHROPIC_|OPENAI_)/i.test(name)) delete environment[name];
  }
  environment.OPENAI_API_KEY = "offline-terminal-test-key";
  environment.OPENAI_BASE_URL = "http://127.0.0.1:9/v1";
  environment.NO_COLOR = "1";
  delete environment.FORCE_COLOR;
  delete environment.NODE_OPTIONS;

  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    cwd: root,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 5_000,
    killSignal: "SIGKILL",
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (data: string) => { stdout += data; });
  child.stderr.setEncoding("utf8").on("data", (data: string) => { stderr += data; });
  const closed = once(child, "close");
  if (closeInput) child.stdin.end();
  try {
    const [code, signal] = await closed;
    assert.equal(signal, null, `Terminal child was killed (${signal}). stderr: ${stderr}`);
    assert.equal(code, 0, stderr);
    return { stdout, stderr };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    child.stdin.destroy();
  }
}

test("readTerminalLine returns without prompting when stdin is already at EOF", { timeout: 10_000 }, async () => {
  const result = await runTerminal(`
    import assert from "node:assert/strict";
    import { once } from "node:events";
    import { readTerminalLine } from ${JSON.stringify(terminalModule)};
    process.stdin.resume();
    await once(process.stdin, "end");
    assert.equal(process.stdin.readableEnded, true);
    assert.equal(await readTerminalLine("must-not-prompt> "), undefined);
    process.stdout.write("eof-ok\\n");
  `);
  assert.equal(result.stdout, "eof-ok\n");
  assert.equal(result.stderr, "");
});

test("readTerminalLine settles when stdin closes during a question", { timeout: 10_000 }, async () => {
  const result = await runTerminal(`
    import assert from "node:assert/strict";
    import { readTerminalLine } from ${JSON.stringify(terminalModule)};
    assert.equal(await readTerminalLine("waiting-for-eof> "), undefined);
    process.stdout.write("closed-ok\\n");
  `);
  assert.equal(result.stdout, "closed-ok\n");
  assert.equal(result.stderr, "waiting-for-eof> ");
});

test("readTerminalLine abort callback settles with an open stdin pipe", { timeout: 10_000 }, async () => {
  const result = await runTerminal(`
    import assert from "node:assert/strict";
    import { readTerminalLine } from ${JSON.stringify(terminalModule)};
    const controller = new AbortController();
    const answer = readTerminalLine("waiting-for-abort> ", controller.signal);
    setImmediate(() => controller.abort());
    assert.equal(await answer, undefined);
    process.stdout.write("aborted-ok\\n");
  `, false);
  assert.equal(result.stdout, "aborted-ok\n");
  assert.equal(result.stderr, "waiting-for-abort> ");
});

test("readTerminalLine does not prompt for an already-aborted signal", { timeout: 10_000 }, async () => {
  const result = await runTerminal(`
    import assert from "node:assert/strict";
    import { readTerminalLine } from ${JSON.stringify(terminalModule)};
    assert.equal(await readTerminalLine("must-not-prompt> ", AbortSignal.abort()), undefined);
    process.stdout.write("pre-aborted-ok\\n");
  `, false);
  assert.equal(result.stdout, "pre-aborted-ok\n");
  assert.equal(result.stderr, "");
});

test("terminalText removes ANSI, OSC and unsafe controls while preserving lines and tabs", () => {
  const text = "plain\t\u001b[31mred\u001b[0m\n"
    + "\u001b]0;untrusted-title\u0007"
    + "\u001b]8;;https://example.invalid\u001b\\link\u001b]8;;\u001b\\"
    + "\u0000\u0001\u0007\u0008\u000b\u000c\r\u000e\u001f\u007f";
  assert.equal(terminalText(text), "plain\tred\nlink");
});

test("createRenderer sanitizes malicious tool names and output in a subprocess", { timeout: 10_000 }, async () => {
  const name = "safe-tool\u001b]0;untrusted-title\u0007\u001b[2J\u0000\u0008\u007f";
  const events = [
    { kind: "toolCall", name, input: { path: "file.txt" }, toolUseId: "call-safe" },
    { kind: "toolResult", name, output: "\u001b[31mvisible-result\u001b[0m\u001b]0;result-title\u0007\u0008", toolUseId: "call-safe", isError: true },
  ];
  const result = await runTerminal(`
    import { createRenderer } from ${JSON.stringify(rendererModule)};
    const display = createRenderer();
    for (const event of ${JSON.stringify(events)}) display(event);
  `);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /[\u0000-\u0008\u000b-\u001f\u007f]/);
  assert.doesNotMatch(result.stdout, /untrusted-title|result-title/);
  assert.equal(result.stdout.match(/safe-tool/g)?.length, 2);
  assert.match(result.stdout, /safe-tool \(error\)/);
  assert.match(result.stdout, /visible-result/);
});

test("createRenderer prints streamed assistant text only once", { timeout: 10_000 }, async () => {
  const result = await runTerminal(`
    import { createRenderer } from ${JSON.stringify(rendererModule)};
    const display = createRenderer();
    display({ kind: "textDelta", text: "streamed answer" });
    display({ kind: "assistant", message: { role: "assistant", content: [{ type: "text", text: "streamed answer" }] } });
    display({ kind: "assistant", message: { role: "assistant", content: [{ type: "text", text: "fallback answer" }] } });
  `);
  assert.equal(result.stdout, "streamed answer\nfallback answer\n");
  assert.equal(result.stderr, "");
});

test("createRenderer JSON mode preserves events without terminal control bytes", { timeout: 10_000 }, async () => {
  const events = [
    { kind: "textDelta", text: "hello\n\u001b[31mworld" },
    { kind: "toolCall", name: "tool\u001b]0;title\u0007", input: {}, toolUseId: "json-call" },
    { kind: "toolResult", name: "tool\u001b]0;title\u0007", output: "result\nsecond line", toolUseId: "json-call", isError: false },
    { kind: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
    { kind: "end", stopReason: "end_turn" },
  ];
  const result = await runTerminal(`
    import { createRenderer } from ${JSON.stringify(rendererModule)};
    const display = createRenderer(true);
    for (const event of ${JSON.stringify(events)}) display(event);
  `);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /[\u0000-\u0008\u000b-\u001f\u007f]/);
  assert.ok(result.stdout.endsWith("\n"));
  assert.deepEqual(result.stdout.trimEnd().split("\n").map((line) => JSON.parse(line)), events);
});