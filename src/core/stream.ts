import { abortable, deadline } from "./abort.js";
import type { CompletionOptions, Message, MessageParam, ModelClient } from "./client.js";
import type { Tool } from "./tool.js";

export async function* streamModel(
  client: ModelClient,
  messages: MessageParam[],
  system: string,
  tools: Tool[],
  options: CompletionOptions & {
    signal: AbortSignal; timeoutMs: number; maxBytes: number;
    track: (operation: Promise<Message>) => Promise<Message>;
  },
): AsyncGenerator<string, Message> {
  const scope = deadline(options.timeoutMs, options.signal);
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  let finished = false;
  let response: Message | undefined;
  let failure: unknown;
  let bytes = 0;
  const operation = options.track(Promise.resolve().then(() => {
    scope.signal.throwIfAborted();
    return client.complete(messages, system, tools, {
      signal: scope.signal,
      onText(delta) {
        if (finished || scope.signal.aborted) return;
        bytes += Buffer.byteLength(delta);
        if (bytes > options.maxBytes) {
          scope.abort(new Error("Model response exceeded the configured byte budget."));
          return;
        }
        queue.push(delta);
        wake?.();
      },
    });
  }));
  void abortable(operation, scope.signal).then(
    (message) => { response = message; },
    (error: unknown) => { failure = error; },
  ).finally(() => {
    finished = true;
    wake?.();
  });

  try {
    while (!finished || queue.length) {
      if (queue.length) {
        const delta = queue.shift()!;
        options.onText?.(delta);
        yield delta;
      } else {
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    }
    if (failure !== undefined) throw failure;
    if (!response) throw new Error("Model returned no response.");
    return response;
  } finally {
    scope.abort();
    scope.dispose();
  }
}