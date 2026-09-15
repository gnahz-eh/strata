import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test, type TestContext } from "node:test";

import type { MessageParam } from "../../src/core/client.js";
import { INTERRUPTED_RESULT } from "../../src/core/history.js";
import { FileSession, type SessionIdentity } from "../../src/sessions/index.js";
import { MAX_SESSION_BYTES } from "../../src/sessions/snapshot.js";

async function fixture(context: TestContext) {
  const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "strata-session-")));
  context.after(async () => { await fs.rm(directory, { recursive: true, force: true }); });
  const path = join(directory, "session.json");
  const identity: SessionIdentity = { cwd: directory, provider: "offline", model: "test", toolsHash: "tools-v1" };
  return { directory, path, identity };
}

function envelope(identity: SessionIdentity, messages: unknown = [], overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ version: 1, identity, messages, ...overrides });
}

async function symlinkOrSkip(context: TestContext, target: string, path: string, type: "file" | "dir") {
  try {
    await fs.symlink(target, path, process.platform === "win32" && type === "dir" ? "junction" : type);
    return true;
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      context.skip("Symbolic links are not available with this filesystem or account.");
      return false;
    }
    throw error;
  }
}

test("file sessions create, save, close, and reopen a canonical path", async (context) => {
  const { path, identity } = await fixture(context);
  const session = await FileSession.open(relative(process.cwd(), path), identity);
  assert.equal(session.path, path);
  assert.deepEqual(session.messages, []);
  assert.deepEqual(JSON.parse(await fs.readFile(path, "utf8")), { version: 1, identity, messages: [] });
  const metadata = JSON.parse(await fs.readFile(path + ".lock", "utf8"));
  assert.deepEqual(Object.keys(metadata).sort(), ["hostname", "pid", "token"]);
  assert.equal(metadata.pid, process.pid);
  assert.equal(metadata.hostname, hostname());
  assert.equal(typeof metadata.token, "string");
  assert.ok(metadata.token.length >= 32);
  const messages: MessageParam[] = [{ role: "user", content: "hello" }, { role: "assistant", content: "saved" }];
  await session.save(messages);
  assert.deepEqual(session.messages, messages);
  await session.close();
  await assert.rejects(fs.stat(path + ".lock"), { code: "ENOENT" });
  const reopened = await FileSession.open(path, identity);
  assert.deepEqual(reopened.messages, messages);
  await reopened.close();
});

test("a second writer cannot acquire or alter an existing lock", async (context) => {
  const { path, identity } = await fixture(context);
  const first = await FileSession.open(path, identity);
  const lockBytes = await fs.readFile(path + ".lock");
  const sessionBytes = await fs.readFile(path);
  await assert.rejects(FileSession.open(path, identity), /locked.*manually remove/is);
  assert.deepEqual(await fs.readFile(path + ".lock"), lockBytes);
  assert.deepEqual(await fs.readFile(path), sessionBytes);
  await first.close();
});

test("malformed, obsolete, incompatible, and invalid histories preserve original bytes", async (context) => {
  const { path, identity } = await fixture(context);
  const invalid = [
    "{ broken", "null", "[]", "{}", envelope(identity, [], { extra: true }),
    envelope(identity, [], { version: 2 }), envelope(identity, [], { version: "1" }),
    envelope(identity, [], { identity: { ...identity, extra: true } }),
    envelope(identity, [{ role: "system", content: "invalid" }]),
    envelope(identity, [{ role: "user", content: [{ type: "tool_result", tool_use_id: "missing" }] }]),
    ...(["cwd", "provider", "model", "toolsHash"] as const).map((key) => envelope({ ...identity, [key]: "different" })),
  ];
  for (const original of invalid) {
    await fs.writeFile(path, original);
    await assert.rejects(FileSession.open(path, identity), /session/i);
    assert.equal(await fs.readFile(path, "utf8"), original);
    await assert.rejects(fs.stat(path + ".lock"), { code: "ENOENT" });
  }
});

test("recovery persists unknown outcomes without running tools", async (context) => {
  const { path, identity } = await fixture(context);
  const pending: MessageParam[] = [{ role: "assistant", content: [
    { type: "tool_use", id: "first", name: "unregistered-side-effect", input: { path: "never-created" } },
    { type: "tool_use", id: "second", name: "another-tool", input: {} },
  ] }];
  await fs.writeFile(path, envelope(identity, pending));
  const session = await FileSession.open(path, identity);
  const expected = [...pending, { role: "user", content: [
    { type: "tool_result", tool_use_id: "first", content: INTERRUPTED_RESULT, is_error: true },
    { type: "tool_result", tool_use_id: "second", content: INTERRUPTED_RESULT, is_error: true },
  ] }];
  assert.deepEqual(session.messages, expected);
  assert.deepEqual(JSON.parse(await fs.readFile(path, "utf8")).messages, expected);
  await session.close();
  const reopened = await FileSession.open(path, identity);
  assert.deepEqual(reopened.messages, expected);
  await reopened.close();
});

test("save and getter state are deep copies, and close is idempotent", async (context) => {
  const { path, identity } = await fixture(context);
  const session = await FileSession.open(path, identity);
  const input = { nested: { value: "original" } };
  const messages: MessageParam[] = [
    { role: "assistant", content: [{ type: "tool_use", id: "call", name: "example", input }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: "done" }] },
  ];
  const saving = session.save(messages);
  input.nested.value = "mutated";
  messages.length = 0;
  await saving;
  const original = session.messages;
  assert.match(JSON.stringify(original), /original/);
  const copy = session.messages;
  copy[0]!.content = "changed";
  copy.length = 0;
  assert.deepEqual(session.messages, original);
  const closing = session.close();
  assert.equal(session.close(), closing);
  await closing;
  await session.close();
  await assert.rejects(session.save([]), /closed/);
  assert.deepEqual(session.messages, original);
});

test("overlapping saves are rejected and close waits for the accepted save", async (context) => {
  const { path, identity } = await fixture(context);
  const session = await FileSession.open(path, identity);
  const messages: MessageParam[] = [{ role: "user", content: "last snapshot" }];
  const saving = session.save(messages);
  await assert.rejects(session.save([]), /already in progress/);
  const closing = session.close();
  await assert.rejects(session.save([]), /closing/);
  await Promise.all([saving, closing]);
  const reopened = await FileSession.open(path, identity);
  assert.deepEqual(reopened.messages, messages);
  await reopened.close();
});

test("existing malformed or apparently stale locks are never removed", async (context) => {
  const { path, identity } = await fixture(context);
  const original = envelope(identity);
  await fs.writeFile(path, original);
  for (const lock of ["", "not json", JSON.stringify({ pid: 2147483647, hostname: hostname(), token: "old-owner" })]) {
    await fs.writeFile(path + ".lock", lock);
    await assert.rejects(FileSession.open(path, identity), /confirming the owner has stopped, manually remove/);
    assert.equal(await fs.readFile(path + ".lock", "utf8"), lock);
    assert.equal(await fs.readFile(path, "utf8"), original);
  }
});

test("lost ownership refuses saving and closing without removing another owner's lock", async (context) => {
  for (const mutation of ["removed", "replaced-with-same-token", "changed-token", "malformed"] as const) {
    await context.test(mutation, async (child) => {
      const { directory, path, identity } = await fixture(child);
      const session = await FileSession.open(path, identity);
      const original = await fs.readFile(path);
      const lock = await fs.readFile(path + ".lock", "utf8");
      if (mutation === "removed" || mutation === "replaced-with-same-token") await fs.rename(path + ".lock", path + ".displaced-lock");
      if (mutation === "replaced-with-same-token") await fs.writeFile(path + ".lock", lock);
      if (mutation === "changed-token") await fs.writeFile(path + ".lock", JSON.stringify({ ...JSON.parse(lock), token: "foreign-owner" }));
      if (mutation === "malformed") await fs.writeFile(path + ".lock", "foreign malformed lock");
      const foreign = mutation === "removed" ? undefined : await fs.readFile(path + ".lock");
      await assert.rejects(session.save([{ role: "user", content: "must not commit" }]), /lock ownership/);
      assert.deepEqual(await fs.readFile(path), original);
      assert.deepEqual(session.messages, []);
      assert.equal((await fs.readdir(directory)).some((name) => name.endsWith(".tmp")), false);
      const closing = session.close();
      await assert.rejects(closing, /lock ownership/);
      assert.equal(session.close(), closing);
      if (foreign) assert.deepEqual(await fs.readFile(path + ".lock"), foreign);
      else await assert.rejects(fs.stat(path + ".lock"), { code: "ENOENT" });
    });
  }
});

test("an old session cannot release a new session's lock", async (context) => {
  const { path, identity } = await fixture(context);
  const oldSession = await FileSession.open(path, identity);
  await fs.rename(path + ".lock", path + ".displaced-lock");
  const newSession = await FileSession.open(path, identity);
  const newLock = await fs.readFile(path + ".lock");
  await assert.rejects(oldSession.close(), /lock ownership/);
  assert.deepEqual(await fs.readFile(path + ".lock"), newLock);
  await newSession.save([{ role: "user", content: "new owner" }]);
  await newSession.close();
});

test("failed atomic writes preserve the old snapshot, memory, and clean temporary files", async (context) => {
  for (const phase of ["open", "stat", "write", "sync", "close", "rename"] as const) {
    await context.test(phase, async (child) => {
      const { directory, path, identity } = await fixture(child);
      const session = await FileSession.open(path, identity);
      const original = await fs.readFile(path);
      const originalOpen = fs.open.bind(fs);
      const failure = Object.assign(new Error(`simulated ${phase} failure`), { code: "EIO" });
      child.mock.method(fs, "open", async (...arguments_: Parameters<typeof fs.open>) => {
        const isTemporary = String(arguments_[0]).endsWith(".tmp");
        if (isTemporary && phase === "open") throw failure;
        const handle = await originalOpen(...arguments_);
        if (isTemporary) {
          assert.equal(arguments_[1], "wx");
          assert.equal(arguments_[2], 0o600);
          if (phase === "stat") {
            const originalStat = handle.stat.bind(handle);
            let failed = false;
            child.mock.method(handle, "stat", async (...statArguments: Parameters<typeof handle.stat>) => {
              if (!failed) { failed = true; throw failure; }
              return originalStat(...statArguments);
            });
          }
          if (phase === "write") child.mock.method(handle, "writeFile", async () => {
            await handle.write("partial snapshot");
            throw failure;
          });
          if (phase === "sync") child.mock.method(handle, "sync", async () => { throw failure; });
          if (phase === "close") {
            const originalClose = handle.close.bind(handle);
            let failed = false;
            child.mock.method(handle, "close", async () => {
              await originalClose();
              if (!failed) { failed = true; throw failure; }
            });
          }
        }
        return handle;
      });
      if (phase === "rename") child.mock.method(fs, "rename", async () => { throw failure; });
      await assert.rejects(session.save([{ role: "user", content: "uncommitted" }]), /simulated/);
      assert.deepEqual(await fs.readFile(path), original);
      assert.deepEqual(session.messages, []);
      assert.deepEqual((await fs.readdir(directory)).sort(), ["session.json", "session.json.lock"]);
      child.mock.restoreAll();
      await session.save([{ role: "user", content: "retry succeeded" }]);
      assert.equal(session.messages.length, 1);
      await session.close();
    });
  }
});

test("initial persistence failure releases its lock and temporary file", async (context) => {
  const { directory, path, identity } = await fixture(context);
  context.mock.method(fs, "rename", async () => { throw new Error("simulated initial rename failure"); });
  await assert.rejects(FileSession.open(path, identity), /simulated initial rename failure/);
  assert.deepEqual(await fs.readdir(directory), []);
});

test("partial lock initialization is rolled back without changing an existing session", async (context) => {
  const { directory, path, identity } = await fixture(context);
  const original = envelope(identity);
  await fs.writeFile(path, original);
  const originalOpen = fs.open.bind(fs);
  context.mock.method(fs, "open", async (...arguments_: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...arguments_);
    if (String(arguments_[0]).endsWith(".lock") && arguments_[1] === "wx") {
      context.mock.method(handle, "writeFile", async () => {
        await handle.write("partial lock metadata");
        throw new Error("simulated lock write failure");
      });
    }
    return handle;
  });
  await assert.rejects(FileSession.open(path, identity), /simulated lock write failure/);
  assert.equal(await fs.readFile(path, "utf8"), original);
  assert.deepEqual(await fs.readdir(directory), ["session.json"]);
});

test("ownership is checked again after the temporary file is synced", async (context) => {
  const { directory, path, identity } = await fixture(context);
  const session = await FileSession.open(path, identity);
  const original = await fs.readFile(path);
  const originalOpen = fs.open.bind(fs);
  context.mock.method(fs, "open", async (...arguments_: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...arguments_);
    if (String(arguments_[0]).endsWith(".tmp")) {
      const originalSync = handle.sync.bind(handle);
      context.mock.method(handle, "sync", async () => {
        await originalSync();
        await fs.writeFile(path + ".lock", "replacement during save");
      });
    }
    return handle;
  });
  await assert.rejects(session.save([{ role: "user", content: "must not commit" }]), /lock ownership/);
  assert.deepEqual(await fs.readFile(path), original);
  assert.deepEqual((await fs.readdir(directory)).sort(), ["session.json", "session.json.lock"]);
  await assert.rejects(session.close(), /lock ownership/);
  assert.equal(await fs.readFile(path + ".lock", "utf8"), "replacement during save");
});

test("oversized files and invalid UTF-8 fail closed without changing bytes", async (context) => {
  const { path, identity } = await fixture(context);
  const invalidUtf8 = Buffer.from(envelope(identity, [{ role: "user", content: "invalid-utf8" }]));
  invalidUtf8[invalidUtf8.indexOf("invalid-utf8")] = 0xff;
  for (const original of [Buffer.alloc(MAX_SESSION_BYTES + 1, 0x20), invalidUtf8]) {
    await fs.writeFile(path, original);
    await assert.rejects(FileSession.open(path, identity), /16 MiB|UTF-8/);
    assert.deepEqual(await fs.readFile(path), original);
    await assert.rejects(fs.stat(path + ".lock"), { code: "ENOENT" });
  }
});

test("invalid or oversized saves do not change the existing snapshot", async (context) => {
  const { directory, path, identity } = await fixture(context);
  const session = await FileSession.open(path, identity);
  const original = await fs.readFile(path);
  const invalid: MessageParam[] = [{ role: "assistant", content: [{ type: "tool_use", id: "pending", name: "example", input: {} }] }];
  await assert.rejects(session.save(invalid), /unanswered/);
  await assert.rejects(session.save([{ role: "user", content: "a".repeat(MAX_SESSION_BYTES) }]), /16 MiB/);
  assert.deepEqual(await fs.readFile(path), original);
  assert.deepEqual(session.messages, []);
  assert.equal((await fs.readdir(directory)).some((name) => name.endsWith(".tmp")), false);
  await session.close();
});

test("session symbolic links are refused without touching the linked target", async (context) => {
  const { directory, path, identity } = await fixture(context);
  const target = join(directory, "target.json");
  const original = envelope(identity);
  await fs.writeFile(target, original);
  if (!await symlinkOrSkip(context, target, path, "file")) return;
  await assert.rejects(FileSession.open(path, identity), /symbolic link/);
  assert.equal((await fs.lstat(path)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(target, "utf8"), original);
  await assert.rejects(fs.stat(path + ".lock"), { code: "ENOENT" });
});

test("lock symbolic links, including dangling ones, are refused and retained", async (context) => {
  const { directory, path, identity } = await fixture(context);
  const target = join(directory, "foreign.lock");
  await fs.writeFile(target, "foreign lock bytes");
  if (!await symlinkOrSkip(context, target, path + ".lock", "file")) return;
  await assert.rejects(FileSession.open(path, identity), /symbolic links/);
  assert.equal(await fs.readFile(target, "utf8"), "foreign lock bytes");
  await fs.unlink(target);
  await assert.rejects(FileSession.open(path, identity), /symbolic links/);
  assert.equal((await fs.lstat(path + ".lock")).isSymbolicLink(), true);
  await assert.rejects(fs.stat(target), { code: "ENOENT" });
  await assert.rejects(fs.stat(path), { code: "ENOENT" });
});

test("session parents containing symbolic links or junctions are refused", async (context) => {
  const { directory, identity } = await fixture(context);
  const target = join(directory, "real-parent");
  const alias = join(directory, "linked-parent");
  await fs.mkdir(target);
  if (!await symlinkOrSkip(context, target, alias, "dir")) return;
  await assert.rejects(FileSession.open(join(alias, "session.json"), identity), /without symbolic links/);
  assert.deepEqual(await fs.readdir(target), []);
});

test("identity cwd uses realpath while preserving and copying the caller's identity", async (context) => {
  const { directory, path, identity } = await fixture(context);
  const target = join(directory, "workspace");
  const alias = join(directory, "workspace-alias");
  await fs.mkdir(target);
  if (!await symlinkOrSkip(context, target, alias, "dir")) return;
  const requested = { ...identity, cwd: alias };
  const session = await FileSession.open(path, requested);
  assert.equal(requested.cwd, alias);
  requested.model = "mutated";
  await session.save([{ role: "user", content: "canonical identity" }]);
  const expected = { ...identity, cwd: await fs.realpath(target) };
  assert.deepEqual(JSON.parse(await fs.readFile(path, "utf8")).identity, expected);
  await session.close();
  const reordered = { toolsHash: expected.toolsHash, model: expected.model, provider: expected.provider, cwd: alias };
  const reopened = await FileSession.open(path, reordered);
  assert.equal(reopened.messages.length, 1);
  await reopened.close();
});

test("nonregular session and lock paths are refused without deleting directories", async (context) => {
  const { path, identity } = await fixture(context);
  await fs.mkdir(path);
  await assert.rejects(FileSession.open(path, identity), /regular files/);
  assert.equal((await fs.stat(path)).isDirectory(), true);
  await assert.rejects(fs.stat(path + ".lock"), { code: "ENOENT" });
  await fs.rmdir(path);
  await fs.mkdir(path + ".lock");
  await assert.rejects(FileSession.open(path, identity), /locked/);
  assert.equal((await fs.stat(path + ".lock")).isDirectory(), true);
});

test("session snapshots and locks have owner-only POSIX permissions", {
  skip: process.platform === "win32" ? "POSIX mode bits do not enforce Windows ACLs." : false,
}, async (context) => {
  const { path, identity } = await fixture(context);
  await fs.writeFile(path, envelope(identity), { mode: 0o666 });
  const session = await FileSession.open(path, identity);
  assert.equal((await fs.stat(path)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path + ".lock")).mode & 0o777, 0o600);
  await session.save([{ role: "user", content: "private snapshot" }]);
  assert.equal((await fs.stat(path)).mode & 0o777, 0o600);
  await session.close();
});

test("lock metadata changed during the final ownership read prevents commit", async (context) => {
  const { directory, path, identity } = await fixture(context);
  const session = await FileSession.open(path, identity);
  const original = await fs.readFile(path);
  const metadata = JSON.parse(await fs.readFile(path + ".lock", "utf8"));
  const foreign = JSON.stringify({ ...metadata, token: "changed-after-lock-read" });
  const originalLstat = fs.lstat.bind(fs);
  let lockChecks = 0;
  context.mock.method(fs, "lstat", async (...arguments_: Parameters<typeof fs.lstat>) => {
    if (String(arguments_[0]) === path + ".lock" && ++lockChecks === 4) {
      await fs.writeFile(path + ".lock", foreign);
    }
    return originalLstat(...arguments_);
  });
  await assert.rejects(session.save([{ role: "user", content: "must not commit" }]), /lock ownership/);
  assert.deepEqual(await fs.readFile(path), original);
  assert.deepEqual(session.messages, []);
  assert.equal((await fs.readdir(directory)).some((name) => name.endsWith(".tmp")), false);
  await assert.rejects(session.close(), /lock ownership/);
  assert.equal(await fs.readFile(path + ".lock", "utf8"), foreign);
});

test("close waits for failed writes and still releases the owned lock", async (context) => {
  const { directory, path, identity } = await fixture(context);
  const session = await FileSession.open(path, identity);
  const original = await fs.readFile(path);
  let started!: () => void;
  let resume!: () => void;
  const reachedSync = new Promise<void>((resolve) => { started = resolve; });
  const resumeSync = new Promise<void>((resolve) => { resume = resolve; });
  const originalOpen = fs.open.bind(fs);
  context.mock.method(fs, "open", async (...arguments_: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...arguments_);
    if (String(arguments_[0]).endsWith(".tmp")) {
      context.mock.method(handle, "sync", async () => {
        started();
        await resumeSync;
        throw new Error("simulated delayed sync failure");
      });
    }
    return handle;
  });
  const saving = assert.rejects(session.save([{ role: "user", content: "uncommitted" }]), /delayed sync failure/);
  await reachedSync;
  const closing = session.close();
  await assert.rejects(FileSession.open(path, identity), /locked/);
  await assert.rejects(session.save([]), /closing/);
  resume();
  await Promise.all([saving, closing]);
  assert.deepEqual(await fs.readFile(path), original);
  assert.deepEqual(await fs.readdir(directory), ["session.json"]);
});

test("persistence orders write, file sync, close, rename, then supported directory sync", async (context) => {
  const { directory, path, identity } = await fixture(context);
  const session = await FileSession.open(path, identity);
  const operations: string[] = [];
  const originalOpen = fs.open.bind(fs);
  context.mock.method(fs, "open", async (...arguments_: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...arguments_);
    if (String(arguments_[0]).endsWith(".tmp")) {
      const originalWrite = handle.writeFile.bind(handle);
      const originalSync = handle.sync.bind(handle);
      const originalClose = handle.close.bind(handle);
      context.mock.method(handle, "writeFile", async (...writeArguments: Parameters<typeof handle.writeFile>) => {
        operations.push("write");
        return originalWrite(...writeArguments);
      });
      context.mock.method(handle, "sync", async () => { operations.push("file sync"); await originalSync(); });
      context.mock.method(handle, "close", async () => { operations.push("close"); await originalClose(); });
    } else if (String(arguments_[0]) === directory) {
      const originalSync = handle.sync.bind(handle);
      context.mock.method(handle, "sync", async () => { operations.push("directory sync"); await originalSync(); });
    }
    return handle;
  });
  const originalRename = fs.rename.bind(fs);
  context.mock.method(fs, "rename", async (...arguments_: Parameters<typeof fs.rename>) => {
    operations.push("rename");
    await originalRename(...arguments_);
  });
  await session.save([{ role: "user", content: "ordered persistence" }]);
  assert.deepEqual(operations, ["write", "file sync", "close", "rename", ...(process.platform === "win32" ? [] : ["directory sync"])]);
  await session.close();
});

test("repair that would exceed the size limit preserves the unrepaired snapshot", async (context) => {
  const { path, identity } = await fixture(context);
  const messages: MessageParam[] = [
    { role: "user", content: "" },
    { role: "assistant", content: [{ type: "tool_use", id: "pending", name: "example", input: {} }] },
  ];
  messages[0]!.content = "a".repeat(MAX_SESSION_BYTES - Buffer.byteLength(envelope(identity, messages)));
  const original = envelope(identity, messages);
  assert.equal(Buffer.byteLength(original), MAX_SESSION_BYTES);
  await fs.writeFile(path, original);
  await assert.rejects(FileSession.open(path, identity), /16 MiB/);
  assert.equal(await fs.readFile(path, "utf8"), original);
  await assert.rejects(fs.stat(path + ".lock"), { code: "ENOENT" });
});

test("Unix directory sync distinguishes unsupported filesystems from uncertain commits", {
  skip: process.platform === "win32" ? "Directory fsync is not attempted on Windows." : false,
}, async (context) => {
  for (const code of ["EINVAL", "EIO"] as const) {
    await context.test(code, async (child) => {
      const { directory, path, identity } = await fixture(child);
      const session = await FileSession.open(path, identity);
      const messages: MessageParam[] = [{ role: "user", content: "renamed snapshot" }];
      const originalOpen = fs.open.bind(fs);
      child.mock.method(fs, "open", async (...arguments_: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...arguments_);
        if (String(arguments_[0]) === directory) {
          child.mock.method(handle, "sync", async () => { throw Object.assign(new Error("directory sync failure"), { code }); });
        }
        return handle;
      });
      if (code === "EINVAL") {
        await session.save(messages);
        assert.deepEqual(session.messages, messages);
      } else {
        await assert.rejects(session.save(messages), /durability is uncertain/);
        assert.deepEqual(session.messages, []);
        await assert.rejects(session.save([]), /previous session save may have committed/);
      }
      assert.deepEqual(JSON.parse(await fs.readFile(path, "utf8")).messages, messages);
      assert.equal((await fs.readdir(directory)).some((name) => name.endsWith(".tmp")), false);
      child.mock.restoreAll();
      await session.close();
      const reopened = await FileSession.open(path, identity);
      assert.deepEqual(reopened.messages, messages);
      await reopened.close();
    });
  }
});