import { abortError, checkAbort } from "./models";
import type { SpeechRequest, SpeechResponse } from "./protocol";

type Command = SpeechRequest extends infer R ? R extends SpeechRequest ? Omit<R, "id"> : never : never;
interface Pending { resolve: (message: SpeechResponse) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

/** All heavyweight inference stays off the UI thread. Termination also releases WASM memory. */
export class SpeechWorkerClient {
  private worker: Worker;
  private pending = new Map<number, Pending>();
  private serial = 0;
  private closed = false;
  private readonly signal?: AbortSignal;
  private readonly abort = () => this.close();
  constructor(options: { signal?: AbortSignal; onEvent?: (message: SpeechResponse) => void; onFailure?: (error: Error) => void; workerFactory?: () => Worker } = {}) {
    checkAbort(options.signal);
    this.signal = options.signal;
    this.worker = options.workerFactory?.() ?? new Worker(new URL("./speech.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (event: MessageEvent<SpeechResponse>) => {
      const message = event.data;
      const pending = this.pending.get(message.id);
      if (!pending || this.closed) return;
      if (["ack", "transcript", "segment", "error"].includes(message.type)) {
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.type === "error") pending.reject(new Error(message.message));
        else pending.resolve(message);
      }
      options.onEvent?.(message);
    };
    const failure = () => {
      const error = new Error("本地语音 Worker 失败，请使用 PTT 或文字。");
      this.close(error); options.onFailure?.(error);
    };
    this.worker.onerror = failure;
    this.worker.onmessageerror = failure;
    this.signal?.addEventListener("abort", this.abort, { once: true });
  }
  request(command: Command, transfer: Transferable[] = [], timeoutMs = 120_000): Promise<SpeechResponse> {
    if (this.closed || this.signal?.aborted) return Promise.reject(abortError());
    if (this.pending.size >= 4) return Promise.reject(new Error("音频处理队列已满，请停止后改用 PTT 或文字。"));
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(new Error("本地语音处理超时，请使用 PTT 或文字。")), timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.worker.postMessage({ ...command, id }, transfer); } catch (error) {
        clearTimeout(timer); this.pending.delete(id); reject(error);
      }
    });
  }
  close(reason: Error = abortError()) {
    if (this.closed) return;
    this.closed = true;
    this.signal?.removeEventListener("abort", this.abort);
    this.worker.onmessage = null; this.worker.onerror = null; this.worker.onmessageerror = null;
    this.worker.terminate();
    this.pending.forEach(pending => { clearTimeout(pending.timer); pending.reject(reason); });
    this.pending.clear();
  }
}
