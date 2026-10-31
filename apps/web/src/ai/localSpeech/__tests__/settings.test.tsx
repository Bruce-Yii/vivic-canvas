// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalSpeechSettings } from "../../../control/LocalSpeechSettings";
import type { LocalSpeechModelManager } from "../modelManager";
import { getSpeechModel, MODEL_IDS } from "../models";
import type { ModelsSnapshot } from "../types";

const fakeManager = () => {
  const snapshot: ModelsSnapshot = { models: Object.fromEntries(MODEL_IDS.map(id => [id,
    { phase: "absent", loaded: 0, total: getSpeechModel(id).bytes, error: null },
  ])) as ModelsSnapshot["models"], busy: false };
  return { getSnapshot: () => snapshot, subscribe: () => () => {}, refresh: vi.fn(async () => {}),
    prepareDefaultModels: vi.fn(async (_options: { signal?: AbortSignal }) => {}),
    prepareModel: vi.fn(async () => {}), cancelDownload: vi.fn(), clearModelCache: vi.fn(async () => {}) };
};
afterEach(() => { document.body.innerHTML = ""; vi.unstubAllGlobals(); });
describe("local speech settings", () => {
  it("only inspects the cache on mount and downloads a model after an explicit click", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container), manager = fakeManager();
    await act(async () => root.render(<LocalSpeechSettings manager={manager as unknown as LocalSpeechModelManager} />));
    expect(manager.refresh).toHaveBeenCalledTimes(1); expect(manager.prepareDefaultModels).not.toHaveBeenCalled(); expect(manager.prepareModel).not.toHaveBeenCalled();
    expect(container.textContent).toContain("vivic"); expect(container.textContent).toContain("默认不监听");
    expect(container.textContent).toContain("169.23 MB"); expect(container.textContent).toContain("13.08 MB");
    await act(async () => (container.querySelector('[data-local-speech-model="asr-zh"] button') as HTMLButtonElement).click());
    expect(manager.prepareModel).toHaveBeenCalledWith("asr-zh");
    await act(async () => root.unmount());
    expect(manager.prepareDefaultModels).not.toHaveBeenCalled();
  });
  it("disables downloads for a read-only host and stops sessions before clearing", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container), manager = fakeManager(), before = vi.fn(async () => {});
    await act(async () => root.render(<LocalSpeechSettings disabled manager={manager as unknown as LocalSpeechModelManager} onBeforeClear={before} />));
    expect(Array.from(container.querySelectorAll("button")).every(button => button.disabled)).toBe(true);
    expect(manager.refresh).toHaveBeenCalledTimes(1); expect(manager.prepareDefaultModels).not.toHaveBeenCalled();
    await act(async () => root.render(<LocalSpeechSettings manager={manager as unknown as LocalSpeechModelManager} onBeforeClear={before} />));
    const clear = Array.from(container.querySelectorAll("button")).find(button => button.textContent?.includes("清理模型缓存"))!;
    await act(async () => clear.click());
    expect(before).toHaveBeenCalledTimes(1); expect(manager.clearModelCache).toHaveBeenCalledTimes(1);
    expect(before.mock.invocationCallOrder[0]).toBeLessThan(manager.clearModelCache.mock.invocationCallOrder[0]!);
    await act(async () => root.unmount());
  });
});
