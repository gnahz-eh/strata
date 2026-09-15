import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, parse, resolve, sep } from "node:path";

import type { MessageParam } from "../core/client.js";
import { decodeSnapshot, encodeSnapshot, MAX_SESSION_BYTES, validateIdentity, type SessionIdentity } from "./snapshot.js";

export type { SessionIdentity } from "./snapshot.js";

interface Directory {
  path: string;
  stats: BigIntStats;
}

interface Lock {
  handle: FileHandle;
  stats: BigIntStats;
  metadata: { pid: number; hostname: string; token: string };
}

function errorCode(error: unknown): unknown {
  return error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function statIfPresent(path: string): Promise<BigIntStats | undefined> {
  try {
    return await fs.lstat(path, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

async function regularFile(path: string): Promise<BigIntStats | undefined> {
  const stats = await statIfPresent(path);
  if (stats?.isSymbolicLink()) throw new Error(`Refusing symbolic link session or lock file: ${path}`);
  if (stats && !stats.isFile()) throw new Error(`Session and lock paths must be regular files: ${path}`);
  return stats;
}

async function directoryStats(path: string): Promise<BigIntStats> {
  const stats = await fs.lstat(path, { bigint: true });
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Session parent must be an existing directory without symbolic links: ${path}`);
  }
  return stats;
}

async function inspectParent(path: string): Promise<Directory> {
  const parent = dirname(path);
  const root = parse(parent).root;
  let current = root;
  await directoryStats(current);
  for (const part of parent.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    await directoryStats(current);
  }
  const canonical = await fs.realpath(parent);
  return { path: canonical, stats: await directoryStats(canonical) };
}

function sizeError(limit: number): Error {
  return new Error(limit === MAX_SESSION_BYTES
    ? "Session snapshot exceeds the 16 MiB limit."
    : "Session lock metadata exceeds the 4 KiB limit.");
}

async function readBounded(path: string, limit: number): Promise<{ text: string; stats: BigIntStats } | undefined> {
  const before = await regularFile(path);
  if (!before) return undefined;
  if (before.size > BigInt(limit)) throw sizeError(limit);
  const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFile(before, opened)) throw new Error(`Session file changed while opening: ${path}`);
    if (opened.size > BigInt(limit)) throw sizeError(limit);
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, limit - total + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > limit) throw sizeError(limit);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    const current = await regularFile(path);
    if (!current || !sameFile(opened, current) || after.size !== opened.size ||
        after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs ||
        current.size !== after.size || current.mtimeNs !== after.mtimeNs || current.ctimeNs !== after.ctimeNs) {
      throw new Error(`Session file changed while reading: ${path}`);
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, total));
    } catch (cause) {
      throw new Error(`Session file must contain valid UTF-8: ${path}`, { cause });
    }
    return { text, stats: after };
  } finally {
    await handle.close();
  }
}

async function removeCreatedFile(path: string, expected?: BigIntStats): Promise<void> {
  const current = await regularFile(path);
  if (!current) return;
  if (!expected || !sameFile(current, expected)) throw new Error(`Refusing to remove an unverified or replaced session file: ${path}`);
  await fs.unlink(path);
}

function recoveryGuidance(path: string): string {
  return `Inspect the PID and hostname in ${path}. Only after confirming the owner has stopped, manually remove this lock. Locks are never evicted automatically.`;
}

async function acquireLock(path: string): Promise<Lock> {
  const occupied = `Session is locked: ${path} already exists (regular files and symbolic links are both refused). ${recoveryGuidance(path)}`;
  if (await statIfPresent(path)) throw new Error(occupied);
  let handle: FileHandle;
  try {
    handle = await fs.open(path, "wx", 0o600);
  } catch (cause) {
    if (errorCode(cause) === "EEXIST" || errorCode(cause) === "ELOOP") {
      throw new Error(occupied, { cause });
    }
    throw cause;
  }
  let stats: BigIntStats | undefined;
  try {
    stats = await handle.stat({ bigint: true });
    const current = await regularFile(path);
    if (!current || !sameFile(current, stats)) throw new Error("Session lock path changed during acquisition.");
    const metadata = { pid: process.pid, hostname: hostname(), token: randomUUID() };
    await handle.writeFile(JSON.stringify(metadata) + "\n", "utf8");
    await handle.sync();
    return { handle, stats, metadata };
  } catch (cause) {
    try {
      await removeCreatedFile(path, stats ?? await handle.stat({ bigint: true }));
    } catch (cleanupError) {
      throw new AggregateError([cause, cleanupError], `Session lock initialization and cleanup failed. ${recoveryGuidance(path)}`);
    } finally {
      await handle.close();
    }
    throw cause;
  }
}

async function assertOwnership(path: string, parent: Directory, lock: Lock): Promise<void> {
  const lockPath = path + ".lock";
  try {
    const currentParent = await inspectParent(path);
    if (currentParent.path !== parent.path || !sameFile(currentParent.stats, parent.stats)) {
      throw new Error("Session parent directory changed.");
    }
    const current = await readBounded(lockPath, 4096);
    if (!current || !sameFile(current.stats, lock.stats)) throw new Error("Lock file was removed or replaced.");
    const metadata: unknown = JSON.parse(current.text);
    if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata) ||
        Object.keys(metadata).length !== 3 ||
        !("token" in metadata) || metadata.token !== lock.metadata.token ||
        !("pid" in metadata) || metadata.pid !== lock.metadata.pid ||
        !("hostname" in metadata) || metadata.hostname !== lock.metadata.hostname) {
      throw new Error("Lock owner token or metadata changed.");
    }
  } catch (cause) {
    throw new Error(`Session lock ownership could not be verified; refusing to write or remove ${lockPath}. ${recoveryGuidance(lockPath)}`, { cause });
  }
}

async function releaseLock(path: string, parent: Directory, lock: Lock): Promise<void> {
  try {
    await assertOwnership(path, parent, lock);
    await fs.unlink(path + ".lock");
  } finally {
    await lock.handle.close();
  }
}

async function syncDirectory(parent: Directory): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const handle = await fs.open(parent.path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!sameFile(await handle.stat({ bigint: true }), parent.stats)) throw new Error("Session parent directory changed before sync.");
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (["EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(String(errorCode(error)))) return;
    throw error;
  }
}

export class FileSession {
  readonly path: string;
  #identity: SessionIdentity;
  #parent: Directory;
  #lock: Lock;
  #messages: MessageParam[] = [];
  #target: BigIntStats | undefined;
  #activeSave: Promise<void> | undefined;
  #closing: Promise<void> | undefined;
  #uncertain = false;

  private constructor(path: string, identity: SessionIdentity, parent: Directory, lock: Lock) {
    this.path = path;
    this.#identity = identity;
    this.#parent = parent;
    this.#lock = lock;
  }

  static async open(path: string, identity: SessionIdentity): Promise<FileSession> {
    if (typeof path !== "string" || path.length === 0 || path.includes("\0")) throw new Error("Invalid session path.");
    const requested = resolve(path);
    if (process.platform === "win32" && (/[<>:"|?*\x00-\x1f]/.test(basename(requested)) ||
        /[ .]$/.test(basename(requested)) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(basename(requested)))) {
      throw new Error("Invalid Windows session filename.");
    }
    const canonicalIdentity = validateIdentity(identity);
    canonicalIdentity.cwd = await fs.realpath(canonicalIdentity.cwd);
    if (!(await fs.stat(canonicalIdentity.cwd)).isDirectory()) throw new Error("Session identity cwd must be a directory.");
    const parent = await inspectParent(requested);
    const canonicalPath = join(parent.path, basename(requested));
    const lock = await acquireLock(canonicalPath + ".lock");
    const session = new FileSession(canonicalPath, canonicalIdentity, parent, lock);
    try {
      const stored = await readBounded(canonicalPath, MAX_SESSION_BYTES);
      const messages = stored ? decodeSnapshot(stored.text, canonicalIdentity, true) : [];
      session.#target = stored?.stats;
      await session.save(messages);
      return session;
    } catch (cause) {
      try {
        await session.close();
      } catch (cleanupError) {
        throw new AggregateError([cause, cleanupError], `Session open failed and its lock could not be released. ${recoveryGuidance(canonicalPath + ".lock")}`);
      }
      throw cause;
    }
  }

  get messages(): MessageParam[] {
    return structuredClone(this.#messages);
  }

  async save(messages: MessageParam[]): Promise<void> {
    if (this.#closing) throw new Error("Session is closed or closing.");
    if (this.#activeSave) throw new Error("Session save already in progress; await it before saving again.");
    if (this.#uncertain) throw new Error("A previous session save may have committed; close and reopen the session before continuing.");
    const snapshot = encodeSnapshot(this.#identity, messages);
    const saving = this.#persist(snapshot);
    this.#activeSave = saving;
    try {
      await saving;
    } finally {
      this.#activeSave = undefined;
    }
  }

  close(): Promise<void> {
    this.#closing ??= (async () => {
      await this.#activeSave?.catch(() => {});
      await releaseLock(this.path, this.#parent, this.#lock);
    })();
    return this.#closing;
  }

  async #assertTarget(): Promise<void> {
    const current = await regularFile(this.path);
    if (this.#target ? !current || !sameFile(current, this.#target) : current !== undefined) {
      throw new Error("Session snapshot was removed or replaced outside its lock; refusing to overwrite it.");
    }
  }

  async #persist(snapshot: ReturnType<typeof encodeSnapshot>): Promise<void> {
    await assertOwnership(this.path, this.#parent, this.#lock);
    await this.#assertTarget();
    const temporaryPath = join(this.#parent.path, `.session-${randomUUID()}.tmp`);
    let temporary: FileHandle | undefined;
    let temporaryStats: BigIntStats | undefined;
    let created = false;
    let renamed = false;
    try {
      temporary = await fs.open(temporaryPath, "wx", 0o600);
      created = true;
      temporaryStats = await temporary.stat({ bigint: true });
      await temporary.writeFile(snapshot.serialized, "utf8");
      await temporary.sync();
      await temporary.close();
      temporary = undefined;
      await assertOwnership(this.path, this.#parent, this.#lock);
      await this.#assertTarget();
      const current = await regularFile(temporaryPath);
      if (!current || !sameFile(current, temporaryStats)) throw new Error("Session temporary file was removed or replaced.");
      await fs.rename(temporaryPath, this.path);
      renamed = true;
      this.#target = temporaryStats;
      this.#uncertain = true;
      try {
        await syncDirectory(this.#parent);
      } catch (cause) {
        throw new Error("Session snapshot was replaced, but directory sync failed; durability is uncertain. Close and reopen before continuing.", { cause });
      }
      this.#messages = snapshot.messages;
      this.#uncertain = false;
    } finally {
      try {
        try {
          temporaryStats ??= await temporary?.stat({ bigint: true });
        } finally {
          await temporary?.close();
        }
      } finally {
        if (created && !renamed) await removeCreatedFile(temporaryPath, temporaryStats);
      }
    }
  }
}