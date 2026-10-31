import { abortError, checkAbort } from "./models";
import { matchesModel } from "./storage";
import type { ModelStorage } from "./storage";
import type { ModelState, SpeechModel } from "./types";

export async function verifyModelBytes(bytes: ArrayBuffer, model: SpeechModel, signal?: AbortSignal): Promise<void> {
  checkAbort(signal);
  if (bytes.byteLength !== model.bytes) throw new Error("模型大小不匹配，未加载。请清理缓存后重试。");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  checkAbort(signal);
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  if (hex !== model.sha256) throw new Error("模型 SHA-256 校验失败，未加载。请重试下载。");
}

/** Rehash cached bytes before every WASM load, not just at download time. */
export async function readVerifiedModel(storage: ModelStorage, model: SpeechModel, signal?: AbortSignal): Promise<ArrayBuffer> {
  checkAbort(signal);
  const cached = await storage.get(model.id);
  checkAbort(signal);
  if (!matchesModel(cached, model)) throw new Error(`请先下载${model.label}，仍可使用 PTT 或文字。`);
  const bytes = await cached.blob.arrayBuffer();
  await verifyModelBytes(bytes, model, signal);
  return bytes;
}

export async function downloadModel(model: SpeechModel, options: {
  storage: ModelStorage;
  signal: AbortSignal;
  onProgress: (state: ModelState) => void;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const { storage, signal, onProgress, fetchImpl = fetch } = options;
  const progress = (phase: ModelState["phase"], loaded: number) => {
    checkAbort(signal);
    onProgress({ phase, loaded, total: model.bytes, error: null });
  };
  checkAbort(signal);
  const cached = await storage.get(model.id);
  checkAbort(signal);
  if (matchesModel(cached, model)) {
    progress("verifying", model.bytes);
    await verifyModelBytes(await cached.blob.arrayBuffer(), model, signal);
    progress("ready", model.bytes);
    return;
  }
  const lease = await storage.begin(model.id);
  checkAbort(signal);
  progress("downloading", 0);
  // The fixed manifest is the only URL source; no cookies/credentials go to the model host.
  const response = await fetchImpl(model.url, { signal, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" });
  checkAbort(signal);
  if (!response.ok || !response.body) { void response.body?.cancel(); throw new Error("模型下载失败，请检查网络后重试。"); }
  const reader = response.body.getReader();
  const bytes = new Uint8Array(model.bytes);
  let loaded = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      checkAbort(signal);
      const { value, done } = await reader.read();
      checkAbort(signal);
      if (done) break;
      if (loaded + value.byteLength > model.bytes) throw new Error("模型响应超过固定大小，下载已停止。");
      bytes.set(value, loaded);
      loaded += value.byteLength;
      progress("downloading", loaded);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  progress("verifying", loaded);
  await verifyModelBytes(bytes.buffer, model, signal);
  checkAbort(signal);
  try {
    await storage.put({ id: model.id, sha256: model.sha256, bytes: loaded, blob: new Blob([bytes]) }, lease, signal);
  } catch (error) {
    if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) throw abortError();
    throw new Error("模型无法写入浏览器缓存，请检查存储空间或清理缓存。");
  }
  progress("ready", loaded);
}
