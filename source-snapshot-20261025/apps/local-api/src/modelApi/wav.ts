import { ModelApiError } from "./errors.js";

export interface WavInfo { durationSeconds: number; nonSilent: boolean }
const invalid = () => new ModelApiError("invalid-response");

/** Validates complete RIFF/WAVE PCM or IEEE-float data; does not decode or synthesize speech. */
export function inspectWav(bytes: Uint8Array): WavInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE" || view.getUint32(4, true) + 8 !== bytes.length) throw invalid();
  let format: { kind: number; channels: number; rate: number; byteRate: number; align: number; bits: number } | undefined;
  let data: Uint8Array | undefined;
  let offset = 12;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw invalid();
    const length = view.getUint32(offset + 4, true);
    const end = offset + 8 + length;
    if (end > bytes.length || end + (length % 2) > bytes.length) throw invalid();
    if (tag(offset) === "fmt ") {
      if (format || length < 16) throw invalid();
      format = { kind: view.getUint16(offset + 8, true), channels: view.getUint16(offset + 10, true),
        rate: view.getUint32(offset + 12, true), byteRate: view.getUint32(offset + 16, true),
        align: view.getUint16(offset + 20, true), bits: view.getUint16(offset + 22, true) };
    } else if (tag(offset) === "data") {
      if (data || !length) throw invalid();
      data = bytes.subarray(offset + 8, end);
    }
    offset = end + (length % 2);
  }
  if (!format || !data || ![1, 3].includes(format.kind) || format.channels < 1 || format.channels > 8
    || format.rate < 8_000 || format.rate > 192_000 || ![8, 16, 24, 32, 64].includes(format.bits)
    || (format.kind === 1 && format.bits === 64) || (format.kind === 3 && ![32, 64].includes(format.bits))
    || format.align !== format.channels * format.bits / 8 || format.byteRate !== format.rate * format.align
    || data.length % format.align !== 0) throw invalid();
  let nonSilent = false;
  if (format.kind === 1) {
    const silence = format.bits === 8 ? 128 : 0;
    nonSilent = data.some(byte => byte !== silence);
  } else {
    const samples = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let index = 0; index < data.length; index += format.bits / 8) {
      const value = format.bits === 32 ? samples.getFloat32(index, true) : samples.getFloat64(index, true);
      if (!Number.isFinite(value)) throw invalid();
      if (Math.abs(value) > 0.00001) nonSilent = true;
    }
  }
  return { durationSeconds: data.length / format.byteRate, nonSilent };
}
