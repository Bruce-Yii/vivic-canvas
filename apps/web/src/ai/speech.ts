import { routeAudioOutput } from "./audioOutput";
import { getVoiceConfiguration } from "./voiceConfig";
import { createBrowserTtsAdapter } from "./localSpeech/browserTts";
import { synthesizeLocalSpeech } from "./localSpeech/localTts";
import { decodeSpeechEnvelope, readTimedSpeech, speechFrame, type SpeechEnvelope, type SpeechRange } from "./speechTelemetry";
import type { SpeechWord } from "@vivic/contracts";
import { feedbackPhrase } from "./shortFeedback";

/** Curated official subset, verified 2026-10-15. Kept in sync with API by offline tests. */
export const SPEECH_VOICES_SOURCE = "https://platform.stepfun.com/docs/zh/guides/developer/tts#官方音色清单";
export const SPEECH_VOICES = [
  { id: "cixingnansheng", name: "磁性男声" },
  { id: "wenrounansheng", name: "温柔男声" },
  { id: "ruyananshi", name: "儒雅男士" },
  { id: "jingdiannvsheng", name: "经典女声" },
  { id: "wenrounvsheng", name: "温柔女声" },
  { id: "yuanqishaonv", name: "元气少女" },
  { id: "linjiajiejie", name: "邻家姐姐" },
  { id: "zhixingjiejie", name: "知性姐姐" },
] as const;
export type SpeechVoiceId = (typeof SPEECH_VOICES)[number]["id"];

export interface SpeechPreferences {
  voice: SpeechVoiceId;
  speed: number;
  /** Browser playback volume: 0 (muted) through 1. Never sent upstream. */
  volume: number;
  /** Explicit opt-in until the user's Plan timestamp capability is verified. */
  timestamps?: boolean;
  outputDeviceId?: string;
}

export const SPEECH_PREFERENCES_STORAGE_KEY = "vivic.speech.preferences.v1";
const DEFAULT_PREFERENCES: SpeechPreferences = { voice: "wenrounvsheng", speed: 1.3, volume: 1 };
const isVoice = (value: unknown): value is SpeechVoiceId => SPEECH_VOICES.some((voice) => voice.id === value);
const inRange = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

const readPreferences = (): { preferences: SpeechPreferences; preferenceError: string | null } => {
  const preferences = { ...DEFAULT_PREFERENCES };
  try {
    if (typeof localStorage !== "undefined") {
      const raw: unknown = JSON.parse(localStorage.getItem(SPEECH_PREFERENCES_STORAGE_KEY) ?? "null");
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        if ("voice" in raw && isVoice(raw.voice)) preferences.voice = raw.voice;
        if ("speed" in raw && inRange(raw.speed, 0.5, 2)) preferences.speed = raw.speed;
        if ("volume" in raw && inRange(raw.volume, 0, 1)) preferences.volume = raw.volume;
        if ("outputDeviceId" in raw && typeof raw.outputDeviceId === "string" && raw.outputDeviceId.length <= 512) preferences.outputDeviceId = raw.outputDeviceId;
        if ("timestamps" in raw && typeof raw.timestamps === "boolean") preferences.timestamps = raw.timestamps;
      }
    }
    return { preferences, preferenceError: null };
  } catch {
    return { preferences, preferenceError: "无法读取语音偏好，已使用默认设置。" };
  }
};

/** Same-tab TTS status; only public preferences are persisted. */
export interface SpeechSnapshot {
  enabled: boolean;
  status: "idle" | "loading" | "playing" | "error";
  loading: boolean;
  playing: boolean;
  requestId: string | null;
  text: string | null;
  kind: "feedback" | "preview" | "phrase" | null;
  source: "stepfun" | "browser" | "local" | "prerecorded" | null;
  amplitude: number;
  wordRange: SpeechRange | null;
  error: string | null;
  preferences: SpeechPreferences;
  preferenceError: string | null;
}

export type SpeechResult =
  | { status: "completed" | "skipped" | "cancelled" }
  | { status: "error"; error: string };

let snapshot: SpeechSnapshot = {
  enabled: false, status: "idle", loading: false, playing: false,
  requestId: null, text: null, kind: null, source: null, amplitude: 0, wordRange: null, error: null, ...readPreferences(),
};
const listeners = new Set<() => void>();
// Bounded event IDs, not text: distinct commands may legitimately say the same thing.
const seen = new Set<string>();

export const getSpeechSnapshot = (): SpeechSnapshot => snapshot;
export const subscribeSpeech = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

const update = (patch: Partial<SpeechSnapshot>) => {
  snapshot = { ...snapshot, ...patch };
  snapshot.loading = snapshot.status === "loading";
  snapshot.playing = snapshot.status === "playing";
  listeners.forEach((listener) => listener());
};

interface Playback {
  controller: AbortController;
  audio?: HTMLAudioElement;
  url?: string;
  done: boolean;
  stopTelemetry?: () => void;
  finish: (result: SpeechResult) => void;
}
let active: Playback | undefined;
const browserTts = createBrowserTtsAdapter();

/** Stops both the pending HTTP request and any audio, settling its promise. */
export const cancelSpeech = (): void => {
  browserTts.cancel();
  if (active) {
    active.controller.abort();
    active.finish({ status: "cancelled" });
  } else if (snapshot.status !== "idle" || snapshot.error || snapshot.requestId !== null) {
    update({ status: "idle", error: null, requestId: null, text: null, kind: null, source: null, amplitude: 0, wordRange: null });
  }
};

export const setSpeechEnabled = (enabled: boolean): void => {
  if (!enabled) cancelSpeech();
  if (snapshot.enabled !== enabled) update({ enabled });
};

/** Clear only Vivic's public voice preferences; never touch account storage. */
export const resetSpeechPreferences = (): void => {
  cancelSpeech();
  localStorage.removeItem(SPEECH_PREFERENCES_STORAGE_KEY);
  seen.clear();
  update({ enabled: false, preferences: { ...DEFAULT_PREFERENCES }, preferenceError: null });
};

/** Invalid values are rejected; storage denial leaves the settings usable in memory. */
export const setSpeechPreferences = (patch: Partial<SpeechPreferences>): boolean => {
  if ((patch.voice !== undefined && !isVoice(patch.voice)) ||
      (patch.speed !== undefined && !inRange(patch.speed, 0.5, 2)) ||
      (patch.volume !== undefined && !inRange(patch.volume, 0, 1)) ||
      (patch.timestamps !== undefined && typeof patch.timestamps !== "boolean") ||
      (patch.outputDeviceId !== undefined && (typeof patch.outputDeviceId !== "string" || patch.outputDeviceId.length > 512))) return false;
  const preferences: SpeechPreferences = {
    ...(patch.outputDeviceId !== undefined || snapshot.preferences.outputDeviceId !== undefined ? { outputDeviceId: patch.outputDeviceId ?? snapshot.preferences.outputDeviceId } : {}),
    voice: patch.voice ?? snapshot.preferences.voice,
    speed: patch.speed ?? snapshot.preferences.speed,
    volume: patch.volume ?? snapshot.preferences.volume,
    ...(patch.timestamps !== undefined || snapshot.preferences.timestamps !== undefined
      ? { timestamps: patch.timestamps ?? snapshot.preferences.timestamps } : {}),
  };
  // Changing synthesis settings cancels obsolete audio. Volume is live, with no new request.
  if (preferences.voice !== snapshot.preferences.voice || preferences.speed !== snapshot.preferences.speed
    || preferences.timestamps !== snapshot.preferences.timestamps || preferences.outputDeviceId !== snapshot.preferences.outputDeviceId) cancelSpeech();
  if (active?.audio) active.audio.volume = preferences.volume;
  let preferenceError: string | null = null;
  try {
    if (typeof localStorage === "undefined") throw new Error("storage unavailable");
    localStorage.setItem(SPEECH_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    preferenceError = "语音偏好暂未保存，刷新后可能恢复默认。";
  }
  update({ preferences, preferenceError });
  return true;
};

/**
 * Opt-in, latest-request-wins playback. Resolves on end, cancellation or error;
 * never throws for service/autoplay failures. Reusing an event ID skips playback.
 */
export const speakText = (
  text: string,
  options: { requestId: string; signal?: AbortSignal },
): Promise<SpeechResult> => playText(text, options, "feedback");

export const speakShortFeedback = (text: "我看看" | "稍等" | "好的", options: { requestId: string; signal?: AbortSignal }) =>
  playText(text, options, "phrase");

/** Finishing a plan must cancel only that plan's short cue, never another utterance. */
export const cancelShortFeedback = (requestId: string) => {
  if (snapshot.kind === "phrase" && snapshot.requestId?.startsWith(`${requestId}:`)) cancelSpeech();
};

/** Explicit audition works while automatic feedback is off, without enabling it. */
export const previewSpeech = (
  options: { requestId?: string; signal?: AbortSignal } = {},
): Promise<SpeechResult> => playText("你好，我是 Vivic。这是当前音色的试听，你可以调整语速和音量。", {
  ...options, requestId: options.requestId ?? `preview-${crypto.randomUUID()}`,
}, "preview");

const playText = (
  text: string,
  options: { requestId: string; signal?: AbortSignal },
  kind: "feedback" | "preview" | "phrase",
): Promise<SpeechResult> => {
  if (getVoiceConfiguration().tts === "none") return Promise.resolve({ status: "skipped" });
  if (kind !== "preview" && !snapshot.enabled) return Promise.resolve({ status: "skipped" });
  if (options.signal?.aborted) return Promise.resolve({ status: "cancelled" });
  if (seen.has(options.requestId)) return Promise.resolve({ status: "skipped" });
  cancelSpeech();
  // The HTTP schema caps UTF-16 length. Never cut between a surrogate pair.
  const spokenText = typeof text === "string"
    ? text.trim().slice(0, 200).replace(/[\uD800-\uDBFF]$/u, "").trimEnd()
    : "";
  if (!options.requestId?.trim() || options.requestId.length > 256 ||
      !spokenText ||
      /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text)) {
    const error = "语音只接受 1–200 字符的可见短句及有效请求 ID。";
    update({ status: "error", error, requestId: null, text: null, kind });
    return Promise.resolve({ status: "error", error });
  }
  seen.add(options.requestId);
  if (seen.size > 128) seen.delete(seen.values().next().value!);

  return new Promise<SpeechResult>((resolve) => {
    const controller = new AbortController();
    const onAbort = () => {
      controller.abort();
      job.finish({ status: "cancelled" });
    };
    const job: Playback = {
      controller,
      done: false,
      finish: (result) => {
        if (job.done) return;
        job.done = true;
        job.stopTelemetry?.();
        options.signal?.removeEventListener("abort", onAbort);
        if (job.audio) {
          job.audio.onended = null;
          job.audio.onerror = null;
          job.audio.ontimeupdate = null; job.audio.onpause = null; job.audio.onwaiting = null; job.audio.onplaying = null;
          job.audio.pause();
          job.audio.removeAttribute("src");
          job.audio.load();
        }
        if (job.url) URL.revokeObjectURL(job.url);
        if (active === job) {
          active = undefined;
          update(result.status === "error"
            ? { status: "error", error: result.error, amplitude: 0, wordRange: null }
            : result.status === "cancelled"
              ? { status: "idle", error: null, requestId: null, text: null, kind: null, source: null, amplitude: 0, wordRange: null }
              : { status: "idle", error: null, amplitude: 0, wordRange: null });
        }
        resolve(result);
      },
    };
    active = job;
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const { voice, speed } = snapshot.preferences;
    update({ status: "loading", error: null, requestId: options.requestId, text: spokenText, kind, amplitude: 0, wordRange: null, source: null });
    if (job.done) return;
    const run = async () => {
      try {
        const voiceConfig = getVoiceConfiguration();
        const phrase = kind !== "preview" && voiceConfig.tts !== "local" ? feedbackPhrase(spokenText, voice) : null;
        if (kind === "phrase" && !phrase && voiceConfig.tts !== "local") { job.finish({ status: "skipped" }); return; }
        if (!phrase && voiceConfig.tts === "browser") {
          update({ source: "browser" });
          browserTts.setEnabled(true);
          await browserTts.speak(spokenText, {
            ...(voiceConfig.browserVoice ? { voiceId: voiceConfig.browserVoice } : {}),
            localOnly: true, signal: controller.signal,
            rate: speed, volume: snapshot.preferences.volume,
            onStart: () => { if (!job.done) update({ status: "playing", error: null }); },
            onBoundary: (start, length) => {
              if (job.done || !snapshot.playing) return;
              const valid = length > 0 && start + length <= spokenText.length
                && !/[\uDC00-\uDFFF]/u.test(spokenText[start] ?? "")
                && !/[\uD800-\uDBFF]/u.test(spokenText[start + length - 1] ?? "");
              update({ wordRange: valid ? { start, end: start + length } : null });
            },
          });
          job.finish({ status: "completed" }); return;
        }
        const local = getVoiceConfiguration().tts === "local";
        update({ source: phrase ? "prerecorded" : local ? "local" : "stepfun" });
        const response = local ? await synthesizeLocalSpeech(spokenText, speed, controller.signal) : await fetch(phrase?.url ?? "/api/speech", {
          method: phrase ? "GET" : "POST",
          headers: { "content-type": "application/json" },
          ...(phrase ? {} : { body: JSON.stringify({ text: spokenText, voice, speed,
            ...(snapshot.preferences.timestamps ? { timestamps: true } : {}) }) }),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
          cache: phrase ? "force-cache" : "no-store",
        });
        if (job.done) return;
        if (!response.ok) {
          const body: unknown = await response.json().catch(() => null);
          const error = body && typeof body === "object" && "error" in body &&
            typeof body.error === "string" ? body.error.slice(0, 300) : `语音不可用（HTTP ${response.status}）`;
          job.finish({ status: "error", error });
          return;
        }
        let words: SpeechWord[] = [];
        const timed = /^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? "") && !phrase
          ? await readTimedSpeech(response, spokenText, controller.signal) : null;
        const blob = timed?.blob ?? await response.blob();
        words = timed?.words ?? [];
        if (job.done) return;
        if (!blob.size || blob.size > 4 * 1024 * 1024 || !(local ? /^audio\/wav(;|$)/i.test(blob.type) : /^audio\/(mpeg|mp3)(;|$)/i.test(blob.type))) {
          job.finish({ status: "error", error: "语音服务未返回有效音频。" });
          return;
        }
        job.url = URL.createObjectURL(blob);
        job.audio = new Audio(job.url);
        job.audio.volume = snapshot.preferences.volume;
        if (phrase) job.audio.playbackRate = speed;
        let envelope: SpeechEnvelope | null = null;
        const tick = () => {
          if (job.done || active !== job || !job.audio || !snapshot.playing) return;
          if (job.audio.paused === true) { update({ amplitude: 0, wordRange: null }); return; }
          update(speechFrame(words, envelope, (job.audio.currentTime || 0) * 1000, snapshot.preferences.volume));
        };
        // Decoding never delays playback; a late analysis cannot revive a cancelled job.
        void decodeSpeechEnvelope(blob, controller.signal).then(value => { if (!job.done && active === job) { envelope = value; tick(); } });
        job.audio.ontimeupdate = tick;
        job.audio.onpause = () => { if (!job.done) update({ status: "loading", amplitude: 0, wordRange: null }); };
        job.audio.onwaiting = () => { if (!job.done) update({ status: "loading", amplitude: 0, wordRange: null }); };
        job.audio.onplaying = () => { if (!job.done) { update({ status: "playing", error: null }); tick(); } };
        job.audio.onended = () => job.finish({ status: "completed" });
        job.audio.onerror = () => job.finish({ status: "error", error: "浏览器无法播放语音。" });
        try { await routeAudioOutput(job.audio, snapshot.preferences.outputDeviceId); }
        catch (error) { job.finish({ status: "error", error: error instanceof Error ? error.message : "输出设备不可用。" }); return; }
        if (job.done) return;
        await job.audio.play();
        if (!job.done) {
          update({ status: "playing", error: null }); tick();
          if (Number.isFinite(job.audio.currentTime)) {
            const timer = setInterval(tick, 100); job.stopTelemetry = () => clearInterval(timer);
          }
        }
      } catch (error) {
        if (job.done) return;
        const blocked = error instanceof DOMException && error.name === "NotAllowedError";
        job.finish({ status: "error", error: blocked
          ? "浏览器阻止了语音播放，请在控制页交互后重试。"
          : getVoiceConfiguration().tts === "local" && error instanceof Error ? error.message : "语音不可用：本地服务连接失败或请求超时。" });
      }
    };
    void run();
  });
};

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", cancelSpeech);
  window.addEventListener("vivic:voice-config-change", cancelSpeech);
}
