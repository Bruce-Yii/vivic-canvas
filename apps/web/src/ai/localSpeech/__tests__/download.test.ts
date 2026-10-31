import { describe, expect, it } from "vitest";
import { downloadModel, readVerifiedModel } from "../download";
import type { CachedModel, ModelStorage } from "../storage";
import type { ModelId, ModelState, SpeechModel } from "../types";

class MemoryStorage implements ModelStorage {
  record?: CachedModel;
  lease = "";
  writes = 0;
  async get() { return this.record; }
  async begin() { return this.lease = crypto.randomUUID(); }
  async put(record: CachedModel, lease: string, signal?: AbortSignal) {
    if (signal?.aborted || this.lease !== lease) throw new DOMException("cancelled", "AbortError");
    this.writes++; this.record = record;
  }
  async delete(_id?: ModelId) { this.lease = crypto.randomUUID(); this.record = undefined; }
}
const bytes = new Uint8Array([1, 2, 3, 4]);
const model: SpeechModel = { id: "vad", kind: "vad", label: "test", license: "MIT", repository: "test", revision: "fixed",
  url: "https://example.invalid/model", bytes: 4, sha256: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a", licenseUrl: "https://example.invalid/LICENSE" };
const response = (data: Uint8Array) => new Response(data.slice().buffer);

describe("verified model downloads", () => {
  it("commits only exact-size, verified bytes and reports progress", async () => {
    const storage = new MemoryStorage(), progress: ModelState[] = [];
    await downloadModel(model, { storage, signal: new AbortController().signal, onProgress: value => progress.push(value), fetchImpl: async () => response(bytes) });
    expect(storage.writes).toBe(1); expect(progress.at(-1)?.phase).toBe("ready");
    expect(new Uint8Array(await readVerifiedModel(storage, model))).toEqual(bytes);
  });
  it.each([new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3, 5]), new Uint8Array([1, 2, 3, 4, 5])])("rejects truncated, corrupt or oversized bytes without a cache entry", async data => {
    const storage = new MemoryStorage();
    await expect(downloadModel(model, { storage, signal: new AbortController().signal, onProgress: () => {}, fetchImpl: async () => response(data) })).rejects.toThrow();
    expect(storage.writes).toBe(0);
  });
  it("cancels a stalled reader and does not publish ready", async () => {
    const storage = new MemoryStorage(), abort = new AbortController(), phases: string[] = [];
    const promise = downloadModel(model, { storage, signal: abort.signal, onProgress: state => phases.push(state.phase),
      fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(0, 2)); } })),
    });
    await new Promise(resolve => setTimeout(resolve, 10)); abort.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(storage.writes).toBe(0); expect(phases).not.toContain("ready");
  });
  it("cache clear during download invalidates the older write lease", async () => {
    const storage = new MemoryStorage();
    await expect(downloadModel(model, { storage, signal: new AbortController().signal, onProgress: () => {},
      fetchImpl: async () => { await storage.delete(); return response(bytes); },
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(storage.writes).toBe(0);
  });
  it("rehashes cached content and refuses corruption without silently downloading", async () => {
    const storage = new MemoryStorage();
    storage.record = { id: "vad", bytes: 4, sha256: model.sha256, blob: new Blob([new Uint8Array([9, 2, 3, 4])]) };
    await expect(readVerifiedModel(storage, model)).rejects.toThrow("SHA-256");
    let calls = 0;
    await expect(downloadModel(model, { storage, signal: new AbortController().signal, onProgress: () => {},
      fetchImpl: async () => { calls++; return response(bytes); },
    })).rejects.toThrow("SHA-256");
    expect(calls).toBe(0);
  });
});
