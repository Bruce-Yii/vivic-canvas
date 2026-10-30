/** Narrow browser upload contract: RIFF/WAVE, PCM16, mono, 16000 Hz. */
export const MAX_ASR_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_ASR_PCM_BYTES = 60 * 16000 * 2;

export class AsrAudioError extends Error {}

/** Validate the entire chunk layout; never trust extension, MIME or duration metadata. */
export const extractAsrPcm = (bytes: Uint8Array): Uint8Array => {
  const fail = (): never => {
    throw new AsrAudioError("音频必须是完整的 16kHz、单声道、16bit PCM WAV，时长 1 个采样至 60 秒。请重新录音。");
  };
  if (bytes.length < 44 || bytes.length > MAX_ASR_FILE_BYTES) return fail();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE" || view.getUint32(4, true) !== bytes.length - 8) return fail();
  let formatSeen = false;
  let pcm: Uint8Array | undefined;
  let offset = 12;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) return fail();
    const kind = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + size;
    const paddedEnd = end + (size % 2);
    if (paddedEnd > bytes.length) return fail();
    if (kind === "fmt ") {
      // Only canonical PCM fmt; reject extensible, float and ambiguous duplicates.
      if (formatSeen || pcm || size !== 16 ||
          view.getUint16(start, true) !== 1 || view.getUint16(start + 2, true) !== 1 ||
          view.getUint32(start + 4, true) !== 16000 || view.getUint32(start + 8, true) !== 32000 ||
          view.getUint16(start + 12, true) !== 2 || view.getUint16(start + 14, true) !== 16) return fail();
      formatSeen = true;
    } else if (kind === "data") {
      if (!formatSeen || pcm || !size || size % 2) return fail();
      if (size > MAX_ASR_PCM_BYTES) {
        throw new AsrAudioError("录音超过 60 秒，请缩短后重试；本次未发送识别请求。");
      }
      pcm = bytes.subarray(start, end);
    } else {
      // Browser encoder emits fmt + data only. No embedded metadata or alternate payloads.
      return fail();
    }
    offset = paddedEnd;
  }
  if (!formatSeen || !pcm) return fail();
  return pcm;
};
