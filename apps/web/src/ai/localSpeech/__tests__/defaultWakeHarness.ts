import { createLocalSpeechSession, DEFAULT_WAKE_KEYWORDS, DEFAULT_WAKE_PHRASE, localSpeechModels, SPEECH_MODELS, transcribeLocalPcm } from "../index";
import type { LocalSpeechEvent } from "../types";
async function wav(name: string) {
  const bytes = await (await fetch(`/__wake-fixture/${name}.wav`)).arrayBuffer();
  const view = new DataView(bytes); let offset = 12;
  while (offset + 8 < bytes.byteLength) {
    const size = view.getUint32(offset + 4, true);
    if (view.getUint32(offset, false) === 0x64617461) { const pcm = new Float32Array(size / 2); for (let i = 0; i < pcm.length; i++) pcm[i] = view.getInt16(offset + 8 + i * 2, true) / 32768; return pcm; }
    offset += 8 + size + size % 2;
  }
  throw new Error("Invalid fixture WAV");
}
declare global { interface Window { runDefaultWakePoc: (silenceSeconds: number) => Promise<object> } }
window.runDefaultWakePoc = async (silenceSeconds: number) => {
  const results: { name: string; ok: boolean; details?: unknown; error?: string }[] = [];
  const check = async (name: string, run: () => Promise<unknown>) => {
    console.log(`[speech-poc] ${name} start`);
    try { results.push({ name, ok: true, details: await run() }); } catch (error) { results.push({ name, ok: false, error: String(error) }); }
    console.log(`[speech-poc] ${name} ${results.at(-1)!.ok ? "PASS" : "FAIL"}`);
  };
  try {
    for (const model of SPEECH_MODELS) await localSpeechModels.prepareModel(model.id);
    for (const speaker of [3, 6, 9]) await check(`default-wake-synthetic-speaker-${speaker}`, async () => {
      const wake = await wav(`wake-${speaker}`), command = await wav(`command-${speaker}`);
      const input = new Float32Array(wake.length + command.length + 32000); input.set(wake); input.set(command, wake.length + 16000);
      const events: LocalSpeechEvent[] = [];
      const session = createLocalSpeechSession({ mode: "wake", recognition: "segment", keywords: DEFAULT_WAKE_KEYWORDS, maxListenSeconds: 90, onEvent: event => events.push(event) });
      try {
        await session.start();
        for (let offset = 0; offset < input.length && !events.some(e => e.type === "segment" || e.type === "fallback"); offset += 512) await session.acceptPcm(input.slice(offset, offset + 512));
        if (!events.some(e => e.type === "segment")) await session.finish();
        const segment = events.find(e => e.type === "segment");
        if (events.filter(e => e.type === "wake").length !== 1 || segment?.type !== "segment") throw new Error(JSON.stringify(events.filter(e => e.type !== "segment")));
        const text = await transcribeLocalPcm(segment.samples, { sampleRate: 16000 });
        if (!/提醒/.test(text) || !/喝水/.test(text) || text.toLowerCase().includes(DEFAULT_WAKE_PHRASE)) throw new Error(`Invalid command segment: ${text}`);
        return { text, wakeEvents: events.filter(e => e.type === "wake"), frames: segment.samples.length };
      } finally { session.dispose(); }
    });
    if (silenceSeconds > 0) await check("real-time-foreground-synthetic-silence", async () => {
      const events: LocalSpeechEvent[] = [];
      const session = createLocalSpeechSession({ mode: "wake", recognition: "segment", keywords: DEFAULT_WAKE_KEYWORDS,
        maxListenSeconds: Math.min(300, silenceSeconds + 2), onEvent: event => events.push(event) });
      try {
        const started = performance.now(); await session.start(); const listeningAt = performance.now(); let frames = 0;
        while (performance.now() - started < silenceSeconds * 1000 && !events.some(e => e.type === "fallback")) {
          try { await session.acceptPcm(new Float32Array(512)); }
          catch (error) { if (!events.some(e => e.type === "fallback") || performance.now() - started < silenceSeconds * 1000 - 100) throw error; break; }
          frames += 512; await new Promise(resolve => setTimeout(resolve, 32));
        }
        const elapsedMs = performance.now() - started;
        if (events.some(e => e.type === "wake" || e.type === "segment") || elapsedMs < silenceSeconds * 1000 - 100) throw new Error(JSON.stringify({ elapsedMs, events }));
        return { elapsedMs, listeningElapsedMs: performance.now() - listeningAt, frames, events, syntheticSilenceOnly: true, microphone: false };
      } finally { session.dispose(); }
    });
  } finally { localSpeechModels.dispose(); }
  return { ok: results.every(row => row.ok), userAgent: navigator.userAgent, results, microphone: false, playback: false, syntheticVoicesOnly: true };
};
