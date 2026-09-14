import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function testEnvironment(overrides = {}) {
  const environment = { ...process.env, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" };
  delete environment.STRATA_PROVIDER;
  delete environment.STRATA_MODEL;
  return { ...environment, ...overrides };
}

function runNode(args, environment = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env: testEnvironment(environment),
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.ifError(result.error);
  return result;
}

test("the build provides separate library, declaration, and CLI entry points", () => {
  assert.equal(manifest.name, "strata");
  assert.notEqual(manifest.main, manifest.bin.strata);
  assert.equal(manifest.exports["."].import, manifest.main);
  assert.equal(manifest.exports["."].types, manifest.types);
  for (const path of [manifest.main, manifest.types, manifest.bin.strata]) {
    assert.ok(existsSync(resolve(root, path)), `Missing build output: ${path}`);
  }
});

test("importing the package does not launch the CLI or require credentials", () => {
  const result = runNode(["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { Agent, Client, OpenAIClient, createClient, PermissionManager, ALL_TOOLS } from 'strata';
    assert.equal(typeof Agent, 'function');
    assert.equal(typeof Client, 'function');
    assert.equal(typeof OpenAIClient, 'function');
    assert.equal(typeof createClient, 'function');
    assert.equal(typeof PermissionManager, 'function');
    assert.equal(ALL_TOOLS.length, 4);
    console.log('import-ok');
  `]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "import-ok");
  assert.equal(result.stderr, "");
});

test("the built CLI displays help without credentials", () => {
  for (const provider of ["anthropic", "openai"]) {
    const result = runNode([manifest.bin.strata, "--provider", provider, "--help"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: strata/);
    assert.match(result.stdout, /--provider anthropic\|openai/);
    assert.equal(result.stderr, "");
  }
});

test("the built CLI reports missing credentials with exit code 2", () => {
  const result = runNode([manifest.bin.strata, "-p", "Do not call the model"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /ANTHROPIC_API_KEY is not set/);
  assert.equal(result.stdout, "");
});

test("the built CLI rejects unknown options", () => {
  const result = runNode([manifest.bin.strata, "--unknown"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ERR_PARSE_ARGS_UNKNOWN_OPTION/);
});

test("the built CLI requires only the selected provider's key", () => {
  const openai = runNode([manifest.bin.strata, "--provider", "openai", "-p", "Offline"], {
    ANTHROPIC_API_KEY: "offline-test-key",
  });
  assert.equal(openai.status, 2);
  assert.match(openai.stderr, /OPENAI_API_KEY is not set/);
  assert.doesNotMatch(openai.stderr, /ANTHROPIC_API_KEY/);

  const anthropic = runNode([manifest.bin.strata, "--provider", "anthropic", "-p", "Offline"], {
    OPENAI_API_KEY: "offline-test-key",
  });
  assert.equal(anthropic.status, 2);
  assert.match(anthropic.stderr, /ANTHROPIC_API_KEY is not set/);

  const fromEnvironment = runNode([manifest.bin.strata, "-p", "Offline"], {
    STRATA_PROVIDER: "openai",
  });
  assert.equal(fromEnvironment.status, 2);
  assert.match(fromEnvironment.stderr, /OPENAI_API_KEY is not set/);
});

test("the built CLI rejects unsupported providers before checking credentials", () => {
  const result = runNode([manifest.bin.strata, "--provider", "unknown"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported provider/);
});

test("the public factory selects clients and honors model overrides without requests", () => {
  const result = runNode(["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { Client, OpenAIClient, createClient, DEFAULT_MODEL, DEFAULT_OPENAI_MODEL } from 'strata';
    assert.ok(createClient('anthropic') instanceof Client);
    assert.ok(createClient('openai') instanceof OpenAIClient);
    assert.equal(createClient('anthropic').model, 'environment-model');
    assert.equal(createClient('openai').model, 'environment-model');
    assert.equal(createClient('openai', 'explicit-model').model, 'explicit-model');
    assert.equal(DEFAULT_MODEL, 'claude-sonnet-4-6');
    assert.equal(DEFAULT_OPENAI_MODEL, 'gpt-4.1-mini');
    assert.throws(() => createClient('unknown'), /Unsupported provider/);
    console.log('factory-ok');
  `], {
    ANTHROPIC_API_KEY: "offline-test-key",
    OPENAI_API_KEY: "offline-test-key",
    STRATA_MODEL: "environment-model",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "factory-ok");
  assert.equal(result.stderr, "");
});

test("the compiled OpenAI CLI streams from a local fixture without an Anthropic key", { timeout: 15_000 }, async (context) => {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const data of request) body += data;
    requests.push({ path: request.url, body: JSON.parse(body) });
    const result = {
      id: "chatcmpl-cli-test",
      object: "chat.completion.chunk",
      created: 0,
      model: "offline-model",
      choices: [{
        index: 0,
        delta: { role: "assistant", content: "OpenAI CLI works" },
        finish_reason: "stop",
        logprobs: null,
      }],
    };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify(result)}\n\ndata: [DONE]\n\n`);
  });
  let child;
  context.after(async () => {
    child?.kill();
    await new Promise((done, reject) => {
      server.close((error) => error ? reject(error) : done());
      server.closeAllConnections();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");

  child = spawn(process.execPath, [
    manifest.bin.strata, "--provider", "openai", "--model", "offline-model", "-p", "Hello",
  ], {
    cwd: root,
    env: testEnvironment({
      OPENAI_API_KEY: "offline-test-key",
      OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    }),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (data) => { stdout += data; });
  child.stderr.setEncoding("utf8").on("data", (data) => { stderr += data; });
  const [code] = await once(child, "close");

  assert.equal(code, 0, stderr);
  assert.equal(stdout.trim(), "OpenAI CLI works");
  assert.equal(stderr, "");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, "/v1/chat/completions");
  assert.equal(requests[0].body.model, "offline-model");
  assert.equal(requests[0].body.stream, true);
  assert.equal(requests[0].body.max_completion_tokens, 8192);
  assert.deepEqual(requests[0].body.tools.map((tool) => tool.function.name), ["bash", "read", "write", "glob"]);
});