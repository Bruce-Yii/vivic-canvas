import { describe, expect, it } from "vitest";
import { encodeVoiceWav } from "../pcm";

describe("browser microphone WAV encoding", () => {
  it("writes a canonical mono PCM16 16kHz WAV, independent of device sample rate", async () => {
    const blob = encodeVoiceWav([new Float32Array(24000).fill(0.5)], 48000);
    const buffer = await blob.arrayBuffer(), view = new DataView(buffer);
    expect(new TextDecoder().decode(buffer.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(buffer.slice(8, 12))).toBe("WAVE");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(16000);
    expect(buffer.byteLength).toBe(16044);
    expect(view.getInt16(44, true)).toBe(16384);
    expect(blob.type).toBe("audio/wav");
  });
  it("joins packets without losing their tail and bounds out-of-range samples", async () => {
    const a = new Float32Array(2000).fill(2), b = new Float32Array(2000).fill(-2);
    const view = new DataView(await encodeVoiceWav([a, b], 16000).arrayBuffer());
    expect(view.byteLength).toBe(8044);
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(44 + 4000, true)).toBe(-32768);
    expect(view.getInt16(view.byteLength - 2, true)).toBe(-32768);
  });
  it("rejects silence, empty input and overlong capture before upload", () => {
    expect(() => encodeVoiceWav([], 16000)).toThrow("录音时长");
    expect(() => encodeVoiceWav([new Float32Array(4000)], 16000)).toThrow("没有录到声音");
    expect(() => encodeVoiceWav([new Float32Array(16000 * 61).fill(0.1)], 16000)).toThrow("录音时长");
    expect(() => encodeVoiceWav([new Float32Array(4000).fill(0.1)], NaN)).toThrow("录音时长");
  });
});
