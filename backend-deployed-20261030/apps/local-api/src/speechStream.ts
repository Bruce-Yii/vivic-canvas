import { z } from "zod";
import { validSpeechWords, type SpeechWord } from "@vivic/contracts";

const MAX_AUDIO = 4 * 1024 * 1024, MAX_WIRE = 8 * 1024 * 1024;
const subtitleSchema = z.object({ text: z.string().max(1000), items: z.array(z.object({
  text: z.string().min(1).max(200), start_time: z.number().int().min(0).max(120000), end_time: z.number().int().min(0).max(120000),
})).max(400) });

/** Fixed StepFun SSE events only. No provider URLs are followed or returned. */
export async function readSpeechStream(response: Response, text: string, signal: AbortSignal): Promise<{ audio: Uint8Array<ArrayBuffer>; words: SpeechWord[] }> {
  if (!response.body || Number(response.headers.get("content-length") ?? 0) > MAX_WIRE) {
    void response.body?.cancel().catch(() => {});
    throw new Error("invalid speech stream");
  }
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: Uint8Array[] = [];
  const items: z.infer<typeof subtitleSchema>["items"] = [];
  let wire = 0, audioBytes = 0, buffer = "", data: string[] = [];
  let audioDone = false, done = false, invalidWords = false;
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", onAbort, { once: true });
  const event = () => {
    if (!data.length) return;
    const payload = data.join("\n"); data = [];
    if (done) throw new Error("data after completion");
    if (payload === "[DONE]") { if (!audioDone) throw new Error("incomplete audio"); done = true; return; }
    const value = JSON.parse(payload);
    if (!value || typeof value !== "object") throw new Error("invalid event");
    if (value.type === "speech.audio.error") throw new Error("provider failure");
    if (value.type === "speech.audio.done") { if (audioDone) throw new Error("duplicate completion"); audioDone = true; return; }
    if (value.type === "speech.audio.delta") {
      if (audioDone || typeof value.audio !== "string" || value.audio.length > 6 * 1024 * 1024
        || value.audio.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.audio)) throw new Error("invalid audio chunk");
      const bytes = Buffer.from(value.audio, "base64"); audioBytes += bytes.length;
      if (audioBytes > MAX_AUDIO) throw new Error("audio too large");
      chunks.push(bytes); return;
    }
    if (value.type === "response.subtitle") {
      if (audioDone) throw new Error("late subtitle");
      const parsed = subtitleSchema.safeParse(value.data);
      if (!parsed.success || items.length + parsed.data.items.length > 400) { invalidWords = true; return; }
      items.push(...parsed.data.items); return;
    }
    throw new Error("unknown speech event");
  };
  const lines = (final = false) => {
    const rows = buffer.split(/\r?\n/); buffer = final ? "" : rows.pop()!;
    for (const line of rows) {
      if (line.length > 6 * 1024 * 1024) throw new Error("speech event too large");
      if (!line) event();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      else if (!line.startsWith(":" ) && !/^(?:event|id|retry):/.test(line)) throw new Error("invalid SSE line");
    }
    if (final) event();
  };
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read(); signal.throwIfAborted();
      if (part.done) break;
      wire += part.value.byteLength; if (wire > MAX_WIRE) throw new Error("speech response too large");
      buffer += decoder.decode(part.value, { stream: true }); lines();
      if (buffer.length > 6 * 1024 * 1024) throw new Error("speech event too large");
    }
    buffer += decoder.decode(); lines(true);
    if (!done || !audioDone || !audioBytes) throw new Error("truncated speech stream");
    const audio = new Uint8Array(audioBytes); let offset = 0;
    for (const chunk of chunks) { audio.set(chunk, offset); offset += chunk.length; }
    const words: SpeechWord[] = []; let cursor = 0;
    for (const item of items) {
      while (/\s/u.test(text[cursor] ?? "") && cursor < text.length) cursor++;
      if (!text.startsWith(item.text, cursor)) { invalidWords = true; break; }
      words.push({ startMs: item.start_time, endMs: item.end_time, charStart: cursor, charEnd: cursor + item.text.length });
      cursor += item.text.length;
    }
    if (text.slice(cursor).trim()) invalidWords = true;
    return { audio, words: invalidWords ? [] : validSpeechWords(text, words) };
  } finally {
    signal.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => {}); reader.releaseLock();
  }
}
