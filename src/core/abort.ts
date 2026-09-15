export function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Operation aborted", "AbortError");
}

export async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function deadline(milliseconds: number, parent?: AbortSignal): {
  signal: AbortSignal;
  abort(reason?: unknown): void;
  dispose(): void;
} {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", onAbort, { once: true });
  if (parent?.aborted) onAbort();
  const timer = setTimeout(() => controller.abort(new DOMException("Operation timed out", "TimeoutError")), milliseconds);
  return {
    signal: controller.signal,
    abort: (reason?: unknown) => controller.abort(reason),
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}