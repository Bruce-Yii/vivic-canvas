import { abortError, checkSignal, ModelApiError } from "./errors.js";
import { MODEL_API_LIMITS } from "./types.js";

interface Waiting { start(): void; signal: AbortSignal; abort(): void }
class InferenceQueue {
  private active = false;
  private waiting: Waiting[] = [];

  async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    checkSignal(signal);
    await new Promise<void>((resolve, reject) => {
      if (!this.active) { this.active = true; resolve(); return; }
      if (this.waiting.length >= MODEL_API_LIMITS.inferenceQueueSize) { reject(new ModelApiError("busy")); return; }
      const pending: Waiting = {
        signal,
        start: resolve,
        abort: () => {
          this.waiting = this.waiting.filter(item => item !== pending);
          signal.removeEventListener("abort", pending.abort);
          reject(abortError(signal));
        },
      };
      this.waiting.push(pending);
      signal.addEventListener("abort", pending.abort, { once: true });
      if (signal.aborted) pending.abort();
    });
    try { checkSignal(signal); return await operation(); }
    finally {
      const next = this.waiting.shift();
      if (next) { next.signal.removeEventListener("abort", next.abort); next.start(); }
      else this.active = false;
    }
  }
}

// Different users/keys share the same Mac capacity. This scheduler never wraps LLM calls.
const queues = new Map<string, InferenceQueue>();
export function inferenceQueue(baseUrl: string): InferenceQueue {
  let queue = queues.get(baseUrl);
  if (!queue) { queue = new InferenceQueue(); queues.set(baseUrl, queue); }
  return queue;
}
