import { describe, expect, it } from "vitest";
import { ActivitySchema, validSpeechWords } from "@vivic/contracts";
import { speechEnvelope, speechFrame, speechDisplayFrame, readTimedSpeech } from "../speechTelemetry";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { feedbackPhrase } from "../shortFeedback";

describe("measured playback feedback without recording or audio output", () => {
  it("uses PCM RMS and the media clock; gaps and volume zero never fake speech energy", () => {
    const pcm = new Float32Array(1600); pcm.fill(0.25, 400, 800);
    const envelope = speechEnvelope([pcm], 8000)!;
    expect(envelope.levels).toEqual([0, 0.8, 0, 0]);
    const words = [{ startMs: 50, endMs: 100, charStart: 0, charEnd: 1 }];
    expect(speechFrame(words, envelope, 60, 0.5)).toEqual({ amplitude: 0.4, wordRange: { start: 0, end: 1 } });
    expect(speechFrame(words, envelope, 110, 1)).toEqual({ amplitude: 0, wordRange: null });
    expect(speechFrame(words, envelope, 60, 0).amplitude).toBe(0);
    expect(speechEnvelope([new Float32Array([NaN])], 8000)).toBeNull();
    expect(speechEnvelope([], 8000)).toBeNull();
    expect(speechEnvelope([pcm], NaN)).toBeNull();
  });
  it("keeps long-text word ranges on screen and refuses surrogate-splitting timestamps", () => {
    const text = "测".repeat(130) + "试😀";
    const frame = speechDisplayFrame(text, { start: 130, end: 131 });
    expect(frame.text[frame.wordStart!]).toBe("试");
    expect(frame.wordEnd! - frame.wordStart!).toBe(1); expect(frame.text.length).toBeLessThanOrEqual(120);
    const gap = speechDisplayFrame(text, null, { start: 130, end: 131 });
    expect(gap.text).toBe(frame.text); expect(gap.wordStart).toBeUndefined();
    expect(validSpeechWords("😀", [{ startMs: 0, endMs: 100, charStart: 0, charEnd: 1 }])).toEqual([]);
    expect(validSpeechWords("你好", [{ startMs: 100, endMs: 200, charStart: 0, charEnd: 1 }, { startMs: 0, endMs: 50, charStart: 1, charEnd: 2 }])).toEqual([]);
  });
  it("only transports bounded current-word ranges for the actual speaking phase", () => {
    const base = { requestId: "TEST", text: "你好", expiresAt: 1000, phase: "speaking", speech: { amplitude: 0.5, wordStart: 0, wordEnd: 1 } };
    expect(ActivitySchema.safeParse(base).success).toBe(true);
    for (const patch of [{ phase: "thinking" }, { speech: { amplitude: 2 } }, { speech: { amplitude: 0.5, wordStart: 0, wordEnd: 3 } }])
      expect(ActivitySchema.safeParse({ ...base, ...patch }).success).toBe(false);
  });
  it("decodes bounded local JSON and falls back when the timeline is unusable", async () => {
    const result = await readTimedSpeech(new Response(JSON.stringify({ audioBase64: "SUQz", words: [
      { startMs: 50, endMs: 200, charStart: 0, charEnd: 1 },
    ] })), "你好", new AbortController().signal);
    expect(result.blob.type).toBe("audio/mpeg"); expect(result.blob.size).toBe(3); expect(result.words).toHaveLength(1);
    await expect(readTimedSpeech(new Response('{"audioBase64":"not valid","words":[]}'), "你好", new AbortController().signal)).rejects.toThrow();
  });
  it("ships only fixed authored clips with matching provenance hashes", () => {
    const root = new URL("../../../public/voice-feedback/", import.meta.url);
    const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8"));
    expect(manifest.files).toHaveLength(3);
    for (const file of manifest.files) {
      const bytes = readFileSync(new URL(file.file, root));
      expect(bytes.length).toBe(file.bytes); expect(bytes.length).toBeLessThan(16000);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
    }
    expect(feedbackPhrase("用户任意文本")).toBeNull(); expect(feedbackPhrase("__proto__")).toBeNull();
  });
  it("bundles the authored StepFun voice and respects a different selected voice", () => {
    const root = new URL("../../../public/voice-feedback/stepfun/", import.meta.url);
    const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8"));
    expect(manifest.voice).toBe("wenrounvsheng");
    expect(manifest.model).toBe("stepaudio-2.5-tts");
    expect(manifest.files).toHaveLength(16);
    for (const file of manifest.files) {
      expect(feedbackPhrase(file.text)?.url).toBe(`/voice-feedback/stepfun/${file.file}`);
      expect(feedbackPhrase(file.text, "cixingnansheng")).toBeNull();
      const bytes = readFileSync(new URL(file.file, root));
      expect(bytes.length).toBe(file.bytes); expect(bytes.length).toBeLessThan(100000);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
    }
    expect(feedbackPhrase("已保存一份用户文件")).toBeNull();
  });
  it("cancels a stalled timeline body on abort", async () => {
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    await expect(readTimedSpeech(new Response(body), "你好", AbortSignal.timeout(10))).rejects.toThrow();
    expect(cancelled).toBe(true);
  });
});
