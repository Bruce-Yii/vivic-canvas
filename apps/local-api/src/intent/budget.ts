import { boundedTimeout } from "../config.js";

/** One disposable deadline includes fetch, response bodies and all retries. */
export const createBudget = (timeoutMs: number, signals: (AbortSignal | undefined)[] = []) => {
  const controller = new AbortController();
  const forward = (signal: AbortSignal) => controller.abort(signal.reason);
  const listeners = signals.filter((s): s is AbortSignal => !!s).map((signal) => {
    const listener = () => forward(signal);
    if (signal.aborted) listener();
    else signal.addEventListener("abort", listener, { once: true });
    return { signal, listener };
  });
  const timer = setTimeout(() => controller.abort(new DOMException("Deadline exceeded", "TimeoutError")),
    boundedTimeout(timeoutMs, 45_000));
  timer.unref?.();
  const signal = controller.signal;
  return {
    signal,
    /** Also bounds injected transports that ignore AbortSignal. */
    async run<T>(work: () => Promise<T>): Promise<T> {
      signal.throwIfAborted();
      let listener: () => void = () => {};
      const aborted = new Promise<never>((_, reject) => {
        listener = () => reject(signal.reason);
        signal.addEventListener("abort", listener, { once: true });
      });
      try {
        const value = await Promise.race([Promise.resolve().then(() => {
          signal.throwIfAborted();
          return work();
        }), aborted]);
        signal.throwIfAborted();
        return value;
      } finally {
        signal.removeEventListener("abort", listener);
      }
    },
    dispose() {
      clearTimeout(timer);
      for (const { signal, listener } of listeners) signal.removeEventListener("abort", listener);
    },
  };
};
