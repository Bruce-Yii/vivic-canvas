import { TimedSpeechResponseSchema, validSpeechWords, type SpeechWord } from "@vivic/contracts";

export interface SpeechEnvelope { frameMs: number; levels: number[] }
export interface SpeechRange { start: number; end: number }

/** Measured RMS, not a guessed text-duration or a microphone signal. */
export function speechEnvelope(channels: readonly Float32Array[], sampleRate: number): SpeechEnvelope | null {
  const size = channels[0]?.length ?? 0;
  if (!channels.length || channels.length > 2 || !size || !Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 96000
    || size / sampleRate > 120 || channels.some(channel => channel.length !== size)) return null;
  const frameMs = 50, step = Math.round(sampleRate * frameMs / 1000), levels: number[] = [];
  for (let offset = 0; offset < size; offset += step) {
    const end = Math.min(size, offset + step); let power = 0;
    for (const channel of channels) for (let i = offset; i < end; i++) power += channel[i]! ** 2;
    if (!Number.isFinite(power)) return null;
    levels.push(Math.min(1, Math.sqrt(power / ((end - offset) * channels.length)) * 3.2));
  }
  return { frameMs, levels };
}

/** Offline decoding has no speaker graph, playback, or microphone permission. */
export async function decodeSpeechEnvelope(blob: Blob, signal: AbortSignal): Promise<SpeechEnvelope | null> {
  if (typeof OfflineAudioContext === "undefined" || signal.aborted || blob.size > 4 * 1024 * 1024) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const decoding = (async () => {
      const bytes = await blob.arrayBuffer(); if (signal.aborted) return null;
      const context = new OfflineAudioContext(1, 1, 24000);
      const buffer = await context.decodeAudioData(bytes);
      if (signal.aborted || buffer.duration > 120 || buffer.numberOfChannels > 2) return null;
      return speechEnvelope(Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i)), buffer.sampleRate);
    })();
    return await Promise.race([decoding, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1500); })]);
  } catch { return null; } finally { if (timer !== undefined) clearTimeout(timer); }
}

export function speechFrame(words: readonly SpeechWord[], envelope: SpeechEnvelope | null, timeMs: number, volume: number) {
  const word = words.find(item => item.startMs <= timeMs && item.endMs > timeMs);
  return {
    amplitude: Math.min(1, Math.max(0, (envelope?.levels[Math.floor(timeMs / envelope.frameMs)] ?? 0) * volume)),
    wordRange: word ? { start: word.charStart, end: word.charEnd } : null,
  };
}

/** Keep the active word visible on long utterances, with indices relative to this line. */
export function speechDisplayFrame(text: string, range: SpeechRange | null, lastRange: SpeechRange | null = null) {
  const anchor = range ?? lastRange;
  let start = text.length > 120 && anchor ? Math.floor(anchor.start / 100) * 100 : 0;
  if (anchor && anchor.end > start + 120) start = anchor.start;
  if (/[\uDC00-\uDFFF]/u.test(text[start] ?? "")) start++;
  const line = text.slice(start, start + 120).replace(/[\uD800-\uDBFF]$/u, "");
  const visible = range && range.start >= start && range.end <= start + line.length;
  return { text: line, ...(visible ? { wordStart: range.start - start, wordEnd: range.end - start } : {}) };
}

/** The local JSON envelope is bounded before parsing; audio bytes remain request memory. */
export async function readTimedSpeech(response: Response, text: string, signal: AbortSignal) {
  if (!response.body || Number(response.headers.get("content-length") ?? 0) > 6 * 1024 * 1024) {
    void response.body?.cancel().catch(() => {});
    throw new Error("Invalid speech response");
  }
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0, json = "";
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength; if (size > 6 * 1024 * 1024) throw new Error("Speech response too large");
      json += decoder.decode(part.value, { stream: true });
    }
    json += decoder.decode();
    const result = TimedSpeechResponseSchema.parse(JSON.parse(json));
    const binary = atob(result.audioBase64);
    if (binary.length > 4 * 1024 * 1024) throw new Error("Speech audio too large");
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    return { blob: new Blob([bytes], { type: "audio/mpeg" }), words: validSpeechWords(text, result.words) };
  } finally {
    signal.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => {}); reader.releaseLock();
  }
}
