import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = resolve(root, "dist/cli/index.js");
const exampleExtension = resolve(root, "examples/extensions/project-info");
const model = "v1-offline-model";
const testTimeout = 20_000;
const childTimeout = 12_000;
const posixOnly = {
  timeout: testTimeout,
  skip: process.platform === "win32" ? "POSIX SIGINT delivery is unavailable on Windows." : false,
};

function childEnvironment(baseURL) {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (/^(STRATA|ANTHROPIC_|OPENAI_)/i.test(name)
      || /^(?:ALL|HTTP|HTTPS)_PROXY$/i.test(name)
      || /^(?:NODE_OPTIONS|FORCE_COLOR|NO_PROXY)$/i.test(name)) delete environment[name];
  }
  return {
    ...environment,
    OPENAI_API_KEY: "offline-v1-test-key",
    OPENAI_BASE_URL: baseURL,
    NO_PROXY: "127.0.0.1,localhost",
    NO_COLOR: "1",
  };
}

test("stdout storage failures cannot produce a successful CLI exit", { timeout: testTimeout }, async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "strata-output-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const preload = join(directory, "output-failure.mjs");
  await writeFile(preload, `
    const write = process.stdout.write;
    process.stdout.write = function(chunk, encoding, callback) {
      if (typeof chunk === 'string' && chunk.includes('Usage: strata')) {
        const failure = Object.assign(new Error('Output device full'), {code: 'ENOSPC'});
        const done = typeof encoding === 'function' ? encoding : callback;
        queueMicrotask(() => { this.emit('error', failure); done?.(failure); });
        return false;
      }
      return write.call(this, chunk, encoding, callback);
    };
  `);
  const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, cli, "--help"], {
    cwd: root, env: childEnvironment("http://127.0.0.1:1/v1"), stdio: ["ignore", "pipe", "pipe"], timeout: childTimeout,
  });
  context.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let stderr = "";
  child.stdout.resume();
  child.stderr.setEncoding("utf8").on("data", (data) => { stderr += data; });
  const [code] = await once(child, "close");
  assert.equal(code, 1, stderr);
  assert.match(stderr, /Output device full/);
});

function sendCompletion(response, { text = [], calls = [], usage = { prompt_tokens: 8, completion_tokens: 4 } } = {}) {
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const frame = (choices, extra = {}) => response.write(`data: ${JSON.stringify({
    id: "chatcmpl-v1-fixture",
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices,
    ...extra,
  })}\n\n`);
  const delta = (content, finishReason = null) => frame([{
    index: 0, delta: content, finish_reason: finishReason, logprobs: null,
  }]);
  delta({ role: "assistant" });
  for (const fragment of text) delta({ content: fragment });
  for (const [index, call] of calls.entries()) {
    delta({ tool_calls: [{ index, id: call.id, type: "function", function: {
      name: call.name, arguments: JSON.stringify(call.input),
    } }] });
  }
  delta({}, calls.length ? "tool_calls" : "stop");
  frame([], { usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } });
  response.end("data: [DONE]\n\n");
}

async function fixture(context, respond) {
  await access(cli).catch(() => assert.fail("Build production sources before running tests/v1.package.test.mjs."));
  const directory = await realpath(await mkdtemp(join(tmpdir(), "strata v1-")));
  const launchDirectory = join(directory, "launcher");
  await mkdir(launchDirectory);
  const requests = [];
  const failures = [];
  const children = [];
  const server = createServer((request, response) => {
    void (async () => {
      let serialized = "";
      for await (const chunk of request) serialized += chunk;
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      const received = {
        path: request.url,
        authorization: request.headers.authorization,
        body: JSON.parse(serialized),
      };
      requests.push(received);
      await respond(received, response, requests.length - 1);
    })().catch((error) => {
      failures.push(error);
      if (!response.headersSent) response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Local fixture failed", type: "invalid_request_error" } }));
    });
  });
  context.after(async () => {
    for (const running of children) {
      if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill("SIGKILL");
    }
    await Promise.allSettled(children.map((running) => running.done));
    if (server.listening) {
      await new Promise((done, reject) => {
        server.close((error) => error ? reject(error) : done());
        server.closeAllConnections();
      });
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    assert.deepEqual(failures, [], "The localhost HTTP fixture must complete without errors.");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseURL = `http://127.0.0.1:${address.port}/v1`;

  const start = (args, options = {}) => {
    const child = spawn(process.execPath, [
      cli, "--provider", "openai", "--model", options.model ?? model, "--cwd", directory, ...args,
    ], {
      cwd: launchDirectory,
      env: childEnvironment(baseURL),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: childTimeout,
      killSignal: "SIGKILL",
    });
    const output = { stdout: "", stderr: "" };
    child.stdout.setEncoding("utf8").on("data", (data) => { output.stdout += data; });
    child.stderr.setEncoding("utf8").on("data", (data) => { output.stderr += data; });
    const done = once(child, "close").then(([code, signal]) => {
      assert.equal(signal, null, `CLI child did not exit normally (${signal}). stderr: ${output.stderr}`);
      assert.equal(typeof code, "number", output.stderr);
      assert.deepEqual(failures, [], "The localhost HTTP fixture failed.");
      return { code, signal, pid: child.pid, ...output };
    });
    void done.catch(() => {});
    const running = { child, output, done };
    children.push(running);
    return running;
  };
  return { directory, requests, start, run: (args, options) => start(args, options).done };
}

function jsonEvents(result) {
  assert.ok(result.stdout.endsWith("\n"), `Expected newline-terminated JSONL: ${result.stdout}`);
  assert.doesNotMatch(result.stdout, /[\u0000-\u0008\u000b-\u001f\u007f]/);
  const lines = result.stdout.split("\n");
  assert.equal(lines.pop(), "");
  assert.ok(lines.length > 0);
  return lines.map((line) => {
    const event = JSON.parse(line);
    assert.equal(typeof event.kind, "string");
    return event;
  });
}

function ending(result, reason) {
  const events = jsonEvents(result);
  assert.equal(events.filter((event) => event.kind === "end").length, 1);
  assert.equal(events.at(-1).kind, "end");
  assert.equal(events.at(-1).stopReason, reason);
  return events;
}

async function missing(path) {
  await assert.rejects(lstat(path), { code: "ENOENT" });
}

async function extension(directory, name, source) {
  const path = join(directory, name);
  await mkdir(path);
  await writeFile(join(path, "strata-extension.json"), JSON.stringify({
    name, version: "1.0.0", apiVersion: 1, main: "index.mjs",
  }));
  await writeFile(join(path, "index.mjs"), source);
  return path;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function stalledCompletion(response) {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const disconnected = once(response, "close", { signal: AbortSignal.timeout(childTimeout + 1_000) });
  void disconnected.catch(() => {});
  response.flushHeaders();
  return disconnected;
}

function beforeExit(promise, running, milestone) {
  return Promise.race([
    promise,
    running.done.then((result) => {
      throw new Error(`CLI exited before ${milestone} (code ${result.code}): ${result.stderr}`);
    }),
  ]);
}

function stderrContains(running, text) {
  return new Promise((done, reject) => {
    const inspect = () => {
      if (running.output.stderr.includes(text)) {
        running.child.stderr.off("data", inspect);
        done();
      }
    };
    running.child.stderr.on("data", inspect);
    void running.done.then((result) => {
      running.child.stderr.off("data", inspect);
      if (result.stderr.includes(text)) done();
      else reject(new Error(`CLI exited before emitting ${JSON.stringify(text)}: ${result.stderr}`));
    }, (error) => {
      running.child.stderr.off("data", inspect);
      reject(error);
    });
    inspect();
  });
}

function interruptChild(running) {
  assert.ok(Number.isInteger(running.child.pid));
  assert.notEqual(running.child.pid, process.pid);
  assert.notEqual(running.child.pid, process.ppid);
  assert.equal(running.child.exitCode, null);
  assert.equal(running.child.signalCode, null);
  assert.equal(running.child.kill("SIGINT"), true);
}

test("extension cleanup timeout retains session ownership until explicit recovery", { timeout: testTimeout }, async (context) => {
  const local = await fixture(context, (_request, response) => sendCompletion(response, { text: ["Completed before cleanup"] }));
  const plugin = await extension(local.directory, "late-cleanup", `
    import { writeFile } from 'node:fs/promises';
    export function activate() {
      return async () => {
        await new Promise((resolve) => setTimeout(resolve, 6000));
        await writeFile(new URL('./late.txt', import.meta.url), 'cleanup settled');
      };
    }
  `);
  const result = await local.run(["--session", "cleanup.json", "--extension", plugin, "--trust-extensions", "--json", "-p", "test"]);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /Extension cleanup failed.*Session lock retained/);
  assert.equal(await readFile(join(plugin, "late.txt"), "utf8"), "cleanup settled");
  const sessionPath = join(local.directory, "cleanup.json");
  const snapshot = JSON.parse(await readFile(sessionPath, "utf8"));
  const lock = JSON.parse(await readFile(sessionPath + ".lock", "utf8"));
  assert.equal(lock.pid, result.pid);
  const { FileSession } = await import("../dist/index.js");
  await assert.rejects(() => FileSession.open(sessionPath, snapshot.identity), /Session is locked/);
  assert.equal(local.requests.length, 1);
});

test("the compiled --json CLI emits only JSONL text, assistant, and final events", { timeout: testTimeout }, async (context) => {
  const local = await fixture(context, (_request, response) => {
    sendCompletion(response, { text: ["Hello ", "JSONL.\nSecond line."] });
  });
  const result = await local.run(["--json", "-p", "Return a streamed answer"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  const events = ending(result, "end_turn");
  const text = events.filter((event) => event.kind === "textDelta");
  assert.ok(text.length > 0, "The CLI must expose streamed text as events.");
  assert.equal(text.map((event) => event.text).join(""), "Hello JSONL.\nSecond line.");
  const assistants = events.filter((event) => event.kind === "assistant");
  assert.equal(assistants.length, 1);
  assert.equal(assistants[0].message.content.filter((block) => block.type === "text").map((block) => block.text).join(""), "Hello JSONL.\nSecond line.");
  assert.ok(events.every((event) => ["textDelta", "assistant", "end"].includes(event.kind)));
  assert.equal(local.requests.length, 1);
  assert.equal(local.requests[0].authorization, "Bearer offline-v1-test-key");
  assert.equal(local.requests[0].body.model, model);
  assert.equal(local.requests[0].body.stream, true);
  assert.equal(local.requests[0].body.stream_options.include_usage, true);
  assert.equal(local.requests[0].body.store, false);
});

test("the compiled --json CLI requires a one-shot prompt before requesting a model", { timeout: testTimeout }, async (context) => {
  const local = await fixture(context, (_request, response) => sendCompletion(response, { text: ["unexpected"] }));
  const result = await local.run(["--json"]);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /--json requires.*-p/);
  assert.equal(result.stdout, "");
  assert.equal(local.requests.length, 0);
});

test("two compiled CLI processes resume session history and each release the lock", { timeout: testTimeout }, async (context) => {
  const local = await fixture(context, (_request, response, index) => {
    sendCompletion(response, { text: [index === 0 ? "Alpha saved." : "You said alpha."] });
  });
  const session = join(local.directory, "conversation.json");
  const first = await local.run(["--session", "conversation.json", "--json", "-p", "Remember alpha."]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.stderr, "");
  ending(first, "end_turn");
  await missing(session + ".lock");
  const initial = JSON.parse(await readFile(session, "utf8"));
  assert.equal(initial.identity.cwd, local.directory);
  assert.equal(initial.identity.provider, "openai");
  assert.equal(initial.identity.model, model);
  assert.deepEqual(initial.messages, [
    { role: "user", content: "Remember alpha." },
    { role: "assistant", content: [{ type: "text", text: "Alpha saved." }] },
  ]);

  const second = await local.run(["--session", "conversation.json", "--json", "-p", "What did I say?"]);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.stderr, "");
  ending(second, "end_turn");
  await missing(session + ".lock");
  assert.equal(local.requests.length, 2);
  assert.deepEqual(local.requests[0].body.messages.slice(1), [{ role: "user", content: "Remember alpha." }]);
  assert.deepEqual(local.requests[1].body.messages.slice(1), [
    { role: "user", content: "Remember alpha." },
    { role: "assistant", content: "Alpha saved." },
    { role: "user", content: "What did I say?" },
  ]);
  const resumed = JSON.parse(await readFile(session, "utf8"));
  assert.deepEqual(resumed.messages, [
    ...initial.messages,
    { role: "user", content: "What did I say?" },
    { role: "assistant", content: [{ type: "text", text: "You said alpha." }] },
  ]);
});

test("a compiled CLI session model conflict leaves the snapshot unchanged and unlocks", { timeout: testTimeout }, async (context) => {
  const local = await fixture(context, (_request, response) => sendCompletion(response, { text: ["Original answer."] }));
  const session = join(local.directory, "identity.json");
  const first = await local.run(["--session", "identity.json", "--json", "-p", "Original prompt."]);
  assert.equal(first.code, 0, first.stderr);
  const original = await readFile(session);
  const originalInfo = await stat(session, { bigint: true });
  await missing(session + ".lock");

  const conflict = await local.run([
    "--session", "identity.json", "--json", "-p", "This must not replace history.",
  ], { model: "incompatible-offline-model" });
  assert.equal(conflict.code, 1, conflict.stderr);
  assert.match(conflict.stderr, /[Ii]ncompatible session identity: model/);
  assert.equal(conflict.stdout, "");
  assert.equal(local.requests.length, 1);
  assert.deepEqual(await readFile(session), original);
  const currentInfo = await stat(session, { bigint: true });
  assert.deepEqual(
    { ino: currentInfo.ino, size: currentInfo.size, mtimeNs: currentInfo.mtimeNs },
    { ino: originalInfo.ino, size: originalInfo.size, mtimeNs: originalInfo.mtimeNs },
  );
  await missing(session + ".lock");
});

test("an untrusted compiled CLI extension is neither evaluated nor sent to a model", { timeout: testTimeout }, async (context) => {
  const local = await fixture(context, (_request, response) => sendCompletion(response, { text: ["unexpected"] }));
  const marker = join(local.directory, "untrusted-evaluated.txt");
  const selected = await extension(local.directory, "untrusted", `
    import { writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(marker)}, "evaluated");
    export function activate() {}
  `);
  const result = await local.run(["--extension", selected, "--json", "-p", "Do not evaluate the extension."]);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /--trust-extensions/);
  assert.equal(result.stdout, "");
  await missing(marker);
  assert.equal(local.requests.length, 0);
});

test("the trusted project-info example executes a model tool call in the selected cwd", { timeout: testTimeout }, async (context) => {
  const call = { id: "project-info-call", name: "project_info", input: {} };
  const local = await fixture(context, (_request, response, index) => {
    sendCompletion(response, index === 0 ? { calls: [call] } : { text: ["Project inspected."] });
  });
  const result = await local.run([
    "--extension", exampleExtension, "--trust-extensions", "--json", "-p", "Inspect this project.",
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  const events = ending(result, "end_turn");
  assert.equal(local.requests.length, 2);
  assert.ok(local.requests[0].body.tools.some((tool) => tool.function.name === "project_info"));
  assert.deepEqual(events.filter((event) => event.kind === "toolCall"), [
    { kind: "toolCall", name: call.name, input: call.input, toolUseId: call.id },
  ]);
  const results = events.filter((event) => event.kind === "toolResult");
  assert.equal(results.length, 1);
  assert.equal(results[0].toolUseId, call.id);
  assert.equal(results[0].name, call.name);
  assert.equal(results[0].isError, false);
  const expected = { cwd: local.directory, platform: process.platform };
  assert.deepEqual(JSON.parse(results[0].output), expected);
  const reply = local.requests[1].body.messages.find((message) => message.role === "tool");
  assert.ok(reply);
  assert.equal(reply.tool_call_id, call.id);
  assert.deepEqual(JSON.parse(reply.content), expected);
});

test("compiled read-only mode advertises only read/glob and explicitly read-only extensions", { timeout: testTimeout }, async (context) => {
  const local = await fixture(context, (_request, response) => sendCompletion(response, { text: ["Read-only tools inspected."] }));
  const selected = await extension(local.directory, "mixed-permissions", `
    export function activate(api) {
      for (const definition of [
        { name: "extension_read", needsPermission: false },
        { name: "extension_write", needsPermission: true },
        { name: "extension_default" },
      ]) {
        api.registerTool({
          ...definition,
          description: "A permission-filtering fixture.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          async run() { return "unused"; },
        });
      }
    }
  `);
  const result = await local.run([
    "--read-only", "--extension", exampleExtension, "--extension", selected,
    "--trust-extensions", "--json", "-p", "List the available tools.",
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  ending(result, "end_turn");
  assert.equal(local.requests.length, 1);
  assert.deepEqual(local.requests[0].body.tools.map((tool) => tool.function.name).sort(), [
    "extension_read", "glob", "project_info", "read",
  ]);
});

test("the compiled non-TTY default denies a write with an isError result and no filesystem changes", { timeout: testTimeout }, async (context) => {
  const call = { id: "denied-write", name: "write", input: { path: "denied-output/blocked.txt", content: "must not be written" } };
  const local = await fixture(context, (_request, response, index) => {
    sendCompletion(response, index === 0 ? { calls: [call] } : { text: ["The write was denied."] });
  });
  const result = await local.run(["--json", "-p", "Try to write a file without interactive permission."]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  const events = ending(result, "end_turn");
  const results = events.filter((event) => event.kind === "toolResult");
  assert.equal(results.length, 1);
  assert.equal(results[0].name, "write");
  assert.equal(results[0].toolUseId, call.id);
  assert.equal(results[0].isError, true);
  assert.match(results[0].output, /permission denied/i);
  await missing(join(local.directory, call.input.path));
  await missing(join(local.directory, "denied-output"));
  assert.equal(local.requests.length, 2);
  assert.ok(local.requests[0].body.tools.some((tool) => tool.function.name === "write"));
  const reply = local.requests[1].body.messages.find((message) => message.role === "tool");
  assert.ok(reply);
  assert.equal(reply.tool_call_id, call.id);
  assert.match(reply.content, /^Tool error: Permission denied/);
});

test("the compiled --accept-all CLI permits a write only within the selected temporary cwd", { timeout: testTimeout }, async (context) => {
  const call = { id: "accepted-write", name: "write", input: { path: "accepted/output.txt", content: "approved fixture output\n" } };
  const local = await fixture(context, (_request, response, index) => {
    sendCompletion(response, index === 0 ? { calls: [call] } : { text: ["The file was written."] });
  });
  const result = await local.run(["--accept-all", "--json", "-p", "Write the approved fixture file."]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  const events = ending(result, "end_turn");
  const results = events.filter((event) => event.kind === "toolResult");
  assert.equal(results.length, 1);
  assert.equal(results[0].toolUseId, call.id);
  assert.equal(results[0].isError, false);
  assert.equal(await readFile(join(local.directory, call.input.path), "utf8"), call.input.content);
  assert.equal(local.requests.length, 2);
});

test("the compiled --max-turns cap exits 3 even when the model keeps requesting tools", { timeout: testTimeout }, async (context) => {
  const local = await fixture(context, (_request, response, index) => {
    sendCompletion(response, { calls: [{ id: `loop-${index}`, name: "glob", input: { pattern: "*.txt" } }] });
  });
  const result = await local.run([
    "--max-turns", "2", "--session", "loop.json", "--json", "-p", "Keep listing files forever.",
  ]);
  assert.equal(result.code, 3, result.stderr);
  assert.equal(result.stderr, "");
  const events = ending(result, "max_turns");
  assert.equal(local.requests.length, 2);
  assert.deepEqual(events.filter((event) => event.kind === "toolCall").map((event) => event.toolUseId), ["loop-0", "loop-1"]);
  const results = events.filter((event) => event.kind === "toolResult");
  assert.equal(results.length, 2);
  assert.ok(results.every((event) => event.isError === false));
  await missing(join(local.directory, "loop.json.lock"));
});

test("a compiled CLI context budget below the serialized request makes no HTTP request", { timeout: testTimeout }, async (context) => {
  const local = await fixture(context, (_request, response) => sendCompletion(response, { text: ["unexpected"] }));
  const result = await local.run(["--max-context-bytes", "64", "--json", "-p", "x"]);
  assert.equal(result.code, 3, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(ending(result, "context_limit"), [{ kind: "end", stopReason: "context_limit" }]);
  assert.equal(local.requests.length, 0);
});

test("a compiled CLI prompt exceeding the direct byte budget fails before HTTP", { timeout: testTimeout }, async (context) => {
  const local = await fixture(context, (_request, response) => sendCompletion(response, { text: ["unexpected"] }));
  const result = await local.run(["--max-context-bytes", "1", "--json", "-p", "too long"]);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /prompt exceeds.*context byte budget/i);
  assert.equal(result.stdout, "");
  assert.equal(local.requests.length, 0);
});

test("the compiled --max-run-tokens budget stops before another tool-followup request", { timeout: testTimeout }, async (context) => {
  const local = await fixture(context, (_request, response, index) => {
    sendCompletion(response, {
      calls: [{ id: `token-${index}`, name: "glob", input: { pattern: "*.txt" } }],
      usage: { prompt_tokens: 7, completion_tokens: 5 },
    });
  });
  const result = await local.run(["--max-run-tokens", "10", "--json", "-p", "Stop when the token budget is spent."]);
  assert.equal(result.code, 3, result.stderr);
  assert.equal(result.stderr, "");
  ending(result, "token_limit");
  assert.equal(local.requests.length, 1);
});

test("the compiled request deadline aborts a stalled localhost stream without waiting for the run deadline", { timeout: testTimeout }, async (context) => {
  const started = deferred();
  const local = await fixture(context, (_request, response) => {
    started.resolve({ disconnected: stalledCompletion(response) });
  });
  const running = local.start(["--request-timeout", "1", "--timeout", "30", "--json", "-p", "Wait for a stalled stream."]);
  const connection = await beforeExit(started.promise, running, "the localhost model request");
  const result = await running.done;
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /timeout|timed out|did not stop/i);
  assert.equal(local.requests.length, 1);
  await connection.disconnected;
});

test("SIGINT to the compiled CLI cancels an active model request and releases its session lock", posixOnly, async (context) => {
  const started = deferred();
  const local = await fixture(context, (_request, response) => {
    started.resolve({ disconnected: stalledCompletion(response) });
  });
  const session = join(local.directory, "model-interrupt.json");
  const running = local.start([
    "--session", "model-interrupt.json", "--timeout", "30", "--request-timeout", "30",
    "--json", "-p", "Wait until interrupted.",
  ]);
  const connection = await beforeExit(started.promise, running, "the active model request");
  const lock = JSON.parse(await readFile(session + ".lock", "utf8"));
  assert.equal(lock.pid, running.child.pid);
  interruptChild(running);
  const result = await running.done;
  assert.equal(result.code, 130, result.stderr);
  assert.equal(result.stderr, "");
  ending(result, "aborted");
  await connection.disconnected;
  assert.equal(local.requests.length, 1);
  await missing(session + ".lock");
  const snapshot = JSON.parse(await readFile(session, "utf8"));
  assert.deepEqual(snapshot.messages, [{ role: "user", content: "Wait until interrupted." }]);
});

test("SIGINT to the compiled CLI awaits cooperative tool cleanup before unlocking", posixOnly, async (context) => {
  const call = { id: "interrupt-tool", name: "cooperative_tool", input: {} };
  const local = await fixture(context, (_request, response) => sendCompletion(response, { calls: [call] }));
  const stopped = join(local.directory, "tool-stopped.txt");
  const disposed = join(local.directory, "tool-disposed.txt");
  const selected = await extension(local.directory, "cooperative", `
    import { existsSync, writeFileSync } from "node:fs";
    export function activate(api) {
      api.registerTool({
        name: "cooperative_tool",
        description: "Wait for cancellation, then finish asynchronous cleanup.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        needsPermission: false,
        run(_input, context) {
          return new Promise((done) => {
            const finish = () => setTimeout(() => {
              writeFileSync(${JSON.stringify(stopped)}, "settled");
              done("cancelled");
            }, 25);
            context.signal.addEventListener("abort", finish, { once: true });
            if (context.signal.aborted) finish();
            process.stderr.write("fixture-tool-ready\\n");
          });
        },
      });
      return () => {
        if (!existsSync(${JSON.stringify(stopped)})) throw new Error("Tool disposed before settling.");
        writeFileSync(${JSON.stringify(disposed)}, "disposed");
      };
    }
  `);
  const session = join(local.directory, "tool-interrupt.json");
  const running = local.start([
    "--extension", selected, "--trust-extensions", "--session", "tool-interrupt.json",
    "--timeout", "30", "--json", "-p", "Run the cooperative tool.",
  ]);
  await stderrContains(running, "fixture-tool-ready\n");
  const lock = JSON.parse(await readFile(session + ".lock", "utf8"));
  assert.equal(lock.pid, running.child.pid);
  interruptChild(running);
  const result = await running.done;
  assert.equal(result.code, 130, result.stderr);
  assert.equal(result.stderr, "fixture-tool-ready\n");
  const events = ending(result, "aborted");
  const results = events.filter((event) => event.kind === "toolResult");
  assert.equal(results.length, 1);
  assert.equal(results[0].toolUseId, call.id);
  assert.equal(results[0].isError, true);
  assert.equal(await readFile(stopped, "utf8"), "settled");
  assert.equal(await readFile(disposed, "utf8"), "disposed");
  assert.equal(local.requests.length, 1);
  await missing(session + ".lock");
  const snapshot = JSON.parse(await readFile(session, "utf8"));
  const persisted = snapshot.messages.flatMap((message) => Array.isArray(message.content)
    ? message.content.filter((block) => block.type === "tool_result") : []);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].tool_use_id, call.id);
  assert.equal(persisted[0].is_error, true);
});

test("a compiled --timeout 1 retains the session lock when an extension tool never settles", { timeout: testTimeout }, async (context) => {
  const call = { id: "never-settles", name: "uncooperative_tool", input: {} };
  const local = await fixture(context, (_request, response) => sendCompletion(response, { calls: [call] }));
  const started = join(local.directory, "uncooperative-started.txt");
  const disposed = join(local.directory, "uncooperative-disposed.txt");
  const selected = await extension(local.directory, "uncooperative", `
    import { writeFileSync } from "node:fs";
    export function activate(api) {
      api.registerTool({
        name: "uncooperative_tool",
        description: "Ignore cancellation and never resolve.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        needsPermission: true,
        run() {
          writeFileSync(${JSON.stringify(started)}, "started");
          return new Promise(() => {});
        },
      });
      return () => writeFileSync(${JSON.stringify(disposed)}, "disposed");
    }
  `);
  const session = join(local.directory, "uncooperative.json");
  const result = await local.run([
    "--extension", selected, "--trust-extensions", "--accept-all", "--session", "uncooperative.json",
    "--timeout", "1", "--json", "-p", "Run the uncooperative tool.",
  ]);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /operation did not stop/i);
  assert.match(result.stderr, /session lock retained/i);
  assert.equal(await readFile(started, "utf8"), "started");
  const events = ending(result, "aborted");
  const results = events.filter((event) => event.kind === "toolResult");
  assert.equal(results.length, 1);
  assert.equal(results[0].toolUseId, call.id);
  assert.equal(results[0].isError, true);
  assert.equal(local.requests.length, 1);
  const lock = JSON.parse(await readFile(session + ".lock", "utf8"));
  assert.equal(lock.pid, result.pid);
  const snapshot = JSON.parse(await readFile(session, "utf8"));
  assert.ok(snapshot.messages.some((message) => Array.isArray(message.content)
    && message.content.some((block) => block.type === "tool_result" && block.tool_use_id === call.id && block.is_error === true)));
  await missing(disposed);
});