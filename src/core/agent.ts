import { realpathSync } from "node:fs";
import { Ajv, type ValidateFunction } from "ajv";

import { abortable, deadline } from "./abort.js";
import type { CompletionOptions, ModelClient, Message, MessageParam, ToolResultBlockParam } from "./client.js";
import { INTERRUPTED_RESULT, validateHistory } from "./history.js";
import type { PermissionPolicy } from "./permissions.js";
import { streamModel } from "./stream.js";
import type { Tool, ToolContext } from "./tool.js";

export type StopReason = Message["stop_reason"] | "aborted" | "max_turns" | "context_limit" | "token_limit" | "tool_limit";
export type Event =
  | { kind: "textDelta"; text: string }
  | { kind: "assistant"; message: Message }
  | { kind: "toolCall"; name: string; input: unknown; toolUseId: string }
  | { kind: "toolResult"; toolUseId: string; name: string; output: string; isError: boolean }
  | { kind: "end"; stopReason: StopReason };

export const DEFAULT_LIMITS = Object.freeze({
  maxTurns: 20,
  maxContextBytes: 256_000,
  maxToolOutputBytes: 30_000,
  maxToolCallsPerTurn: 16,
  maxRunTokens: 100_000,
  requestTimeoutMs: 120_000,
  toolTimeoutMs: 120_000,
  runTimeoutMs: 900_000,
});
export type RuntimeLimits = { -readonly [Key in keyof typeof DEFAULT_LIMITS]: number };

export interface AgentOptions {
  client: ModelClient;
  tools: Tool[];
  permissions: PermissionPolicy;
  systemPrompt: string;
  cwd?: string;
  messages?: MessageParam[];
  limits?: Partial<RuntimeLimits>;
  checkpoint?: (messages: MessageParam[]) => Promise<void>;
}

export function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return `Error: ${String(error)}`;
  const code = "code" in error && typeof error.code === "string" ? ` [${error.code}]` : "";
  return `${error.name}${code}: ${error.message}`;
}

function boundedText(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const suffix = "\n<truncated>";
  const bytes = Buffer.from(text);
  let end = Math.max(0, maxBytes - Buffer.byteLength(suffix));
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8") + suffix;
}

export class Agent {
  readonly client: ModelClient;
  readonly permissions: PermissionPolicy;
  readonly systemPrompt: string;
  readonly cwd: string;
  readonly limits: RuntimeLimits;
  private readonly registered = new Map<string, { tool: Tool; validate: ValidateFunction }>();
  private readonly checkpoint?: AgentOptions["checkpoint"];
  private history: MessageParam[];
  private running = false;
  private persistenceFailed = false;
  private readonly pending = new Set<Promise<unknown>>();
  private active?: AbortController;

  constructor(opts: AgentOptions) {
    const ajv = new Ajv({ allErrors: true, strict: true, coerceTypes: false, useDefaults: false });
    for (const definition of opts.tools) {
      if (typeof definition.name !== "string" || definition.name.trim() !== definition.name || !/^[a-zA-Z0-9_-]{1,64}$/.test(definition.name)) throw new Error(`Invalid tool name: ${definition.name}`);
      if (this.registered.has(definition.name)) throw new Error(`Duplicate tool name: ${definition.name}`);
      if (typeof definition.run !== "function" || typeof definition.description !== "string" || !definition.description.trim()) throw new Error("Invalid tool implementation or description.");
      if (definition.inputSchema?.type !== "object") throw new Error("Tool schema must have type object.");
      if (definition.needsPermission !== undefined && typeof definition.needsPermission !== "boolean") throw new Error("Tool needsPermission must be a boolean.");
      const tool = Object.freeze({ ...definition, needsPermission: definition.needsPermission ?? true, inputSchema: structuredClone(definition.inputSchema) });
      const validate = ajv.compile(tool.inputSchema);
      if ("$async" in validate && validate.$async) throw new Error("Tool schemas must be synchronous.");
      this.registered.set(tool.name, { tool, validate });
    }
    this.client = opts.client;
    this.permissions = opts.permissions;
    this.systemPrompt = opts.systemPrompt;
    this.cwd = realpathSync(opts.cwd ?? process.cwd());
    for (const name of Object.keys(opts.limits ?? {})) {
      if (!Object.hasOwn(DEFAULT_LIMITS, name)) throw new Error(`Unknown runtime limit: ${name}`);
    }
    this.limits = Object.freeze({ ...DEFAULT_LIMITS, ...opts.limits });
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new Error(`Invalid runtime limit: ${name}`);
    }
    if (this.limits.maxToolOutputBytes < 128) throw new Error("Tool output budget must be at least 128 bytes.");
    this.history = validateHistory(opts.messages ?? [], true);
    this.checkpoint = opts.checkpoint;
  }

  get messages(): MessageParam[] { return structuredClone(this.history); }
  get tools(): Tool[] { return [...this.registered.values()].map(({ tool }) => ({ ...tool, inputSchema: structuredClone(tool.inputSchema) })); }
  get hasPendingOperations(): boolean { return this.pending.size > 0; }
  abort(): void { this.active?.abort(); }

  async waitForIdle(signal?: AbortSignal): Promise<void> {
    if (this.running) throw new Error("Drain or close the active query before waiting for pending operations.");
    const settlement = Promise.allSettled([...this.pending]).then(() => {});
    if (signal) await abortable(settlement, signal);
    else await settlement;
  }

  async *query(userInput: string, options: CompletionOptions = {}): AsyncGenerator<Event> {
    if (this.running || this.hasPendingOperations) throw new Error("Agent is busy; a previous operation has not settled.");
    if (this.persistenceFailed) throw new Error("Session persistence failed; reopen the session before continuing.");
    if (!userInput.trim()) throw new Error("Prompt must not be empty.");
    if (Buffer.byteLength(userInput) > this.limits.maxContextBytes) throw new Error("Prompt exceeds the context byte budget.");
    options.signal?.throwIfAborted();
    this.running = true;
    this.active = new AbortController();
    const onAbort = () => this.active?.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const scope = deadline(this.limits.runTimeoutMs, this.active.signal);
    let tokens = 0;

    try {
      this.history.push({ role: "user", content: userInput });
      await this.save();
      for (let turn = 0; turn < this.limits.maxTurns; turn += 1) {
        scope.signal.throwIfAborted();
        if (Buffer.byteLength(JSON.stringify({ system: this.systemPrompt, messages: this.history, tools: this.tools })) > this.limits.maxContextBytes) {
          yield { kind: "end", stopReason: "context_limit" };
          return;
        }
        if (tokens >= this.limits.maxRunTokens) {
          yield { kind: "end", stopReason: "token_limit" };
          return;
        }
        const stream = streamModel(this.client, this.messages, this.systemPrompt, this.tools, {
          signal: scope.signal, onText: options.onText,
          timeoutMs: this.limits.requestTimeoutMs, maxBytes: this.limits.maxContextBytes,
          track: (operation) => this.track(operation),
        });
        let response: Message;
        try {
          while (true) {
            const next = await stream.next();
            if (next.done) { response = next.value; break; }
            yield { kind: "textDelta", text: next.value };
          }
        } finally {
          await stream.return(undefined as never);
        }
        scope.signal.throwIfAborted();
        if (Buffer.byteLength(JSON.stringify(response)) > this.limits.maxContextBytes) throw new Error("Model response exceeded the byte budget.");
        if (!response.usage || !Number.isFinite(response.usage.input_tokens) || !Number.isFinite(response.usage.output_tokens)) {
          throw new Error("Model returned invalid token usage.");
        }
        tokens += Math.max(0, response.usage.input_tokens) + Math.max(0, response.usage.output_tokens);
        const content = structuredClone(response.content);
        const calls = content.filter((block) => block.type === "tool_use");
        if (response.stop_reason !== "tool_use" && calls.length || response.stop_reason === "tool_use" && !calls.length) {
          throw new Error("Model stop reason and tool calls disagree.");
        }
        const assistant: MessageParam = { role: "assistant", content };
        const results: ToolResultBlockParam[] = calls.map((call) => ({
          type: "tool_result", tool_use_id: call.id, content: INTERRUPTED_RESULT, is_error: true,
        }));
        validateHistory([assistant, ...(results.length ? [{ role: "user", content: results }] : [])]);
        this.history.push(assistant);
        if (results.length) this.history.push({ role: "user", content: results });
        await this.save();
        yield { kind: "assistant", message: structuredClone(response) };
        scope.signal.throwIfAborted();

        if (!calls.length) {
          yield { kind: "end", stopReason: response.stop_reason };
          return;
        }
        if (calls.length > this.limits.maxToolCallsPerTurn) {
          for (const result of results) result.content = "Tool batch exceeds the configured limit; no tools were executed.";
          await this.save();
          yield { kind: "end", stopReason: "tool_limit" };
          return;
        }
        for (const [index, call] of calls.entries()) {
          scope.signal.throwIfAborted();
          yield { kind: "toolCall", name: call.name, input: structuredClone(call.input), toolUseId: call.id };
          scope.signal.throwIfAborted();
          const { output, isError } = await this.runOne(call.name, call.input, scope.signal);
          results[index] = { type: "tool_result", tool_use_id: call.id, content: output, is_error: isError };
          await this.save();
          yield { kind: "toolResult", toolUseId: call.id, name: call.name, output, isError };
          scope.signal.throwIfAborted();
          if (this.hasPendingOperations) throw new Error("An operation ignored cancellation; runtime is blocked until it settles. Inspect side effects before continuing.");
        }
      }
      scope.signal.throwIfAborted();
      yield { kind: "end", stopReason: "max_turns" };
    } catch (error) {
      if (!scope.signal.aborted) throw error;
      yield { kind: "end", stopReason: "aborted" };
    } finally {
      scope.abort();
      scope.dispose();
      options.signal?.removeEventListener("abort", onAbort);
      this.active = undefined;
      this.running = false;
    }
  }

  private async save(): Promise<void> {
    try { await this.checkpoint?.(this.messages); }
    catch (error) { this.persistenceFailed = true; throw error; }
  }

  private track<Value>(operation: Promise<Value>): Promise<Value> {
    this.pending.add(operation);
    void operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation));
    return operation;
  }

  private failure(output: string): { output: string; isError: boolean } {
    return { output: boundedText(output, this.limits.maxToolOutputBytes), isError: true };
  }

  private async runOne(name: string, input: unknown, signal: AbortSignal): Promise<{ output: string; isError: boolean }> {
    const entry = this.registered.get(name);
    if (!entry) return this.failure(`Unknown tool: ${name}`);
    if (!entry.validate(input)) {
      return this.failure(`Invalid tool input: ${entry.validate.errors?.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ")}`);
    }
    const scope = deadline(this.limits.toolTimeoutMs, signal);
    const context: ToolContext = { cwd: this.cwd, signal: scope.signal, maxOutputBytes: this.limits.maxToolOutputBytes };
    let work: Promise<string> | undefined;
    let settled = false;
    try {
      const decision = await abortable(this.track(Promise.resolve().then(() => this.permissions.request({ ...entry.tool, inputSchema: structuredClone(entry.tool.inputSchema) }, structuredClone(input), context))), scope.signal);
      scope.signal.throwIfAborted();
      if (!decision.allowed) return this.failure(`Permission denied (${decision.reason ?? "unspecified"}).`);
      work = this.track(Promise.resolve().then(() => {
        scope.signal.throwIfAborted();
        return entry.tool.run(structuredClone(input), context);
      }));
      void work.then(() => { settled = true; }, () => { settled = true; });
      const output = await abortable(work, scope.signal);
      if (typeof output !== "string") throw new Error("Tool must return a string.");
      return { output: boundedText(output, this.limits.maxToolOutputBytes), isError: false };
    } catch (error) {
      if (work && !settled) {
        const cleanup = deadline(2_000);
        try { await abortable(work, cleanup.signal); } catch {}
        finally { cleanup.dispose(); }
      }
      return this.failure(errorMessage(error));
    } finally {
      scope.dispose();
    }
  }
}