import { HostedApiError } from "./client";

const limits = { segments: 32, segmentBytes: 12_000_000, totalBytes: 64_000_000 } as const;
const invalidAudio = () => new HostedApiError(400, "invalid-audio", "试听数据未通过 WAV 格式或大小校验，请重新生成。");
/** Matches the service's bounded WAV response; never creates data: URLs. */
export function decodeSpeechSegments(raw: unknown): Blob[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > limits.segments) throw invalidAudio();
  let total = 0;
  return raw.map(segment => {
    if (!segment || typeof segment !== "object" || segment.mime !== "audio/wav" || typeof segment.audio !== "string") throw invalidAudio();
    const encoded = segment.audio;
    if (!encoded.length || encoded.length % 4 || encoded.length > Math.ceil(limits.segmentBytes / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw invalidAudio();
    const size = encoded.length / 4 * 3 - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
    total += size;
    if (size < 44 || size > limits.segmentBytes || total > limits.totalBytes) throw invalidAudio();
    let binary: string; try { binary = atob(encoded); } catch { throw invalidAudio(); }
    if (binary.length !== size) throw invalidAudio();
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    if (!validWav(bytes)) throw invalidAudio();
    return new Blob([bytes], { type: "audio/wav" });
  });
}
export function createSpeechUrls(raw: unknown): string[] {
  const blobs = decodeSpeechSegments(raw), urls: string[] = [];
  try { for (const blob of blobs) urls.push(URL.createObjectURL(blob)); return urls; }
  catch (error) { revokeSpeechUrls(urls); throw error; }
}
export function revokeSpeechUrls(urls: readonly string[]) { urls.forEach(url => URL.revokeObjectURL(url)); }
function validWav(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE" || view.getUint32(4, true) + 8 !== bytes.byteLength) return false;
  let offset = 12, align = 0, dataBytes = 0, foundFormat = false;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) return false;
    const length = view.getUint32(offset + 4, true), end = offset + 8 + length;
    if (end + length % 2 > bytes.byteLength) return false;
    if (tag(offset) === "fmt ") {
      if (foundFormat || length < 16) return false; foundFormat = true;
      const kind = view.getUint16(offset + 8, true), channels = view.getUint16(offset + 10, true), rate = view.getUint32(offset + 12, true), byteRate = view.getUint32(offset + 16, true), bits = view.getUint16(offset + 22, true);
      align = view.getUint16(offset + 20, true);
      if (![1, 3].includes(kind) || channels < 1 || channels > 8 || rate < 8000 || rate > 192000 || ![8, 16, 24, 32, 64].includes(bits) || kind === 1 && bits === 64 || kind === 3 && ![32, 64].includes(bits) || align !== channels * bits / 8 || byteRate !== rate * align) return false;
    } else if (tag(offset) === "data") { if (dataBytes || !length) return false; dataBytes = length; }
    offset = end + length % 2;
  }
  return foundFormat && dataBytes > 0 && dataBytes % align === 0;
}
