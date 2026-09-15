import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { Ajv } from "ajv";

import type { Tool, ToolInputSchema } from "../core/tool.js";
import { activateExtension, cleanupExtension, type Cleanup } from "./lifecycle.js";

export interface ExtensionApi {
  readonly registerTool: (tool: Tool) => void;
}

export interface LoadedExtensions {
  tools: Tool[];
  identities: string[];
  dispose(): Promise<void>;
}

interface Manifest {
  name: string;
  version: string;
  apiVersion: 1;
  main: string;
}

const MANIFEST_MAX_BYTES = 64 * 1024;
const ENTRY_MAX_BYTES = 1024 * 1024;
const SEMVER = "(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)"
  + "(?:-(?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)"
  + "(?:\\.(?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*))*)?"
  + "(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?";
const validateManifest = new Ajv({ strict: true, allErrors: true }).compile<Manifest>({
  type: "object",
  additionalProperties: false,
  required: ["name", "version", "apiVersion", "main"],
  properties: {
    name: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}(?![\\s\\S])" },
    version: { type: "string", maxLength: 256, pattern: `^${SEMVER}(?![\\s\\S])` },
    apiVersion: { type: "integer", const: 1 },
    main: { type: "string", minLength: 1, maxLength: 1024 },
  },
});

function assertInside(root: string, file: string): void {
  const path = relative(root, file);
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error(`Extension file must stay inside its canonical root: ${file}`);
  }
}

async function readLocalFile(root: string, file: string, maxBytes: number): Promise<{ path: string; bytes: Buffer }> {
  assertInside(root, file);
  const path = await realpath(file);
  assertInside(root, path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`Extension file must be a regular file: ${path}`);
    if (info.size > maxBytes) throw new Error(`Extension file exceeds ${maxBytes} bytes: ${path}`);
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error(`Extension file exceeds ${maxBytes} bytes: ${path}`);
    return { path, bytes: bytes.subarray(0, length) };
  } finally {
    await handle.close();
  }
}

async function readExtension(directory: string, cwd: string) {
  if (typeof directory !== "string" || !directory.trim()) throw new Error("Extension directories must be nonempty paths.");
  const root = await realpath(resolve(cwd, directory));
  if (!(await stat(root)).isDirectory()) throw new Error(`Extension root must be a directory: ${root}`);
  const manifestFile = await readLocalFile(root, resolve(root, "strata-extension.json"), MANIFEST_MAX_BYTES);
  const manifest: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestFile.bytes));
  if (!validateManifest(manifest)) {
    throw new Error(`Invalid extension manifest at ${root}: ${JSON.stringify(validateManifest.errors)}`);
  }
  const main = manifest.main.replaceAll("\\", "/");
  if (isAbsolute(main) || win32.isAbsolute(main) || /[:?#\u0000]/.test(main)
    || main.split("/").includes("..") || !/\.(?:js|mjs)$/.test(main) || main.trim() !== main) {
    throw new Error(`Extension main must be a relative local .js or .mjs file: ${manifest.main}`);
  }
  const entry = await readLocalFile(root, resolve(root, main), ENTRY_MAX_BYTES);
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const identity = JSON.stringify({
    name: manifest.name,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    root,
    manifestSha256: hash(manifestFile.bytes),
    entrySha256: hash(entry.bytes),
  });
  return { manifest, entry, identity };
}

function freezeJson(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || value === null
    || !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error("Tool inputSchema must contain only JSON data.");
  }
  if (ancestors.has(value)) throw new Error("Tool inputSchema must not contain cycles.");
  ancestors.add(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) freezeJson(child, ancestors);
  ancestors.delete(value);
  Object.freeze(value);
}

function snapshotTool(value: Tool, ajv: Ajv): Tool {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A tool must be an object.");
  const { name, description, inputSchema, needsPermission, run } = value;
  if (typeof name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(name) || name.trim() !== name) {
    throw new Error("Invalid tool name; expected 1-64 letters, digits, underscores or hyphens.");
  }
  if (typeof description !== "string" || !description.trim()) throw new Error(`Tool ${name} must have a nonempty description.`);
  if (typeof run !== "function") throw new Error(`Tool ${name}.run must be callable.`);
  if (needsPermission !== undefined && typeof needsPermission !== "boolean") {
    throw new Error(`Tool ${name}.needsPermission must be a boolean.`);
  }
  const schema: unknown = structuredClone(inputSchema);
  freezeJson(schema);
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || !("type" in schema) || schema.type !== "object") {
    throw new Error(`Tool ${name}.inputSchema must be an object schema.`);
  }
  const validate = ajv.compile(schema);
  if ("$async" in validate && validate.$async) throw new Error(`Tool ${name}.inputSchema must be synchronous.`);
  return Object.freeze({ name, description, inputSchema: schema as ToolInputSchema, needsPermission: needsPermission ?? true, run });
}

export async function loadExtensions(
  directories: string[],
  options: { trusted: boolean; cwd: string },
): Promise<LoadedExtensions> {
  if (directories.length && options.trusted !== true) throw new Error("Explicit trust is required to load extensions.");
  const requestedDirectories = [...directories];
  const cwd = options.cwd;
  const tools: Tool[] = [];
  const identities: string[] = [];
  const names = new Set<string>();
  const cleanups: { name: string; run: Cleanup }[] = [];
  const ajv = new Ajv({ allErrors: true, strict: true, coerceTypes: false, useDefaults: false });
  let disposal: Promise<void> | undefined;
  const dispose = (): Promise<void> => disposal ??= Promise.resolve().then(async () => {
    const errors: unknown[] = [];
    for (const cleanup of [...cleanups].reverse()) {
      try { await cleanupExtension(cleanup.name, cleanup.run); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Extension cleanup failed.");
  });

  try {
    for (const directory of requestedDirectories) {
      const definition = await readExtension(directory, cwd);
      let registrationFailure: { error: unknown } | undefined;
      const url = pathToFileURL(definition.entry.path);
      url.searchParams.set("strataExtension", createHash("sha256").update(definition.identity).digest("hex"));
      const cleanup = await activateExtension(url.href, definition.manifest.name, (value) => {
        try {
          const tool = snapshotTool(value, ajv);
          if (names.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
          names.add(tool.name);
          tools.push(tool);
        } catch (error) {
          registrationFailure ??= { error };
          throw error;
        }
      });
      if (cleanup) cleanups.push({ name: definition.manifest.name, run: cleanup });
      if (registrationFailure) throw registrationFailure.error;
      identities.push(definition.identity);
    }
    return { tools, identities, dispose };
  } catch (error) {
    try { await dispose(); } catch (cleanupError) {
      const failures = cleanupError instanceof AggregateError ? cleanupError.errors : [cleanupError];
      throw new AggregateError([error, ...failures], "Extension load failed and rollback cleanup failed.", { cause: error });
    }
    throw error;
  }
}