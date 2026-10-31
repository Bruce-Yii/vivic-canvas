import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalSpeechSession, transcribeLocalPcm } from "../session";
import type { LocalSpeechEvent } from "../types";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  transcribeId = 0;
  constructor() { FakeWorker.instances.push(this); }
  postMessage(message: { op: string; id: number }) {
    if (message.op === "listen" || message.op === "pcm") queueMicrotask(() => this.emit({ id: message.id, type: "ack" }));
    if (message.op === "finish") queueMicrotask(() => this.emit({ id: message.id, type: "segment", samples: new Float32Array(8000).fill(0.1) }));
    if (message.op === "transcribe") this.transcribeId = message.id;
  }
  emit(data: object) { this.onmessage?.({ data } as MessageEvent); }
}
const setup = () => { FakeWorker.instances = []; vi.stubGlobal("Worker", FakeWorker); };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("session generations and cancellation", () => {
  it("rejects invalid PCM before creating a worker and never downloads implicitly", async () => {
    setup(); await expect(transcribeLocalPcm(new Float32Array(2), { sampleRate: 48000 })).rejects.toThrow("16kHz");
    expect(FakeWorker.instances).toHaveLength(0);
  });
  it("terminates capture before ASR and discards an old result after stop", async () => {
    setup(); const events: LocalSpeechEvent[] = [];
    const session = createLocalSpeechSession({ mode: "ptt", recognition: "local", onEvent: event => events.push(event) });
    await session.start();
    const finishing = session.finish();
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(2));
    const capture = FakeWorker.instances[0]!, inference = FakeWorker.instances[1]!;
    expect(capture.terminate).toHaveBeenCalledTimes(1);
    const late = inference.onmessage!;
    session.stop();
    late({ data: { id: inference.transcribeId, type: "transcript", text: "stale command" } } as MessageEvent);
    await finishing;
    expect(events.filter(event => event.type === "transcript")).toHaveLength(0);
    expect(inference.terminate).toHaveBeenCalledTimes(1); session.dispose();
  });
  it("emits a bounded cloud segment with an abort signal without calling a network service", async () => {
    setup(); const events: LocalSpeechEvent[] = [];
    const session = createLocalSpeechSession({ mode: "ptt", recognition: "segment", onEvent: event => events.push(event) });
    await session.start(); await session.acceptPcm(new Float32Array(512).fill(0.2)); await session.finish();
    const segment = events.find(event => event.type === "segment");
    expect(segment?.type).toBe("segment");
    if (segment?.type !== "segment") throw new Error("no segment");
    expect(segment.wav.type).toBe("audio/wav"); expect(segment.signal.aborted).toBe(false);
    session.stop(); expect(segment.signal.aborted).toBe(true);
    expect(FakeWorker.instances).toHaveLength(1); session.dispose();
  });
  it("bounds total wall time and reports fallback rather than waiting forever", async () => {
    setup(); vi.useFakeTimers(); const events: LocalSpeechEvent[] = [];
    const session = createLocalSpeechSession({ mode: "vad", recognition: "segment", maxListenSeconds: 1, onEvent: event => events.push(event) });
    await session.start(); await vi.advanceTimersByTimeAsync(1000);
    expect(events.some(event => event.type === "fallback")).toBe(true);
    expect(FakeWorker.instances[0]!.terminate).toHaveBeenCalledTimes(1); session.dispose();
  });
  it("reports an idle Worker failure and terminates it", async () => {
    setup(); const events: LocalSpeechEvent[] = [];
    const session = createLocalSpeechSession({ mode: "vad", recognition: "segment", onEvent: event => events.push(event) });
    await session.start(); FakeWorker.instances[0]!.onerror?.();
    expect(events.filter(event => event.type === "fallback")).toHaveLength(1); session.dispose();
  });
});
