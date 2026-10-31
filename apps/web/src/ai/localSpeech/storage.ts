import { MODEL_IDS, abortError, checkAbort } from "./models";
import type { ModelId, SpeechModel } from "./types";

export interface CachedModel { id: ModelId; sha256: string; bytes: number; blob: Blob }
export interface ModelStorage {
  get(id: ModelId): Promise<CachedModel | undefined>;
  begin(id: ModelId): Promise<string>;
  put(record: CachedModel, lease: string, signal?: AbortSignal): Promise<void>;
  delete(id?: ModelId): Promise<void>;
}
const DB_NAME = "vivic-local-speech-v1";
const request = <T>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error ?? new Error("模型缓存操作失败。"));
});

/** Leases prevent a cancelled/older download from repopulating a cleared cache, across tabs. */
export class IndexedDbModelStorage implements ModelStorage {
  private async transact<T>(mode: IDBTransactionMode, action: (tx: IDBTransaction) => Promise<T>, signal?: AbortSignal): Promise<T> {
    checkAbort(signal);
    if (typeof indexedDB === "undefined") throw new Error("此浏览器不支持模型缓存，请使用 PTT 或文字。");
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore("models", { keyPath: "id" });
      open.result.createObjectStore("leases");
    };
    const db = await request(open);
    try {
      checkAbort(signal);
      const tx = db.transaction(["models", "leases"], mode);
      const cancel = () => { try { tx.abort(); } catch { /* Already committed. */ } };
      const done = new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(signal?.aborted ? abortError() : tx.error ?? new Error("模型缓存事务取消。"));
        tx.onerror = () => { /* onabort owns the error. */ };
      });
      // Observe failures immediately, including when action is still awaiting an IDB request.
      void done.catch(() => {});
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        checkAbort(signal);
        const value = await action(tx);
        await done;
        checkAbort(signal);
        return value;
      } catch (error) {
        cancel();
        await done.catch(() => {});
        throw error;
      } finally { signal?.removeEventListener("abort", cancel); }
    } finally { db.close(); }
  }
  async get(id: ModelId): Promise<CachedModel | undefined> {
    const record = await this.transact("readonly", tx => request(tx.objectStore("models").get(id))) as
      (Omit<CachedModel, "blob"> & { blob?: Blob; buffer?: ArrayBuffer; contentType?: string }) | undefined;
    if (!record) return undefined;
    if (record.blob instanceof Blob) return { id: record.id, sha256: record.sha256, bytes: record.bytes, blob: record.blob };
    if (record.buffer instanceof ArrayBuffer) return { id: record.id, sha256: record.sha256, bytes: record.bytes,
      blob: new Blob([record.buffer], { type: record.contentType ?? "application/octet-stream" }) };
    return undefined;
  }
  begin(id: ModelId) {
    const lease = crypto.randomUUID();
    return this.transact("readwrite", async tx => {
      await request(tx.objectStore("leases").put(lease, id));
      return lease;
    });
  }
  async put(record: CachedModel, lease: string, signal?: AbortSignal) {
    const write = (value: object) => this.transact("readwrite", async tx => {
      const current = await request(tx.objectStore("leases").get(record.id));
      checkAbort(signal);
      if (current !== lease) throw abortError();
      await request(tx.objectStore("models").put(value));
    }, signal);
    try { await write(record); }
    catch (error) {
      // WebKit can reject IDB's Blob backing-file preparation. Retry once with
      // bytes, outside the failed transaction; the new transaction rechecks the
      // lease so cancellation/reset can never resurrect an old download.
      if (!(error instanceof DOMException) || !["UnknownError", "DataCloneError"].includes(error.name)) throw error;
      checkAbort(signal);
      const buffer = await record.blob.arrayBuffer();
      checkAbort(signal);
      await write({ id: record.id, sha256: record.sha256, bytes: record.bytes, buffer, contentType: record.blob.type });
    }
  }
  delete(id?: ModelId) {
    return this.transact("readwrite", async tx => {
      if (!id) {
        await request(tx.objectStore("models").clear());
        await request(tx.objectStore("leases").clear());
      }
      const requests = (id ? [id] : MODEL_IDS).flatMap(key => [
        request(tx.objectStore("leases").put(crypto.randomUUID(), key)),
        request(tx.objectStore("models").delete(key)),
      ]);
      await Promise.all(requests);
    });
  }
}
export const matchesModel = (record: CachedModel | undefined, model: SpeechModel): record is CachedModel =>
  Boolean(record && record.sha256 === model.sha256 && record.bytes === model.bytes && record.blob.size === model.bytes);
