import { WebSourceError } from "./web-safety.ts";

export const WEB_LIMITS = { dnsMs: 20_000, connectMs: 10_000, firstResponseMs: 30_000, pageMs: 60_000, batchSize: 3 } as const;

/** Cleans up timers/listeners on completion. The caller must pass this signal to I/O. */
export function deadline(ms: number, message: string, parent?: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  const timer = setTimeout(() => controller.abort(new WebSourceError(message, 504)), ms);
  parent?.addEventListener("abort", abort, { once: true });
  if (parent?.aborted) abort();
  return { signal: controller.signal, dispose() { clearTimeout(timer); parent?.removeEventListener("abort", abort); } };
}

export async function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  let abort!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([task, stopped]); }
  finally { signal.removeEventListener("abort", abort); }
}
