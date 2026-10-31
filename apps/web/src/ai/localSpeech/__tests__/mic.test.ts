// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { MicCapture } from "../micCapture";

const fixture = () => {
  const track = Object.assign(new EventTarget(), { stop: vi.fn() });
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  const port = { onmessage: null as ((event: MessageEvent) => void) | null, close: vi.fn() };
  const worklet = { port, connect: vi.fn(), disconnect: vi.fn() };
  const source = { connect: vi.fn(), disconnect: vi.fn() }, gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  const context = { sampleRate: 48000, state: "running", resume: vi.fn(async () => {}), close: vi.fn(async () => {}), destination: {},
    audioWorklet: { addModule: vi.fn(async () => {}) }, createMediaStreamSource: () => source, createGain: () => gain };
  const getUserMedia = vi.fn(async () => stream), createContext = vi.fn(() => context as unknown as AudioContext);
  const createWorklet = vi.fn(() => worklet as unknown as AudioWorkletNode);
  return { track, stream, port, context, getUserMedia, createContext, createWorklet, gain };
};
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("owned AudioWorklet capture (no hardware)", () => {
  it("never opens on construction and resumes before awaiting model readiness", async () => {
    vi.stubGlobal("isSecureContext", true); const f = fixture(), capture = new MicCapture(f);
    expect(f.getUserMedia).not.toHaveBeenCalled();
    let ready!: () => void; const pending = new Promise<void>(resolve => { ready = resolve; });
    const pcm = vi.fn(), errors = vi.fn();
    const start = capture.start({ ready: pending, onPcm: pcm, onError: errors });
    expect(f.context.resume).toHaveBeenCalledTimes(1);
    await Promise.resolve(); expect(f.getUserMedia).not.toHaveBeenCalled();
    ready(); await start;
    expect(f.context.audioWorklet.addModule).toHaveBeenCalledWith("/audio-capture-worklet.js"); expect(f.gain.gain.value).toBe(0);
    f.port.onmessage?.({ data: new Float32Array(2048).fill(0.1) } as MessageEvent);
    await vi.waitFor(() => expect(pcm).toHaveBeenCalledTimes(1));
    expect(pcm.mock.calls[0]![1]).toBe(16000); expect(pcm.mock.calls[0]![0].length).toBeLessThan(700);
    capture.dispose(); expect(f.track.stop).toHaveBeenCalledTimes(1); expect(f.port.close).toHaveBeenCalledTimes(1);
  });
  it("cancels an unanswered permission request and stops a late stream", async () => {
    vi.stubGlobal("isSecureContext", true); const f = fixture();
    let resolve!: (stream: MediaStream) => void;
    const getUserMedia = vi.fn(() => new Promise<MediaStream>(r => { resolve = r; }));
    const capture = new MicCapture({ ...f, getUserMedia });
    const start = capture.start({ onPcm: vi.fn(), onError: vi.fn() });
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    capture.stop(); await expect(start).rejects.toMatchObject({ name: "AbortError" });
    resolve(f.stream); await Promise.resolve(); await Promise.resolve();
    expect(f.track.stop).toHaveBeenCalledTimes(1); expect(f.createWorklet).not.toHaveBeenCalled();
  });
  it("stops on foreground loss and discards queued late packets", async () => {
    vi.stubGlobal("isSecureContext", true); const f = fixture(), pcm = vi.fn(), capture = new MicCapture(f);
    await capture.start({ onPcm: pcm, onError: vi.fn() }); const late = f.port.onmessage!;
    window.dispatchEvent(new Event("blur")); late({ data: new Float32Array(2048).fill(0.1) } as MessageEvent);
    await Promise.resolve(); expect(pcm).not.toHaveBeenCalled(); expect(f.track.stop).toHaveBeenCalledTimes(1);
    capture.dispose();
  });
  it("fails closed when the PCM consumer cannot keep up", async () => {
    vi.stubGlobal("isSecureContext", true); const f = fixture(), errors = vi.fn(), capture = new MicCapture(f);
    await capture.start({ onPcm: () => new Promise<void>(() => {}), onError: errors });
    const deliver = f.port.onmessage!;
    for (let i = 0; i < 20; i++) deliver({ data: new Float32Array(2048).fill(0.1) } as MessageEvent);
    expect(errors).toHaveBeenCalledTimes(1); expect(f.track.stop).toHaveBeenCalledTimes(1); capture.dispose();
  });
});
