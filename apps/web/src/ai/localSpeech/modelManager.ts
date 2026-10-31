import { abortError, checkAbort, getSpeechModel, MODEL_IDS } from "./models";
import type { ModelRequest, ModelResponse } from "./protocol";
import type { ModelId, ModelsSnapshot, ModelState } from "./types";

interface Pending {
  resolve: (value: ModelResponse & { type: "done" }) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
  progress?: (state: ModelState) => void;
}
export class LocalSpeechModelManager {
  private worker: Worker | null = null;
  private serial = 0;
  private pending = new Map<number, Pending>();
  private jobs = new Map<ModelId, AbortController>();
  private clearing = new Set<ModelId>();
  private listeners = new Set<() => void>();
  private disposed = false;
  private defaultPreparation: AbortController | null = null;
  private defaultAttempts = new Set<ModelId>();
  private defaultDownloadsPaused = false;
  private versions: Record<ModelId, number> = { "asr-zh": 0, "kws-zh-en": 0, vad: 0 };
  private snapshot: ModelsSnapshot = { models: Object.fromEntries(MODEL_IDS.map(id => [id,
    { phase: "absent", loaded: 0, total: getSpeechModel(id).bytes, error: null },
  ])) as ModelsSnapshot["models"], busy: false };
  private readonly workerFactory: () => Worker;
  constructor(workerFactory = () => new Worker(new URL("./model.worker.ts", import.meta.url), { type: "module" })) { this.workerFactory = workerFactory; }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(id?: ModelId, state?: ModelState) {
    if (id && state) this.versions[id]++;
    this.snapshot = { models: id && state ? { ...this.snapshot.models, [id]: state } : this.snapshot.models,
      busy: this.jobs.size > 0 || this.clearing.size > 0 };
    this.listeners.forEach(listener => listener());
  }
  private getWorker() {
    if (this.disposed) throw new Error("模型管理器已释放。");
    if (!this.worker) {
      this.worker = this.workerFactory();
      this.worker.onmessage = (event: MessageEvent<ModelResponse>) => {
        const message = event.data;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        if (message.type === "progress") { pending.progress?.(message.state); return; }
        this.pending.delete(message.id); pending.cleanup();
        if (message.type === "error") pending.reject(message.aborted ? abortError() : new Error(message.message));
        else pending.resolve(message);
      };
      const fail = () => {
        this.worker?.terminate(); this.worker = null;
        for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(new Error("模型 Worker 已停止，请使用 PTT 或文字后重试。")); }
        this.pending.clear();
      };
      this.worker.onerror = fail;
      this.worker.onmessageerror = fail;
    }
    return this.worker;
  }
  private request(message: Omit<ModelRequest, "id">, signal?: AbortSignal, progress?: Pending["progress"]): Promise<ModelResponse & { type: "done" }> {
    checkAbort(signal);
    const worker = this.getWorker();
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const cancel = () => {
        if (!this.pending.delete(id)) return;
        cleanup();
        worker.postMessage({ id: ++this.serial, op: "cancel", target: id } satisfies ModelRequest);
        reject(abortError());
      };
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        cleanup(); worker.postMessage({ id: ++this.serial, op: "cancel", target: id } satisfies ModelRequest);
        reject(new Error("模型操作超时，请检查网络后重试。"));
      }, 10 * 60_000);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); };
      this.pending.set(id, { resolve, reject, cleanup, progress });
      signal?.addEventListener("abort", cancel, { once: true });
      try { worker.postMessage({ ...message, id }); } catch (error) { this.pending.delete(id); cleanup(); reject(error); }
    });
  }
  refresh = async () => {
    const versions = { ...this.versions };
    const result = await this.request({ op: "inspect" });
    for (const id of MODEL_IDS) {
      if (this.jobs.has(id) || this.clearing.has(id) || this.versions[id] !== versions[id]) continue;
      const cached = result.cached?.includes(id) ?? false;
      this.publish(id, { phase: cached ? "cached" : "absent", loaded: cached ? getSpeechModel(id).bytes : 0,
        total: getSpeechModel(id).bytes, error: null });
    }
  };
  /** Prepare missing models once per page session, without starting audio capture. */
  prepareDefaultModels = async (options: { signal?: AbortSignal } = {}) => {
    checkAbort(options.signal);
    if (this.defaultPreparation && !this.defaultPreparation.signal.aborted) return;
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    this.defaultPreparation = controller;
    try {
      await this.refresh();
      checkAbort(controller.signal);
      if (this.defaultDownloadsPaused) return;
      for (const id of MODEL_IDS) {
        checkAbort(controller.signal);
        const state = this.snapshot.models[id];
        if (this.defaultAttempts.has(id) || ["cached", "ready", "downloading", "verifying"].includes(state.phase)) continue;
        this.defaultAttempts.add(id);
        try { await this.prepareModel(id, { signal: controller.signal }); }
        catch (error) {
          if (options.signal?.aborted && !this.defaultDownloadsPaused) this.defaultAttempts.delete(id);
          if (controller.signal.aborted || error instanceof DOMException && error.name === "AbortError") throw error;
          // Each failed model already exposes its error and an explicit retry button.
        }
      }
    } finally {
      options.signal?.removeEventListener("abort", abort);
      if (this.defaultPreparation === controller) this.defaultPreparation = null;
    }
  };
  prepareModel = async (id: ModelId, options: { signal?: AbortSignal } = {}) => {
    const model = getSpeechModel(id);
    checkAbort(options.signal);
    if (this.clearing.has(id)) throw new Error("正在清理模型缓存，请稍后重试。");
    if (this.jobs.has(id)) throw new Error("此模型正在下载。");
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    this.jobs.set(id, controller);
    this.publish(id, { phase: "downloading", loaded: 0, total: model.bytes, error: null });
    try {
      await this.request({ op: "prepare", modelId: id } as Omit<ModelRequest, "id">, controller.signal, state => {
        if (this.jobs.get(id) === controller && !controller.signal.aborted) this.publish(id, state);
      });
    } catch (error) {
      if (this.jobs.get(id) === controller) this.publish(id, { phase: controller.signal.aborted ? "absent" : "error", loaded: 0,
        total: model.bytes, error: controller.signal.aborted ? null : error instanceof Error ? error.message : "模型下载失败。" });
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", abort);
      if (this.jobs.get(id) === controller) this.jobs.delete(id);
      this.publish();
    }
  };
  cancelDownload = (id: ModelId) => { this.jobs.get(id)?.abort(); };
  clearModelCache = async (id?: ModelId) => {
    const ids = id ? [getSpeechModel(id).id] : MODEL_IDS;
    if (ids.some(key => this.clearing.has(key))) throw new Error("正在清理模型缓存。");
    this.defaultDownloadsPaused = true;
    this.defaultPreparation?.abort();
    ids.forEach(key => this.defaultAttempts.add(key));
    ids.forEach(key => { this.clearing.add(key); this.cancelDownload(key); });
    this.publish();
    try {
      await this.request({ op: "clear", ...(id ? { modelId: id } : {}) } as Omit<ModelRequest, "id">);
      ids.forEach(key => this.publish(key, { phase: "absent", loaded: 0, total: getSpeechModel(key).bytes, error: null }));
    } finally { ids.forEach(key => this.clearing.delete(key)); this.publish(); }
  };
  dispose = () => {
    if (this.disposed) return;
    this.disposed = true;
    this.defaultPreparation?.abort();
    this.jobs.forEach(controller => controller.abort()); this.jobs.clear();
    this.worker?.terminate(); this.worker = null;
    this.pending.forEach(pending => { pending.cleanup(); pending.reject(abortError()); }); this.pending.clear();
    this.publish(); this.listeners.clear();
  };
}
/** No worker, network, or storage access until an explicit method is called. */
export const localSpeechModels = new LocalSpeechModelManager();
