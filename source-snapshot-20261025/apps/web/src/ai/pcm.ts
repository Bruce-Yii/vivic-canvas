export const VOICE_SAMPLE_RATE = 16000;
export const MAX_RECORDING_SECONDS = 60;

/** Mono PCM16 WAV is portable across browser recording containers and Plan ASR. */
export const encodeVoiceWav = (chunks: Float32Array[], sourceRate: number): Blob => {
  const frames = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (!Number.isFinite(sourceRate) || sourceRate < 8000 || sourceRate > 192000 ||
      frames < sourceRate * 0.2 || frames > sourceRate * (MAX_RECORDING_SECONDS + 0.25)) {
    throw new Error("录音时长无效，请录制 0.2–60 秒的语音。");
  }
  const source = new Float32Array(Math.min(frames, sourceRate * MAX_RECORDING_SECONDS));
  let offset = 0;
  let peak = 0;
  for (const chunk of chunks) {
    const count = Math.min(chunk.length, source.length - offset);
    if (count <= 0) break;
    for (let i = 0; i < count; i++) {
      const sample = Number.isFinite(chunk[i]) ? Math.max(-1, Math.min(1, chunk[i]!)) : 0;
      source[offset++] = sample;
      peak = Math.max(peak, Math.abs(sample));
    }
  }
  if (peak < 0.00001) throw new Error("没有录到声音，请检查麦克风后重试。");
  const count = Math.floor(source.length * VOICE_SAMPLE_RATE / sourceRate);
  const buffer = new ArrayBuffer(44 + count * 2);
  const view = new DataView(buffer);
  const ascii = (at: number, value: string) => [...value].forEach((char, i) => view.setUint8(at + i, char.charCodeAt(0)));
  ascii(0, "RIFF"); view.setUint32(4, 36 + count * 2, true); ascii(8, "WAVE");
  ascii(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, VOICE_SAMPLE_RATE, true);
  view.setUint32(28, VOICE_SAMPLE_RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, "data"); view.setUint32(40, count * 2, true);
  const ratio = sourceRate / VOICE_SAMPLE_RATE;
  for (let i = 0; i < count; i++) {
    // Average the source window when downsampling, linear interpolation when
    // upsampling. The browser also applies its own device-rate conversion.
    const at = i * ratio;
    let sample: number;
    if (ratio >= 1) {
      const from = Math.floor(at), to = Math.min(source.length, Math.max(from + 1, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let j = from; j < to; j++) sum += source[j]!;
      sample = sum / (to - from);
    } else {
      const from = Math.floor(at), fraction = at - from;
      sample = source[from]! * (1 - fraction) + source[Math.min(from + 1, source.length - 1)]! * fraction;
    }
    view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return new Blob([buffer], { type: "audio/wav" });
};
