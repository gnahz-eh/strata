import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";

import { loadExtensions } from "../../src/extensions/index.js";
import type { Tool } from "../../src/core/tool.js";
import { bridge, deferred, fixture } from "./fixtures.js";

const toolExpression = `{
  name: "probe", description: "A fixture tool.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async run() { return "ok"; },
}`;

test("dispose is concurrent-idempotent, reverse ordered, and aggregates errors without skipping cleanup", async (context) => {
  const events: string[] = [];
  const firstError = new Error("first cleanup failed");
  const secondError = new Error("second cleanup failed");
  const shared = bridge(context, { events, firstError, secondError });
  const first = await fixture(context, `export function activate() {
    return () => { ${shared}.events.push("first"); throw ${shared}.firstError; };
  }`, { name: "first" });
  const second = await fixture(context, `export function activate() {
    return async () => { ${shared}.events.push("second"); throw ${shared}.secondError; };
  }`, { name: "second" });
  const loaded = await loadExtensions([first, second], { trusted: true, cwd: first });
  const disposal = loaded.dispose();
  assert.strictEqual(loaded.dispose(), disposal);
  await assert.rejects(disposal, (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [secondError, firstError]);
    return true;
  });
  await assert.rejects(loaded.dispose(), AggregateError);
  assert.deepEqual(events, ["second", "first"]);
});

test("activation failure rolls back earlier extensions and preserves the original error", async (context) => {
  const events: string[] = [];
  const original = new Error("activation failed");
  const shared = bridge(context, { events, original });
  const first = await fixture(context, `export function activate() {
    return () => { ${shared}.events.push("cleaned"); };
  }`);
  const failing = await fixture(context, `export async function activate() { throw ${shared}.original; }`);
  await assert.rejects(loadExtensions([first, failing], { trusted: true, cwd: first }), (error) => error === original);
  assert.deepEqual(events, ["cleaned"]);
});

test("rollback cleanup failures retain the activation error as cause and first aggregate entry", async (context) => {
  const original = new Error("activation failed");
  const cleanupError = new Error("cleanup failed");
  const shared = bridge(context, { original, cleanupError });
  const first = await fixture(context, `export function activate() { return () => { throw ${shared}.cleanupError; }; }`);
  const failing = await fixture(context, `export function activate() { throw ${shared}.original; }`);
  await assert.rejects(loadExtensions([first, failing], { trusted: true, cwd: first }), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.strictEqual(error.cause, original);
    assert.deepEqual(error.errors, [original, cleanupError]);
    return true;
  });
});

test("activation timeout closes registration, rolls back, and cleans up a late successful activation", async (context) => {
  const started = deferred();
  const release = deferred();
  const cleaned = deferred();
  const state = { register: undefined as ((tool: Tool) => void) | undefined, earlierCleaned: false, lateEffects: 0 };
  const shared = bridge(context, { started, release, cleaned, state });
  const earlier = await fixture(context, `export function activate() { return () => { ${shared}.state.earlierCleaned = true; }; }`);
  const slow = await fixture(context, `export async function activate(api) {
    ${shared}.state.register = api.registerTool;
    ${shared}.started.resolve();
    await ${shared}.release.promise;
    ${shared}.state.lateEffects += 1;
    return () => { ${shared}.cleaned.resolve(); };
  }`);
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const loading = loadExtensions([earlier, slow], { trusted: true, cwd: earlier });
  const rejected = assert.rejects(loading, /Import\/activation.*timed out after 10000 ms/);
  await started.promise;
  context.mock.timers.tick(10_000);
  await rejected;
  assert.equal(state.earlierCleaned, true);
  assert.throws(() => state.register!({} as Tool), /only.*during activation/);
  release.resolve();
  await cleaned.promise;
  await nextTurn();
  assert.equal(state.lateEffects, 1);
});

test("cleanup timeout continues reverse disposal and observes a later rejection", async (context) => {
  const started = deferred();
  const release = deferred();
  const events: string[] = [];
  const shared = bridge(context, { started, release, events });
  const first = await fixture(context, `export function activate() { return () => { ${shared}.events.push("first"); }; }`);
  const slow = await fixture(context, `export function activate() { return async () => {
    ${shared}.events.push("slow");
    ${shared}.started.resolve();
    await ${shared}.release.promise;
    throw new Error("late cleanup rejection");
  }; }`);
  const loaded = await loadExtensions([first, slow], { trusted: true, cwd: first });
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const disposal = loaded.dispose();
  const rejected = assert.rejects(disposal, (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.match(String(error.errors[0]), /Cleanup.*timed out after 5000 ms/);
    return true;
  });
  await started.promise;
  context.mock.timers.tick(5_000);
  await rejected;
  assert.deepEqual(events, ["slow", "first"]);
  assert.strictEqual(loaded.dispose(), disposal);
  release.resolve();
  await nextTurn();
});

test("duplicate tool names across extensions fail without renaming and roll back prior activations", async (context) => {
  const events: string[] = [];
  const shared = bridge(context, events);
  const first = await fixture(context, `export function activate(api) {
    api.registerTool(${toolExpression});
    return () => { ${shared}.push("first"); };
  }`, { name: "first" });
  const second = await fixture(context, `export function activate(api) { api.registerTool(${toolExpression}); }`, { name: "second" });
  await assert.rejects(loadExtensions([first, second], { trusted: true, cwd: first }), /Duplicate tool name: probe/);
  assert.deepEqual(events, ["first"]);
});

test("duplicates within one activation are rejected", async (context) => {
  const directory = await fixture(context, `export function activate(api) {
    api.registerTool(${toolExpression});
    api.registerTool(${toolExpression});
  }`);
  await assert.rejects(loadExtensions([directory], { trusted: true, cwd: directory }), /Duplicate tool name: probe/);
});

test("catching a registration error cannot make a load succeed, and its returned cleanup still runs", async (context) => {
  const events: string[] = [];
  const shared = bridge(context, events);
  const earlier = await fixture(context, `export function activate() { return () => { ${shared}.push("earlier"); }; }`);
  const invalid = await fixture(context, `export function activate(api) {
    try { api.registerTool({}); } catch {}
    return () => { ${shared}.push("invalid"); };
  }`);
  await assert.rejects(loadExtensions([earlier, invalid], { trusted: true, cwd: earlier }), /Invalid tool name/);
  assert.deepEqual(events, ["invalid", "earlier"]);
});

for (const [label, source, expected] of [
  ["top-level import failure", 'throw new Error("top-level failure");', /top-level failure/],
  ["missing named activate export", "export default function activate() {}", /must export activate/],
  ["non-callable activate export", "export const activate = 7;", /must export activate/],
  ["invalid synchronous activation result", "export function activate() { return 7; }", /void or a cleanup function/],
  ["invalid asynchronous activation result", "export async function activate() { return {}; }", /void or a cleanup function/],
] as const) {
  test(`${label} rolls back earlier extensions`, async (context) => {
    const state = { cleaned: false };
    const shared = bridge(context, state);
    const earlier = await fixture(context, `export function activate() { return () => { ${shared}.cleaned = true; }; }`);
    const invalid = await fixture(context, source);
    await assert.rejects(loadExtensions([earlier, invalid], { trusted: true, cwd: earlier }), expected);
    assert.equal(state.cleaned, true);
  });
}

test("manifest read/validation failure rolls back all earlier activations in reverse order", async (context) => {
  const events: string[] = [];
  const shared = bridge(context, events);
  const first = await fixture(context, `export function activate() { return () => { ${shared}.push("first"); }; }`);
  const second = await fixture(context, `export function activate() { return () => { ${shared}.push("second"); }; }`);
  const invalid = await fixture(context, "export function activate() {}", { version: "invalid" });
  await assert.rejects(loadExtensions([first, second, invalid], { trusted: true, cwd: first }), /Invalid extension manifest/);
  assert.deepEqual(events, ["second", "first"]);
});

test("asynchronous activation may register until its returned promise settles", async (context) => {
  const state = { cleaned: false };
  const shared = bridge(context, state);
  const directory = await fixture(context, `export async function activate(api) {
    await Promise.resolve();
    api.registerTool(${toolExpression});
    return async () => { await Promise.resolve(); ${shared}.cleaned = true; };
  }`);
  const loaded = await loadExtensions([directory], { trusted: true, cwd: directory });
  assert.equal(await loaded.tools[0]!.run({}), "ok");
  await loaded.dispose();
  assert.equal(state.cleaned, true);
});

test("synchronous activation closes registration before queued microtasks run", async (context) => {
  const state = { error: undefined as unknown };
  const shared = bridge(context, state);
  const directory = await fixture(context, `export function activate(api) {
    queueMicrotask(() => {
      try { api.registerTool(${toolExpression}); } catch (error) { ${shared}.error = error; }
    });
  }`);
  const loaded = await loadExtensions([directory], { trusted: true, cwd: directory });
  assert.match(String(state.error), /only.*during activation/);
  assert.deepEqual(loaded.tools, []);
  await loaded.dispose();
});

for (const outcome of ["resolve", "reject"] as const) {
  test(`import timeout handles a later ${outcome} without calling activate`, async (context) => {
    const started = deferred();
    const release = deferred();
    const finished = deferred();
    const state = { activations: 0 };
    const shared = bridge(context, { started, release, finished, state });
    const directory = await fixture(context, `
      ${shared}.started.resolve();
      try { await ${shared}.release.promise; } finally { ${shared}.finished.resolve(); }
      export function activate() { ${shared}.state.activations += 1; }
    `);
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const rejected = assert.rejects(loadExtensions([directory], { trusted: true, cwd: directory }), /Import\/activation.*timed out/);
    await started.promise;
    context.mock.timers.tick(10_000);
    await rejected;
    if (outcome === "resolve") release.resolve();
    else release.reject(new Error("late import rejection"));
    await finished.promise;
    await nextTurn();
    assert.equal(state.activations, 0);
  });
}

for (const phase of ["activation", "late cleanup"] as const) {
  test(`a ${phase} rejection after timeout is observed`, async (context) => {
    const started = deferred();
    const release = deferred();
    const finished = deferred();
    const shared = bridge(context, { started, release, finished });
    const rejection = `${shared}.finished.resolve(); throw new Error("late rejection");`;
    const directory = await fixture(context, `export async function activate() {
      ${shared}.started.resolve();
      await ${shared}.release.promise;
      ${phase === "activation" ? rejection : `return () => { ${rejection} };`}
    }`);
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const rejected = assert.rejects(loadExtensions([directory], { trusted: true, cwd: directory }), /Import\/activation.*timed out/);
    await started.promise;
    context.mock.timers.tick(10_000);
    await rejected;
    release.resolve();
    await finished.promise;
    await nextTurn();
  });
}