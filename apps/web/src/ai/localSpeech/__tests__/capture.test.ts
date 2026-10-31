import { describe, expect, it } from "vitest";
import { BoundedCapture } from "../capture";
import { validatePcm } from "../models";

describe("bounded foreground utterances", () => {
  it("caps manual PTT exactly even when the final chunk overshoots", () => {
    const capture = new BoundedCapture("ptt", 0.5);
    expect(capture.accept(new Float32Array(7000).fill(0.1))).toBeNull();
    expect(capture.accept(new Float32Array(2000).fill(0.1))?.length).toBe(8000);
    expect(() => capture.finish()).toThrow();
  });
  it("does not accumulate ambient silence; keeps only 300ms before speech", () => {
    const capture = new BoundedCapture("vad", 60);
    for (let i = 0; i < 500; i++) expect(capture.accept(new Float32Array(512), false)).toBeNull();
    capture.accept(new Float32Array(512).fill(0.1), true);
    const result = capture.accept(new Float32Array(512).fill(0.2), false, true)!;
    expect(result.length).toBe(4800 + 512); expect(capture.isDone).toBe(true);
  });
  it("ignores pre-wake audio and emits only one command", () => {
    const capture = new BoundedCapture("wake", 10);
    capture.accept(new Float32Array(16000).fill(0.9), true, true);
    expect(() => capture.finish()).toThrow();
    expect(capture.wake()).toBe(true); expect(capture.wake()).toBe(false);
    capture.accept(new Float32Array(512).fill(0.2), true);
    const result = capture.accept(new Float32Array(512).fill(0.1), false, true)!;
    expect(result.length).toBe(1024); expect(Math.max(...result)).toBeLessThan(0.3);
    expect(capture.accept(new Float32Array(512), true)).toBeNull();
  });
  it("rejects non-16k, invalid samples and oversized queued blocks", () => {
    expect(() => validatePcm(new Float32Array([0]), 48000)).toThrow();
    expect(() => validatePcm(new Float32Array([NaN]), 16000)).toThrow();
    expect(() => validatePcm(new Float32Array([1.1]), 16000)).toThrow();
    expect(() => validatePcm(new Float32Array(16001), 16000, 16000)).toThrow();
    expect(() => new BoundedCapture("vad", Infinity)).toThrow();
  });
});
