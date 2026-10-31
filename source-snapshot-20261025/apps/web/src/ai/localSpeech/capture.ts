import type { CaptureMode } from "./types";

/** One bounded utterance. No microphone or clocks; driven by validated 16 kHz PCM. */
export class BoundedCapture {
  private readonly mode: CaptureMode;
  private readonly limit: number;
  private armed: boolean;
  private recording: boolean;
  private chunks: Float32Array[] = [];
  private count = 0;
  private done = false;
  private ring = new Float32Array(4800); // At most 300 ms before VAD onset.
  private ringPosition = 0;
  private ringLength = 0;
  constructor(mode: CaptureMode, maxSeconds: number) {
    if (!["ptt", "vad", "wake"].includes(mode) || !Number.isFinite(maxSeconds) || maxSeconds < 0.5 || maxSeconds > 60) {
      throw new Error("监听参数无效。");
    }
    this.mode = mode; this.limit = Math.floor(maxSeconds * 16000);
    this.armed = mode !== "wake"; this.recording = mode === "ptt";
  }
  wake() {
    if (this.done || this.armed) return false;
    this.armed = true; this.ringLength = 0; this.ringPosition = 0;
    return true;
  }
  get isArmed() { return this.armed; }
  get isRecording() { return this.recording; }
  get isDone() { return this.done; }
  private append(samples: Float32Array) {
    const count = Math.min(samples.length, this.limit - this.count);
    if (count > 0) { this.chunks.push(samples.slice(0, count)); this.count += count; }
  }
  accept(samples: Float32Array, speech = false, ended = false): Float32Array | null {
    if (this.done || !this.armed) return null;
    if (!this.recording) {
      for (const sample of samples) {
        this.ring[this.ringPosition] = sample;
        this.ringPosition = (this.ringPosition + 1) % this.ring.length;
        this.ringLength = Math.min(this.ringLength + 1, this.ring.length);
      }
      if (!speech && !ended) return null;
      this.recording = true;
      const history = new Float32Array(this.ringLength);
      for (let i = 0; i < history.length; i++) history[i] = this.ring[(this.ringPosition - this.ringLength + i + this.ring.length) % this.ring.length]!;
      this.append(history);
    } else this.append(samples);
    if ((ended && this.mode !== "ptt") || this.count >= this.limit) return this.finish();
    return null;
  }
  finish(): Float32Array {
    if (this.done || !this.recording || this.count === 0) throw new Error("没有检测到有效语音，请使用 PTT 或文字。");
    this.done = true;
    const samples = new Float32Array(this.count);
    let offset = 0;
    for (const chunk of this.chunks) { samples.set(chunk, offset); offset += chunk.length; }
    this.chunks = []; this.ring = new Float32Array(0);
    return samples;
  }
}
