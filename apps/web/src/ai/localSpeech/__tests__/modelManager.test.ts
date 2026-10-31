import { describe, expect, it, vi } from "vitest";
import { LocalSpeechModelManager } from "../modelManager";
import { getSpeechModel } from "../models";
import type { ModelRequest, ModelResponse } from "../protocol";
import type { ModelId } from "../types";

// Model-worker messages only: no network, model weights, or audio capture.
const fixture = (cached: ModelId[] = []) => {
  const messages: ModelRequest[] = [];
  const hold = new Set<string>(), fail = new Set<ModelId>();
  const cache = new Set(cached);
  const worker = {
    onmessage: null as ((event: MessageEvent<ModelResponse>) => void) | null,
    onerror: null, onmessageerror: null, terminate: vi.fn(),
    postMessage(message: ModelRequest) {
      messages.push(message);
      if (!hold.has(message.op)) queueMicrotask(() => finish(message));
    },
  };
  const reply = (data: ModelResponse) => worker.onmessage?.({ data } as MessageEvent<ModelResponse>);
  const finish = (message: ModelRequest) => {
    if (message.op === "cancel") return;
    if (message.op === "inspect") { reply({ id: message.id, type: "done", cached: [...cache] }); return; }
    if (message.op === "prepare") {
      if (fail.has(message.modelId)) { reply({ id: message.id, type: "error", message: "TEST download unavailable", aborted: false }); return; }
      cache.add(message.modelId);
      const bytes = getSpeechModel(message.modelId).bytes;
      reply({ id: message.id, type: "progress", state: { phase: "ready", loaded: bytes, total: bytes, error: null } });
    } else if (message.modelId) cache.delete(message.modelId);
    else cache.clear();
    reply({ id: message.id, type: "done" });
  };
  const manager = new LocalSpeechModelManager(() => worker as unknown as Worker);
  const downloads = () => messages.filter(message => message.op === "prepare").map(message => message.modelId);
  return { manager, messages, hold, fail, finish, downloads };
};

describe("automatic local speech model preparation", () => {
  it("downloads missing models sequentially, reuses cache, and avoids repeated attempts", async () => {
    const { manager, downloads } = fixture(["asr-zh"]);
    try {
      await Promise.all([manager.prepareDefaultModels(), manager.prepareDefaultModels()]);
      expect(downloads()).toEqual(["kws-zh-en", "vad"]);
      expect(manager.getSnapshot().models["asr-zh"].phase).toBe("cached");
      expect(manager.getSnapshot().models.vad.phase).toBe("ready");
      await manager.prepareDefaultModels();
      expect(downloads()).toEqual(["kws-zh-en", "vad"]);
    } finally { manager.dispose(); }
  });

  it("keeps other models usable after a failure and leaves failed models for explicit retry", async () => {
    const { manager, fail, downloads } = fixture(); fail.add("asr-zh");
    try {
      await manager.prepareDefaultModels();
      expect(downloads()).toEqual(["asr-zh", "kws-zh-en", "vad"]);
      expect(manager.getSnapshot().models["asr-zh"]).toMatchObject({ phase: "error", error: "TEST download unavailable" });
      expect(manager.getSnapshot().models.vad.phase).toBe("ready");
      fail.clear(); await manager.prepareModel("asr-zh");
      expect(manager.getSnapshot().models["asr-zh"].phase).toBe("ready");
    } finally { manager.dispose(); }
  });

  it("stops downloads when the owner leaves and resumes missing models on return", async () => {
    const { manager, hold, downloads } = fixture(); hold.add("prepare");
    const controller = new AbortController();
    try {
      const preparation = manager.prepareDefaultModels({ signal: controller.signal });
      const rejected = expect(preparation).rejects.toMatchObject({ name: "AbortError" });
      await vi.waitFor(() => expect(downloads()).toEqual(["asr-zh"]));
      controller.abort(); await rejected;
      expect(downloads()).toEqual(["asr-zh"]);
      expect(manager.getSnapshot().busy).toBe(false);
      hold.clear(); await manager.prepareDefaultModels();
      expect(downloads()).toEqual(["asr-zh", "asr-zh", "kws-zh-en", "vad"]);
    } finally { manager.dispose(); }
  });

  it("does not repopulate explicitly cleared caches after a late initial inspection", async () => {
    const { manager, hold, messages, finish, downloads } = fixture(); hold.add("inspect");
    try {
      const preparation = manager.prepareDefaultModels();
      const rejected = expect(preparation).rejects.toMatchObject({ name: "AbortError" });
      await manager.clearModelCache();
      finish(messages.find(message => message.op === "inspect")!); await rejected;
      hold.clear(); await manager.prepareDefaultModels();
      expect(downloads()).toEqual([]);
      expect(manager.getSnapshot().models.vad.phase).toBe("absent");
    } finally { manager.dispose(); }
  });
});
