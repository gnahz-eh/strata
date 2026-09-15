import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCliArgs } from "../../src/cli/args.js";
import { DEFAULT_MODEL } from "../../src/providers/anthropic.js";
import { DEFAULT_OPENAI_MODEL } from "../../src/providers/openai.js";

const runtimeDefaults = {
  cwd: process.cwd(), session: undefined, json: false, readOnly: false,
  extensions: [], trustExtensions: false, limits: {},
};

test("CLI defaults to interactive permission checks", () => {
  assert.deepEqual(parseCliArgs([], {}), {
    ...runtimeDefaults,
    provider: "anthropic",
    model: DEFAULT_MODEL,
    mode: "ask",
    prompt: undefined,
    help: false,
  });
});

test("CLI parses model, one-shot prompt, and approval mode", () => {
  assert.deepEqual(parseCliArgs(["--model", "test-model", "--accept-all", "-p", "Inspect source"], {}), {
    ...runtimeDefaults,
    provider: "anthropic",
    model: "test-model",
    mode: "accept",
    prompt: "Inspect source",
    help: false,
  });
  assert.equal(parseCliArgs(["--prompt", "Long option"], {}).prompt, "Long option");
});

test("CLI parses help without exiting the process", () => {
  assert.equal(parseCliArgs(["--help"], {}).help, true);
  assert.equal(parseCliArgs(["-h"], {}).help, true);
  assert.equal(parseCliArgs(["--provider", "openai", "--help"], {}).help, true);
});

test("CLI rejects unknown options, positionals, and missing values", () => {
  assert.throws(() => parseCliArgs(["--unknown"], {}), { code: "ERR_PARSE_ARGS_UNKNOWN_OPTION" });
  assert.throws(() => parseCliArgs(["unexpected"], {}), { code: "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL" });
  assert.throws(() => parseCliArgs(["--model"], {}), { code: "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" });
  assert.throws(() => parseCliArgs(["--provider"], {}), { code: "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" });
});

test("CLI chooses the OpenAI default model when only the provider is specified", () => {
  assert.deepEqual(parseCliArgs(["--provider", "openai"], {}), {
    ...runtimeDefaults,
    provider: "openai",
    model: DEFAULT_OPENAI_MODEL,
    mode: "ask",
    prompt: undefined,
    help: false,
  });
});

test("CLI validates execution budgets and explicit extension trust", () => {
  for (const value of ["0", "-1", "NaN", "1.5", "999999999999"]) {
    assert.throws(() => parseCliArgs(["--max-turns", value], {}));
  }
  assert.throws(() => parseCliArgs(["--extension", "plugin"], {}), /trust/);
  assert.throws(() => parseCliArgs(["--read-only", "--accept-all"], {}), /cannot be combined/);
  assert.throws(() => parseCliArgs(["--json"], {}), /requires/);
  assert.throws(() => parseCliArgs(["-p", " "], {}), /empty/);
  const options = parseCliArgs(["--extension", "one", "--extension", "two", "--trust-extensions", "--timeout", "5", "--max-turns", "2"], {});
  assert.deepEqual(options.extensions, ["one", "two"]);
  assert.deepEqual(options.limits, { maxTurns: 2, runTimeoutMs: 5000 });
  assert.equal(parseCliArgs(["--help"], { STRATA_PROVIDER: "invalid" }).help, true);
});

test("CLI reads provider and model from the environment with command-line overrides", () => {
  const environment = { STRATA_PROVIDER: "openai", STRATA_MODEL: "environment-model" };
  const fromEnvironment = parseCliArgs([], environment);
  assert.equal(fromEnvironment.provider, "openai");
  assert.equal(fromEnvironment.model, "environment-model");

  const override = parseCliArgs(["--provider", "anthropic", "--model", "explicit-model"], environment);
  assert.equal(override.provider, "anthropic");
  assert.equal(override.model, "explicit-model");
  assert.equal(parseCliArgs([], { STRATA_PROVIDER: "openai" }).model, DEFAULT_OPENAI_MODEL);
});

test("CLI rejects unsupported providers including prototype names", () => {
  for (const provider of ["invalid", "constructor", "toString"]) {
    assert.throws(() => parseCliArgs(["--provider", provider], {}), /Unsupported provider/);
  }
  assert.throws(() => parseCliArgs([], { STRATA_PROVIDER: "invalid" }), /Unsupported provider/);
});