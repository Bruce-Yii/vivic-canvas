import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { SPEECH_VOICES, SPEECH_VOICES_SOURCE } from "../src/voices.js";

class FakeAudio {
  static instances: FakeAudio[] = [];
  static blocked = false;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  pause = vi.fn();
  load = vi.fn();
  removeAttribute = vi.fn();
  src: string;
  volume = 1;
  constructor(src: string) {
    this.src = src;
    FakeAudio.instances.push(this);
  }
  play = vi.fn(async () => {
    if (FakeAudio.blocked) throw new DOMException("blocked", "NotAllowedError");
  });
}

const audioResponse = () => new Response(new Uint8Array([0x49, 0x44, 0x33]), {
  headers: { "content-type": "audio/mpeg" },
});

// Runtime import keeps DOM declarations out of local-api's Node-only tsc graph.
// The normal web typecheck validates speech.ts; these tests need no browser/port.
const browserModule = fileURLToPath(new URL("../../web/src/ai/speech.ts", import.meta.url));
const loadSpeech = () => import(browserModule);
let stored: Map<string, string>;
let storage: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.resetModules();
  FakeAudio.instances = [];
  FakeAudio.blocked = false;
  stored = new Map();
  storage = {
    getItem: vi.fn((key: string) => stored.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { stored.set(key, value); }),
  };
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("fetch", vi.fn(async () => audioResponse()));
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:unit-speech");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("speech player lifecycle (offline, no server)", () => {
  it("defaults off and never fetches when disabled", async () => {
    const speech = await loadSpeech();
    expect(speech.getSpeechSnapshot().enabled).toBe(false);
    expect(speech.getSpeechSnapshot().preferences).toEqual({ voice: "wenrounvsheng", speed: 1.3, volume: 1 });
    expect(await speech.speakText("你好", { requestId: "one" })).toEqual({ status: "skipped" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("notifies subscribers, completes and releases audio and object URL", async () => {
    const speech = await loadSpeech();
    const listener = vi.fn();
    const unsubscribe = speech.subscribeSpeech(listener);
    speech.setSpeechEnabled(true);
    const pending = speech.speakText("你好", { requestId: "one" });
    expect(speech.getSpeechSnapshot()).toMatchObject({
      status: "loading", loading: true, playing: false, requestId: "one", text: "你好", kind: "feedback",
    });
    await vi.waitFor(() => expect(speech.getSpeechSnapshot().status).toBe("playing"));
    expect(speech.getSpeechSnapshot()).toMatchObject({
      status: "playing", loading: false, playing: true, requestId: "one", text: "你好", kind: "feedback",
    });
    const audio = FakeAudio.instances[0]!;
    audio.onended!();
    expect(await pending).toEqual({ status: "completed" });
    expect(audio.pause).toHaveBeenCalledOnce();
    expect(audio.removeAttribute).toHaveBeenCalledWith("src");
    expect(audio.load).toHaveBeenCalledOnce();
    expect(audio.onended).toBeNull();
    expect(audio.onerror).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:unit-speech");
    expect(speech.getSpeechSnapshot()).toMatchObject({
      status: "idle", error: null, loading: false, playing: false, requestId: "one", text: "你好",
    });
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    listener.mockClear();
    speech.setSpeechEnabled(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it("same request ID does not replay or interrupt its active audio", async () => {
    const speech = await loadSpeech();
    speech.setSpeechEnabled(true);
    const pending = speech.speakText("你好", { requestId: "same" });
    await vi.waitFor(() => expect(FakeAudio.instances).toHaveLength(1));
    expect(await speech.speakText("你好", { requestId: "same" })).toEqual({ status: "skipped" });
    expect(FakeAudio.instances[0]!.pause).not.toHaveBeenCalled();
    FakeAudio.instances[0]!.onended!();
    await pending;
    expect(await speech.speakText("你好", { requestId: "same" })).toEqual({ status: "skipped" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("new requests interrupt old audio; the same text may play for a new ID", async () => {
    const speech = await loadSpeech();
    speech.setSpeechEnabled(true);
    const first = speech.speakText("完成", { requestId: "first" });
    await vi.waitFor(() => expect(FakeAudio.instances).toHaveLength(1));
    const second = speech.speakText("完成", { requestId: "second" });
    expect(await first).toEqual({ status: "cancelled" });
    expect(FakeAudio.instances[0]!.pause).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(FakeAudio.instances).toHaveLength(2));
    FakeAudio.instances[1]!.onended!();
    expect(await second).toEqual({ status: "completed" });
  });

  it("cancels a pending fetch immediately and aborts its signal", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url, init) => {
      signal = init.signal;
      return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason)));
    }));
    const speech = await loadSpeech();
    speech.setSpeechEnabled(true);
    const pending = speech.speakText("你好", { requestId: "one" });
    speech.cancelSpeech();
    expect(await pending).toEqual({ status: "cancelled" });
    expect(signal?.aborted).toBe(true);
    expect(speech.getSpeechSnapshot()).toMatchObject({
      status: "idle", loading: false, playing: false, requestId: null, text: null, kind: null,
    });
    expect(FakeAudio.instances).toHaveLength(0);
  });

  it("discards a late body after cancellation", async () => {
    let deliver!: (blob: Blob) => void;
    const body = new Promise<Blob>((resolve) => { deliver = resolve; });
    const reading = vi.fn(() => body);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, headers: new Headers({ "content-type": "audio/mpeg" }), blob: reading })));
    const speech = await loadSpeech();
    speech.setSpeechEnabled(true);
    const pending = speech.speakText("你好", { requestId: "one" });
    await vi.waitFor(() => expect(reading).toHaveBeenCalled());
    speech.cancelSpeech();
    deliver(new Blob(["audio"], { type: "audio/mpeg" }));
    expect(await pending).toEqual({ status: "cancelled" });
    await Promise.resolve();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(FakeAudio.instances).toHaveLength(0);
  });

  it("external AbortSignal stops playback and removes listeners", async () => {
    const speech = await loadSpeech();
    speech.setSpeechEnabled(true);
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const pending = speech.speakText("你好", { requestId: "one", signal: controller.signal });
    await vi.waitFor(() => expect(FakeAudio.instances).toHaveLength(1));
    controller.abort();
    expect(await pending).toEqual({ status: "cancelled" });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
  });

  it("an already aborted signal makes no request", async () => {
    const speech = await loadSpeech();
    speech.setSpeechEnabled(true);
    expect(await speech.speakText("你好", { requestId: "one", signal: AbortSignal.abort() }))
      .toEqual({ status: "cancelled" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("turning the switch off immediately cancels and cleans playback", async () => {
    const speech = await loadSpeech();
    speech.setSpeechEnabled(true);
    const pending = speech.speakText("你好", { requestId: "one" });
    await vi.waitFor(() => expect(FakeAudio.instances).toHaveLength(1));
    speech.setSpeechEnabled(false);
    expect(await pending).toEqual({ status: "cancelled" });
    expect(speech.getSpeechSnapshot()).toMatchObject({ enabled: false, status: "idle" });
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
  });

  it("autoplay rejection is visible and releases the audio URL", async () => {
    FakeAudio.blocked = true;
    const speech = await loadSpeech();
    speech.setSpeechEnabled(true);
    expect(await speech.speakText("你好", { requestId: "one" })).toMatchObject({ status: "error" });
    expect(speech.getSpeechSnapshot().error).toContain("浏览器阻止");
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
  });

  it("service errors appear beside the switch without constructing audio", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Plan 语音不可用" }, { status: 503 })));
    const speech = await loadSpeech();
    speech.setSpeechEnabled(true);
    expect(await speech.speakText("你好", { requestId: "one" })).toEqual({ status: "error", error: "Plan 语音不可用" });
    expect(speech.getSpeechSnapshot().error).toBe("Plan 语音不可用");
    expect(speech.getSpeechSnapshot()).toMatchObject({
      status: "error", loading: false, playing: false, requestId: "one", text: "你好",
    });
    expect(FakeAudio.instances).toHaveLength(0);
  });

  it.each(["", "  ", "你好\n", "\u200b"])("rejects invalid short text before fetching: %j", async (text) => {
    const speech = await loadSpeech();
    speech.setSpeechEnabled(true);
    expect(await speech.speakText(text, { requestId: "one" })).toMatchObject({ status: "error" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("speech preferences and audition", () => {
  it.each([
    ["提醒".repeat(80), "提醒".repeat(80)],
    ["长".repeat(400), "长".repeat(200)],
    ["长".repeat(199) + "😀剩余内容", "长".repeat(199)],
    ["长".repeat(198) + "😀剩余内容", "长".repeat(198) + "😀"],
  ])("sends safe bounded text matching the full playback snapshot", async (text, expected) => {
    const speech = await loadSpeech();
    speech.setSpeechEnabled(true);
    const pending = speech.speakText(text, { requestId: "long-reminder" });
    expect(speech.getSpeechSnapshot()).toMatchObject({ requestId: "long-reminder", text: expected });
    await vi.waitFor(() => expect(speech.getSpeechSnapshot().playing).toBe(true));
    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(JSON.parse(String(init?.body)).text).toBe(expected);
    expect(expected.length).toBeLessThanOrEqual(200);
    FakeAudio.instances[0]!.onended!();
    expect(await pending).toEqual({ status: "completed" });
    expect(speech.getSpeechSnapshot()).toMatchObject({ requestId: "long-reminder", text: expected, status: "idle" });
  });

  it("uses the same sourced official subset as the API", async () => {
    const speech = await loadSpeech();
    expect(speech.SPEECH_VOICES).toEqual(SPEECH_VOICES);
    expect(speech.SPEECH_VOICES_SOURCE).toBe(SPEECH_VOICES_SOURCE);
  });

  it("persists only public settings, restores them after reload, and keeps automatic feedback off", async () => {
    const speech = await loadSpeech();
    speech.setSpeechEnabled(true);
    expect(speech.setSpeechPreferences({ voice: "linjiajiejie", speed: 1.4, volume: 0.35, apiKey: "must-not-save", enabled: true })).toBe(true);
    expect(storage.setItem).toHaveBeenCalledWith(speech.SPEECH_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ voice: "linjiajiejie", speed: 1.4, volume: 0.35 }));
    const serialized = stored.get(speech.SPEECH_PREFERENCES_STORAGE_KEY)!;
    expect(serialized).not.toMatch(/enabled|apiKey|must-not-save|requestId|text/);
    vi.resetModules();
    const reloaded = await loadSpeech();
    expect(reloaded.getSpeechSnapshot()).toMatchObject({
      enabled: false, status: "idle", requestId: null, text: null,
      preferences: { voice: "linjiajiejie", speed: 1.4, volume: 0.35 },
    });
    expect(await reloaded.speakText("你好", { requestId: "one" })).toEqual({ status: "skipped" });
    expect(fetch).not.toHaveBeenCalled();
    expect(storage.getItem.mock.calls.every(([key]) => [speech.SPEECH_PREFERENCES_STORAGE_KEY, "vivic.voice.providers.v1"].includes(key))).toBe(true);
  });

  it.each([
    "{", "null", "[]", '"wrong"',
    JSON.stringify({ voice: "unknown", speed: 0.2, volume: 7, enabled: true }),
    JSON.stringify({ voice: 123, speed: "1.2", volume: null }),
  ])("ignores malformed or unverified persisted values: %s", async (value) => {
    stored.set("vivic.speech.preferences.v1", value);
    const speech = await loadSpeech();
    expect(speech.getSpeechSnapshot()).toMatchObject({
      enabled: false, preferences: { voice: "wenrounvsheng", speed: 1.3, volume: 1 },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("recovers public fields independently and ignores persisted playback state", async () => {
    stored.set("vivic.speech.preferences.v1", JSON.stringify({
      voice: "wenrounvsheng", speed: -1, volume: 0, enabled: true,
      text: "stale", requestId: "old", status: "playing",
    }));
    const speech = await loadSpeech();
    expect(speech.getSpeechSnapshot()).toMatchObject({
      enabled: false, status: "idle", text: null, requestId: null,
      preferences: { voice: "wenrounvsheng", speed: 1.3, volume: 0 },
    });
  });

  it("continues in memory when storage reads or writes are denied", async () => {
    storage.getItem.mockImplementation(() => { throw new Error("denied"); });
    storage.setItem.mockImplementation(() => { throw new Error("quota"); });
    const speech = await loadSpeech();
    expect(speech.getSpeechSnapshot().preferenceError).toContain("无法读取");
    expect(speech.setSpeechPreferences({ volume: 0.5 })).toBe(true);
    expect(speech.getSpeechSnapshot().preferences.volume).toBe(0.5);
    expect(speech.getSpeechSnapshot().preferenceError).toContain("暂未保存");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { voice: "unknown" }, { speed: 0.4 }, { speed: 2.1 }, { speed: NaN },
    { volume: -0.1 }, { volume: 1.1 }, { volume: Infinity }, { timestamps: "yes" },
  ])("rejects invalid settings without persisting: %j", async (patch) => {
    const speech = await loadSpeech();
    expect(speech.setSpeechPreferences(patch)).toBe(false);
    expect(speech.getSpeechSnapshot().preferences).toEqual({ voice: "wenrounvsheng", speed: 1.3, volume: 1 });
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("auditions the selected voice and speed without enabling automatic speech; volume stays local and updates live", async () => {
    const speech = await loadSpeech();
    speech.setSpeechPreferences({ voice: "ruyananshi", speed: 0.5, volume: 0.35 });
    const pending = speech.previewSpeech({ requestId: "audition" });
    expect(speech.getSpeechSnapshot()).toMatchObject({ enabled: false, kind: "preview", requestId: "audition", loading: true });
    await vi.waitFor(() => expect(speech.getSpeechSnapshot().playing).toBe(true));
    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      text: speech.getSpeechSnapshot().text, voice: "ruyananshi", speed: 0.5,
    });
    expect(FakeAudio.instances[0]!.volume).toBe(0.35);
    speech.setSpeechPreferences({ volume: 0 });
    expect(FakeAudio.instances[0]!.volume).toBe(0);
    expect(fetch).toHaveBeenCalledOnce();
    FakeAudio.instances[0]!.onended!();
    expect(await pending).toEqual({ status: "completed" });
    expect(speech.getSpeechSnapshot()).toMatchObject({ enabled: false, requestId: "audition", kind: "preview", playing: false, loading: false });
    speech.cancelSpeech();
    expect(speech.getSpeechSnapshot()).toMatchObject({ requestId: null, text: null, kind: null });
  });

  it("requests timestamps only after explicit preference opt-in and cancels obsolete synthesis", async () => {
    const speech = await loadSpeech();
    expect(speech.getSpeechSnapshot().preferences.timestamps).not.toBe(true);
    expect(speech.setSpeechPreferences({ timestamps: true })).toBe(true);
    expect(JSON.parse(stored.get("vivic.speech.preferences.v1")!).timestamps).toBe(true);
    const first = speech.previewSpeech({ requestId: "timed-preview" });
    await vi.waitFor(() => expect(speech.getSpeechSnapshot().playing).toBe(true));
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]?.body)).timestamps).toBe(true);
    speech.setSpeechPreferences({ timestamps: false });
    expect(await first).toEqual({ status: "cancelled" });
    const second = speech.previewSpeech({ requestId: "ordinary-preview" });
    await vi.waitFor(() => expect(speech.getSpeechSnapshot().playing).toBe(true));
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[1]![1]?.body))).not.toHaveProperty("timestamps");
    FakeAudio.instances[1]!.onended!();
    expect(await second).toEqual({ status: "completed" });
  });

  it("keeps fixed short cues silent by default, uses only local files, and cancels only their owning request", async () => {
    const speech = await loadSpeech();
    expect(await speech.speakShortFeedback("我看看", { requestId: "plan:checking" })).toEqual({ status: "skipped" });
    expect(fetch).not.toHaveBeenCalled();
    speech.setSpeechEnabled(true);
    const pending = speech.speakShortFeedback("我看看", { requestId: "plan:checking" });
    await vi.waitFor(() => expect(speech.getSpeechSnapshot().playing).toBe(true));
    expect(vi.mocked(fetch).mock.calls[0]).toMatchObject(["/voice-feedback/stepfun/checking.mp3", { method: "GET" }]);
    expect(vi.mocked(fetch).mock.calls[0]![1]?.body).toBeUndefined();
    expect(speech.getSpeechSnapshot().source).toBe("prerecorded");
    speech.cancelShortFeedback("another-plan"); expect(speech.getSpeechSnapshot().playing).toBe(true);
    speech.cancelShortFeedback("plan"); expect(await pending).toEqual({ status: "cancelled" });
    expect(speech.getSpeechSnapshot()).toMatchObject({ source: null, amplitude: 0, wordRange: null });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("changing synthesis settings cancels audition and does not generate another request", async () => {
    const speech = await loadSpeech();
    const pending = speech.previewSpeech();
    await vi.waitFor(() => expect(FakeAudio.instances).toHaveLength(1));
    speech.setSpeechPreferences({ voice: "wenrounvsheng", speed: 1.5 });
    expect(await pending).toEqual({ status: "cancelled" });
    expect(speech.getSpeechSnapshot()).toMatchObject({ status: "idle", requestId: null, text: null });
    expect(FakeAudio.instances[0]!.pause).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("clears the old subtitle identity before loading the next request", async () => {
    const speech = await loadSpeech();
    const transitions: unknown[] = [];
    speech.setSpeechEnabled(true);
    speech.subscribeSpeech(() => {
      const { status, requestId, text, loading, playing } = speech.getSpeechSnapshot();
      transitions.push({ status, requestId, text, loading, playing });
    });
    const first = speech.speakText("旧提醒", { requestId: "old" });
    await vi.waitFor(() => expect(speech.getSpeechSnapshot().playing).toBe(true));
    const second = speech.speakText("新提醒", { requestId: "new" });
    expect(await first).toEqual({ status: "cancelled" });
    expect(transitions).toContainEqual({ status: "idle", requestId: null, text: null, loading: false, playing: false });
    expect(speech.getSpeechSnapshot()).toMatchObject({ status: "loading", requestId: "new", text: "新提醒" });
    await vi.waitFor(() => expect(speech.getSpeechSnapshot().playing).toBe(true));
    speech.cancelSpeech();
    expect(await second).toEqual({ status: "cancelled" });
    expect(speech.getSpeechSnapshot()).toMatchObject({ requestId: null, text: null, loading: false, playing: false });
  });
});
