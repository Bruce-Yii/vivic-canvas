import { describe, expect, it } from "vitest";
import { StreamingPcmResampler } from "../resample";

const join = (parts: Float32Array[]) => {
  const output = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0; for (const part of parts) { output.set(part, offset); offset += part.length; } return output;
};
const tone = (rate: number, frequency: number, seconds = 1) => Float32Array.from({ length: rate * seconds }, (_, i) => 0.5 * Math.sin(2 * Math.PI * frequency * i / rate));
describe("continuous PCM resampling", () => {
  it.each([8000, 16000, 44100, 48000, 96000, 192000])("preserves one-second duration at %i Hz independent of packet boundaries", rate => {
    const input = tone(rate, 1000), whole = new StreamingPcmResampler(rate), streamed = new StreamingPcmResampler(rate);
    const expected = join([whole.push(input), whole.flush()]), parts: Float32Array[] = [];
    for (let offset = 0; offset < input.length; offset += 1999) parts.push(streamed.push(input.subarray(offset, offset + 1999)));
    parts.push(streamed.flush()); const actual = join(parts);
    expect(actual.length).toBe(16000); expect(actual).toEqual(expected);
    const middle = actual.subarray(128, -128), rms = Math.sqrt(middle.reduce((sum, value) => sum + value * value, 0) / middle.length);
    expect(rms).toBeGreaterThan(0.34); expect(rms).toBeLessThan(0.37);
  });
  it("low-pass filters above-Nyquist audio rather than aliasing it into speech", () => {
    const resampler = new StreamingPcmResampler(48000);
    const output = join([resampler.push(tone(48000, 12000)), resampler.flush()]).subarray(128, -128);
    const rms = Math.sqrt(output.reduce((sum, value) => sum + value * value, 0) / output.length);
    expect(rms).toBeLessThan(0.005);
  });
  it("has no cumulative rate drift across 3 seconds of irregular chunks", () => {
    const resampler = new StreamingPcmResampler(44100), input = tone(44100, 700, 3), output: Float32Array[] = [];
    for (let offset = 0; offset < input.length; offset += 2048) output.push(resampler.push(input.subarray(offset, offset + 2048)));
    output.push(resampler.flush()); expect(join(output).length).toBe(48000);
    expect(() => resampler.push(new Float32Array(1))).toThrow();
  });
});
