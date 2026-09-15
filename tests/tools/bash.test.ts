import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { unwatchFile, watchFile } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import type { ToolContext } from "../../src/core/tool.js";
import { bashTool } from "../../src/tools/bash.js";

async function workspace(testContext: TestContext): Promise<ToolContext> {
  const cwd = await mkdtemp(join(tmpdir(), "strata-bash-"));
  testContext.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, signal: new AbortController().signal, maxOutputBytes: 30_000 };
}

function nodeCommand(source: string): string {
  const encoded = Buffer.from(source).toString("base64");
  return `"${process.execPath}" -e "eval(Buffer.from('${encoded}','base64').toString())"`;
}

const finiteLongCommand = nodeCommand("setTimeout(() => process.exit(0), 8000)");

test("bash pins cwd and returns stdout and stderr", { timeout: 10_000 }, async (testContext) => {
  const context = await workspace(testContext);
  const output = await bashTool.run({
    command: nodeCommand("process.stdout.write(process.cwd()); process.stderr.write('stderr-text');"), timeout: 5,
  }, context);
  assert.match(output, /^<exit code 0>\n/);
  assert.ok(output.includes(context.cwd));
  assert.ok(output.includes("stderr-text"));
  assert.equal(getEventListeners(context.signal, "abort").length, 0);
});

test("bash throws on nonzero exit with bounded stdout and stderr", { timeout: 10_000 }, async (testContext) => {
  const context = await workspace(testContext);
  await assert.rejects(bashTool.run({
    command: nodeCommand("process.stdout.write('before failure'); process.stderr.write('details'); process.exitCode = 7;"),
    timeout: 5,
  }, context), (error: Error) => {
    assert.match(error.message, /^<exit code 7>/);
    assert.match(error.message, /before failure/);
    assert.match(error.message, /details/);
    assert.ok(Buffer.byteLength(error.message) <= context.maxOutputBytes);
    return true;
  });
  assert.equal(getEventListeners(context.signal, "abort").length, 0);
});

test("bash counts output bytes and truncates without splitting UTF-8", { timeout: 10_000 }, async (testContext) => {
  const context = await workspace(testContext);
  const output = await bashTool.run({
    command: nodeCommand("process.stdout.write(String.fromCodePoint(0x1f600).repeat(100000)); process.stderr.write('end');"),
    timeout: 5,
  }, { ...context, maxOutputBytes: 103 });
  assert.ok(Buffer.byteLength(output) <= 103);
  assert.match(output, /<truncated, 400003 bytes total>$/);
  assert.ok(!output.includes("\ufffd"));
});

test("bash decodes split UTF-8 independently for stdout and stderr", { timeout: 10_000 }, async (testContext) => {
  const context = await workspace(testContext);
  const output = await bashTool.run({
    command: nodeCommand(`
      process.stdout.write(Buffer.from([0xf0]));
      setTimeout(() => process.stderr.write('stderr'), 30);
      setTimeout(() => process.stdout.write(Buffer.from([0x9f, 0x98, 0x80])), 60);
    `),
    timeout: 5,
  }, context);
  assert.ok(output.includes("\u{1f600}"));
  assert.ok(output.includes("stderr"));
  assert.ok(!output.includes("\ufffd"));
});

test("bash handles spawn errors and removes abort listeners", { timeout: 10_000 }, async (testContext) => {
  const context = await workspace(testContext);
  await assert.rejects(bashTool.run({ command: "echo test", timeout: 5 }, {
    ...context, cwd: join(context.cwd, "missing"),
  }), /shell error:.*ENOENT/);
  assert.equal(getEventListeners(context.signal, "abort").length, 0);
});

test("bash validates finite timeout bounds before spawning", async (testContext) => {
  const context = await workspace(testContext);
  for (const timeout of [0, -1, 121, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(bashTool.run({ command: "echo test", timeout }, context), /timeout/);
  }
  await assert.rejects(bashTool.run({ command: "" }, context), /nonempty/);
});

test("bash times out, closes the subprocess, and releases its signal listener", { timeout: 12_000 }, async (testContext) => {
  const context = await workspace(testContext);
  const started = Date.now();
  await assert.rejects(bashTool.run({ command: finiteLongCommand, timeout: 0.2 }, context), (error: Error) => {
    assert.equal(error.name, "TimeoutError");
    assert.match(error.message, /timeout after 0.2s/);
    assert.ok(!error.message.includes("cleanup failed"), error.message);
    return true;
  });
  assert.ok(Date.now() - started < 7000);
  assert.equal(getEventListeners(context.signal, "abort").length, 0);
});

test("bash rejects pre-aborted calls without starting a process", async (testContext) => {
  const context = await workspace(testContext);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(bashTool.run({
    command: nodeCommand("require('node:fs').writeFileSync('unexpected.txt', 'bad');"),
  }, { ...context, signal: controller.signal }), { name: "AbortError" });
  assert.deepEqual(await readdir(context.cwd), []);
});

test("bash handles an abort during signal listener attachment", { timeout: 12_000 }, async (testContext) => {
  const context = await workspace(testContext);
  const controller = new AbortController();
  const addEventListener = controller.signal.addEventListener.bind(controller.signal);
  testContext.mock.method(controller.signal, "addEventListener", (...args: Parameters<typeof addEventListener>) => {
    controller.abort(new Error("attachment race"));
    addEventListener(...args);
  });
  await assert.rejects(bashTool.run({ command: finiteLongCommand, timeout: 5 }, {
    ...context, signal: controller.signal,
  }), (error: Error) => {
    assert.equal(error.name, "AbortError");
    assert.match(error.message, /aborted/);
    assert.ok(!error.message.includes("cleanup failed"), error.message);
    return true;
  });
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

async function assertStopped(pid: number): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      if (process.platform === "linux") {
        const status = await readFile(`/proc/${pid}/stat`, "utf8");
        if (/\) [ZX] /.test(status)) return;
      }
    } catch (error) {
      if (["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }
    await delay(20);
  }
  assert.fail(`Subprocess ${pid} is still running.`);
}

for (const stop of ["abort", "timeout"] as const) {
  test(`bash ${stop} terminates a live child process tree before returning`, { timeout: 20_000 }, async (testContext) => {
    const context = await workspace(testContext);
    const controller = new AbortController();
    const readyPath = join(context.cwd, "ready.json");
    let readyTimer: NodeJS.Timeout;
    const ready = new Promise<void>((resolveReady, rejectReady) => {
      readyTimer = setTimeout(() => rejectReady(new Error("Child readiness deadline exceeded.")), 4000);
      watchFile(readyPath, { interval: 20 }, (current) => {
        if (current.isFile() && current.size > 0) resolveReady();
      });
    });
    const childSource = `
      const fs = require('node:fs');
      process.stdout.write('child-ready');
      fs.writeFileSync('ready.tmp', JSON.stringify([process.ppid, process.pid]));
      fs.renameSync('ready.tmp', 'ready.json');
      setTimeout(() => process.exit(0), 8000);
    `;
    const command = nodeCommand(`
      const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}], { stdio: 'inherit' });
      child.on('error', (error) => { throw error; });
      setTimeout(() => process.exit(0), 8000);
    `);
    const running = bashTool.run({ command, timeout: stop === "timeout" ? 3 : 6 }, {
      ...context, signal: controller.signal,
    }).then((output) => ({ output, error: undefined }), (error: Error) => ({ output: undefined, error }));
    let pids: number[] = [];
    try {
      await ready;
      pids = JSON.parse(await readFile(join(context.cwd, "ready.json"), "utf8")) as number[];
      if (stop === "abort") controller.abort(new Error("test cancellation"));
      const result = await running;
      assert.ok(result.error);
      assert.equal(result.error.name, stop === "abort" ? "AbortError" : "TimeoutError");
      assert.ok(!result.error.message.includes("cleanup failed"), result.error.message);
      assert.match(result.error.message, /child-ready/);
      for (const pid of pids) await assertStopped(pid);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    } finally {
      clearTimeout(readyTimer!);
      unwatchFile(readyPath);
      controller.abort();
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      await running;
    }
  });
}