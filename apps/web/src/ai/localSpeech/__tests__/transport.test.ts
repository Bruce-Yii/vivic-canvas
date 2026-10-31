import { afterEach, describe, expect, it, vi } from "vitest";
import { SpeechWorkerClient } from "../workerClient";
import { LocalSpeechModelManager } from "../modelManager";

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  sent: { id: number; op: string; target?: number }[] = [];
  postMessage = (message: { id: number; op: string }) => { this.sent.push(message); };
  terminate = vi.fn();
  emit(data: object) { this.onmessage?.({ data } as MessageEvent); }
  asWorker() { return this as unknown as Worker; }
}
afterEach(() => vi.useRealTimers());
describe("worker ownership and cancellation", () => {
  it("aborts all pending inference and ignores late worker replies", async () => {
    const fake = new FakeWorker(), abort = new AbortController(), events = vi.fn();
    const worker = new SpeechWorkerClient({ workerFactory: () => fake.asWorker(), signal: abort.signal, onEvent: events });
    const promise = worker.request({ op: "finish" }); abort.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    fake.emit({ id: 1, type: "transcript", text: "late" });
    expect(events).not.toHaveBeenCalled(); expect(fake.terminate).toHaveBeenCalledTimes(1);
  });
  it("limits pending audio and kills a stalled WASM request", async () => {
    vi.useFakeTimers(); const fake = new FakeWorker();
    const worker = new SpeechWorkerClient({ workerFactory: () => fake.asWorker() });
    const pending = Array.from({ length: 4 }, () => worker.request({ op: "finish" }, [], 1000));
    const expectations = pending.map(promise => expect(promise).rejects.toThrow("超时"));
    await expect(worker.request({ op: "finish" })).rejects.toThrow("队列");
    await vi.advanceTimersByTimeAsync(1000); await Promise.all(expectations);
    expect(fake.terminate).toHaveBeenCalledTimes(1);
  });
  it("has no worker/network on construction and ignores progress after cancellation", async () => {
    const fake = new FakeWorker(), factory = vi.fn(() => fake.asWorker());
    const manager = new LocalSpeechModelManager(factory);
    expect(factory).not.toHaveBeenCalled(); expect(manager.getSnapshot().busy).toBe(false);
    const download = manager.prepareModel("vad"); manager.cancelDownload("vad");
    await expect(download).rejects.toMatchObject({ name: "AbortError" });
    fake.emit({ id: 1, type: "progress", state: { phase: "ready", loaded: 2313101, total: 2313101, error: null } });
    expect(manager.getSnapshot().models.vad.phase).toBe("absent"); manager.dispose();
  });
  it("does not let a stale cache inspection overwrite a newer verified download", async () => {
    const fake = new FakeWorker(), manager = new LocalSpeechModelManager(() => fake.asWorker());
    const inspection = manager.refresh();
    const download = manager.prepareModel("vad");
    fake.emit({ id: 2, type: "progress", state: { phase: "ready", loaded: 2313101, total: 2313101, error: null } });
    fake.emit({ id: 2, type: "done" }); await download;
    fake.emit({ id: 1, type: "done", cached: [] }); await inspection;
    expect(manager.getSnapshot().models.vad.phase).toBe("ready"); manager.dispose();
  });
});
