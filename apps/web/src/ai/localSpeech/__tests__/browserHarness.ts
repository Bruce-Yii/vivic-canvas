import { createLocalSpeechSession, DEFAULT_WAKE_KEYWORDS, localSpeechModels, MicCapture, SPEECH_MODELS, transcribeLocalPcm } from "../index";
import { readVerifiedModel } from "../download";
import { IndexedDbModelStorage } from "../storage";
import { getSpeechModel } from "../models";
import type { LocalSpeechEvent, ModelId, WakeKeyword } from "../types";

const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
async function wave() {
  const buffer = await (await fetch("/__local-speech-fixture.wav")).arrayBuffer();
  const view = new DataView(buffer);
  assert(view.getUint32(24, true) === 16000 && view.getUint16(22, true) === 1 && view.getUint16(34, true) === 16, "fixture must be mono 16k PCM16");
  let offset = 12;
  while (offset + 8 < buffer.byteLength) {
    const name = String.fromCharCode(...new Uint8Array(buffer, offset, 4));
    const size = view.getUint32(offset + 4, true);
    if (name === "data") {
      const result = new Float32Array(size / 2);
      for (let i = 0; i < result.length; i++) result[i] = view.getInt16(offset + 8 + i * 2, true) / 32768;
      return result;
    }
    offset += 8 + size + size % 2;
  }
  throw new Error("no WAV data");
}

async function listen(samples: Float32Array, mode: "ptt" | "vad" | "wake", keywords?: WakeKeyword[]) {
  const events: LocalSpeechEvent[] = [];
  const session = createLocalSpeechSession({ mode, recognition: "segment", keywords,
    maxSegmentSeconds: 15, maxListenSeconds: 90, onEvent: event => events.push(event) });
  try {
    await session.start();
    const input = new Float32Array(samples.length + 16000); input.set(samples);
    for (let offset = 0; offset < input.length && !events.some(event => event.type === "segment" || event.type === "fallback"); offset += 512) {
      await session.acceptPcm(input.slice(offset, offset + 512));
    }
    if (!events.some(event => event.type === "segment" || event.type === "fallback")) await session.finish();
    const segment = events.find(event => event.type === "segment");
    assert(segment?.type === "segment", JSON.stringify(events.filter(event => event.type !== "segment")));
    if (segment?.type !== "segment") throw new Error("no segment");
    const bytes = new DataView(await segment.wav.arrayBuffer());
    assert(bytes.getUint32(24, true) === 16000 && bytes.getUint16(34, true) === 16, "cloud WAV contract");
    assert(segment.samples.length <= 15 * 16000 && segment.samples.length > 3200, "bounded nonempty segment");
    return { frames: segment.samples.length, wavBytes: segment.wav.size, wake: events.filter(event => event.type === "wake") };
  } catch (error) {
    throw new Error(`${String(error)}; events=${JSON.stringify(events.filter(event => event.type !== "segment"))}`);
  } finally { session.dispose(); }
}

declare global { interface Window { runLocalSpeechPoc: () => Promise<object> } }
window.runLocalSpeechPoc = async () => {
  const results: { name: string; ok: boolean; ms: number; details?: unknown; error?: string }[] = [];
  const check = async (name: string, test: () => Promise<unknown>) => {
    console.log(`[speech-poc] ${name} start`);
    const start = performance.now();
    try { const details = await test(); results.push({ name, ok: true, ms: performance.now() - start, details }); }
    catch (error) { results.push({ name, ok: false, ms: performance.now() - start, error: String(error) }); }
    console.log(`[speech-poc] ${name} ${results.at(-1)!.ok ? "PASS" : "FAIL"}`);
  };
  const storage = new IndexedDbModelStorage();
  const samples = await wave();
  await localSpeechModels.clearModelCache();
  try {
    await check("cancel-in-flight-model-download", async () => {
      const controller = new AbortController();
      const unsubscribe = localSpeechModels.subscribe(() => {
        const state = localSpeechModels.getSnapshot().models["asr-zh"];
        if (state.phase === "downloading" && state.loaded > 0) controller.abort();
      });
      let aborted = false;
      try { await localSpeechModels.prepareModel("asr-zh", { signal: controller.signal }); }
      catch (error) { aborted = error instanceof DOMException && error.name === "AbortError"; }
      finally { unsubscribe(); }
      await localSpeechModels.refresh();
      assert(aborted && localSpeechModels.getSnapshot().models["asr-zh"].phase === "absent", "cancel must not cache partial model");
    });
    for (const model of SPEECH_MODELS) await check(`download-and-sha256-${model.id}`, async () => {
      await localSpeechModels.prepareModel(model.id);
      assert(localSpeechModels.getSnapshot().models[model.id].phase === "ready", "not ready");
      return { bytes: model.bytes, sha256: model.sha256 };
    });
    await check("default-wake-tokens-in-real-vocabulary", async () => {
      const bytes = await readVerifiedModel(storage, getSpeechModel("kws-zh-en"));
      const file = getSpeechModel("kws-zh-en").metadata!.files.find(file => file.filename === "/tokens.txt")!;
      const vocabulary = new Set(new TextDecoder().decode(bytes.slice(file.start, file.end)).trim().split(/\r?\n/).map(line => line.split(/\s+/)[0]));
      for (const keyword of DEFAULT_WAKE_KEYWORDS) for (const match of keyword.matches) for (const token of match.tokens) assert(vocabulary.has(token), `unknown token ${token}`);
      return DEFAULT_WAKE_KEYWORDS;
    });
    await check("ptt-to-cloud-wav-no-network-asr", () => listen(samples, "ptt"));
    await check("real-silero-v5-file-segmentation", () => listen(samples, "vad"));
    await check("default-kws-vad-initialize-and-dispose", async () => {
      const events: LocalSpeechEvent[] = [];
      const session = createLocalSpeechSession({ mode: "wake", recognition: "segment", keywords: DEFAULT_WAKE_KEYWORDS,
        onEvent: event => events.push(event) });
      try {
        await session.start(); await session.acceptPcm(new Float32Array(16000));
        assert(!events.some(event => event.type === "wake" || event.type === "segment" || event.type === "fallback"), "silence must not wake");
      } finally { session.dispose(); }
    });
    await check("real-kws-hit-and-vad-command", () => {
      // Distinct wake utterance and command, using the authorized synthetic file twice.
      const separated = new Float32Array(samples.length * 2 + 16000);
      separated.set(samples); separated.set(samples, samples.length + 16000);
      return listen(separated, "wake", [{ label: "十分钟", matches: [{ tokens: ["sh", "í", "f", "ēn", "zh", "ōng"] }], threshold: 0.1, score: 1.5 }]).then(result => {
      assert(result.wake.length === 1, "expected exactly one real keyword hit"); return result;
      });
    });
    await check("abort-local-asr-worker", async () => {
      const controller = new AbortController();
      const promise = transcribeLocalPcm(samples, { sampleRate: 16000, signal: controller.signal });
      setTimeout(() => controller.abort(), 80);
      let cancelled = false;
      try { await promise; } catch (error) { cancelled = error instanceof DOMException && error.name === "AbortError"; }
      assert(cancelled, "ASR abort must reject and terminate");
    });
    await check("real-x-asr-int8-chinese-file", async () => {
      const text = await transcribeLocalPcm(samples, { sampleRate: 16000 });
      assert(/喝水/.test(text) && /提醒/.test(text), `unexpected transcript: ${text}`);
      return { text, frames: samples.length, inputSeconds: samples.length / 16000, fixture: "synthetic, not live microphone" };
    });
    await check("real-vad-to-local-asr-session", async () => {
      const events: LocalSpeechEvent[] = [];
      const session = createLocalSpeechSession({ mode: "vad", recognition: "local", onEvent: event => events.push(event) });
      try {
        await session.start();
        const input = new Float32Array(samples.length + 16000); input.set(samples);
        for (let offset = 0; offset < input.length && !events.some(event => event.type === "fallback" || event.type === "status" && event.status === "transcribing"); offset += 512) {
          await session.acceptPcm(input.slice(offset, offset + 512));
        }
        await session.finish();
        const transcript = events.find(event => event.type === "transcript");
        assert(transcript?.type === "transcript" && /喝水/.test(transcript.text), JSON.stringify(events));
        return { text: transcript?.type === "transcript" ? transcript.text : "", statuses: events.filter(event => event.type === "status") };
      } finally { session.dispose(); }
    });
    await check("foreground-blur-cancels-session", async () => {
      const events: LocalSpeechEvent[] = [];
      const session = createLocalSpeechSession({ mode: "ptt", recognition: "segment", onEvent: event => events.push(event) });
      try {
        await session.start(); await session.acceptPcm(samples.slice(0, 512));
        window.dispatchEvent(new Event("blur"));
        let rejected = false;
        try { await session.finish(); } catch { rejected = true; }
        assert(rejected && !events.some(event => event.type === "segment" || event.type === "transcript"), "blur allowed stale speech output");
      } finally { session.dispose(); }
    });
    await check("real-audio-worklet-48k-to-16k-vad-asr-no-hardware", async () => {
      // Virtual MediaStream from the authorized file; never calls getUserMedia or a speaker.
      const sourceContext = new AudioContext({ sampleRate: 48000 });
      const destination = sourceContext.createMediaStreamDestination();
      const buffer = sourceContext.createBuffer(1, samples.length, 16000); buffer.copyToChannel(new Float32Array(samples), 0);
      const source = sourceContext.createBufferSource(); source.buffer = buffer; source.connect(destination);
      let resolve!: (text: string) => void, reject!: (error: Error) => void;
      const done = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
      const timer = setTimeout(() => reject(new Error("virtual worklet transcription timeout")), 30000);
      let mic: MicCapture | undefined, frames = 0, accepting = true;
      const session = createLocalSpeechSession({ mode: "vad", recognition: "local", onEvent: event => {
        if (event.type === "status" && event.status === "transcribing") { accepting = false; mic?.stop(); }
        if (event.type === "transcript") resolve(event.text);
        if (event.type === "fallback") reject(new Error(event.message));
      } });
      mic = new MicCapture({ createContext: () => new AudioContext({ sampleRate: 48000 }), getUserMedia: async () => destination.stream });
      try {
        await session.start();
        await mic.start({ onError: reject, onPcm: async (pcm, rate) => {
          if (!accepting) return;
          assert(rate === 16000, "worklet output rate mismatch"); frames += pcm.length; await session.acceptPcm(pcm, rate);
        } });
        await sourceContext.resume(); source.start();
        const text = await done;
        assert(/提醒/.test(text) && /喝水/.test(text), `worklet transcript ${text}`);
        return { text, sourceRate: 48000, targetRate: 16000, capturedFrames: frames, physicalMicrophone: false, audioPlayback: false };
      } finally {
        clearTimeout(timer); mic.dispose(); session.dispose(); source.disconnect();
        try { source.stop(); } catch { /* Not started on an initialization failure. */ }
        destination.stream.getTracks().forEach(track => track.stop()); await sourceContext.close();
      }
    });
    await check("real-idb-clear-invalidates-old-lease", async () => {
      const record = await storage.get("vad"); assert(record, "VAD missing");
      const lease = await storage.begin("vad"); await storage.delete("vad");
      let rejected = false;
      try { await storage.put(record!, lease); } catch { rejected = true; }
      assert(rejected && !await storage.get("vad"), "old download repopulated cache");
    });
    await check("real-idb-rehash-detects-corruption", async () => {
      const model = getSpeechModel("vad"), bytes = new Uint8Array(model.bytes);
      const lease = await storage.begin("vad");
      await storage.put({ id: "vad", bytes: model.bytes, sha256: model.sha256, blob: new Blob([bytes]) }, lease);
      let rejected = false;
      try { await readVerifiedModel(storage, model); } catch (error) { rejected = String(error).includes("SHA-256"); }
      assert(rejected, "corrupt bytes were accepted"); await storage.delete("vad");
    });
    await check("clear-all-browser-model-cache", async () => {
      await localSpeechModels.clearModelCache(); await localSpeechModels.refresh();
      for (const id of ["asr-zh", "kws-zh-en", "vad"] as ModelId[]) assert(localSpeechModels.getSnapshot().models[id].phase === "absent", `${id} remained cached`);
    });
  } finally { localSpeechModels.dispose(); }
  return { ok: results.every(result => result.ok), userAgent: navigator.userAgent, results };
};
