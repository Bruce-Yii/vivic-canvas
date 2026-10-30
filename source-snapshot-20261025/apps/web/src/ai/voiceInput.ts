import { MAX_RECORDING_SECONDS, encodeVoiceWav } from "./pcm";
import { getVoiceConfiguration } from "./voiceConfig";
import { localSpeechModels, transcribeLocalPcm } from "./localSpeech";

export type VoiceStatus = "idle" | "requesting" | "recording" | "transcribing" | "review" | "error";
export interface VoiceInputSnapshot {
  status: VoiceStatus;
  seconds: number;
  text: string;
  error: string | null;
}
let snapshot: VoiceInputSnapshot = { status: "idle", seconds: 0, text: "", error: null };
const listeners = new Set<() => void>();
let generation = 0;
let stream: MediaStream | null = null;
let context: AudioContext | null = null;
let source: MediaStreamAudioSourceNode | null = null;
let recorder: AudioWorkletNode | null = null;
let sink: GainNode | null = null;
let chunks: Float32Array[] = [];
let frames = 0;
let poll: ReturnType<typeof setInterval> | null = null;
let upload: AbortController | null = null;
let recorderFlushed: (() => void) | null = null;

export const getVoiceInputSnapshot = () => snapshot;
export const subscribeVoiceInput = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const isVoiceInputBusy = () => ["requesting", "recording", "transcribing"].includes(snapshot.status);
const update = (patch: Partial<VoiceInputSnapshot>) => {
  snapshot = { ...snapshot, ...patch }; listeners.forEach(listener => listener());
};
const releaseCapture = () => {
  if (poll) clearInterval(poll); poll = null;
  if (recorder) { recorder.port.onmessage = null; recorder.disconnect(); recorder.port.close(); } recorder = null;
  source?.disconnect(); source = null; sink?.disconnect(); sink = null;
  stream?.getTracks().forEach(track => track.stop()); stream = null;
  const old = context; context = null; if (old && old.state !== "closed") void old.close().catch(() => undefined);
  recorderFlushed?.(); recorderFlushed = null;
};

/** Cancel even a permission prompt whose MediaStream arrives after cancellation. */
export const cancelVoiceInput = () => {
  generation += 1; upload?.abort(); upload = null;
  releaseCapture(); chunks = []; frames = 0;
  update({ status: "idle", seconds: 0, text: "", error: null });
};

const captureError = (error: unknown): string => {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "麦克风权限未开启，请在浏览器允许后重试；仍可输入文字。";
  if (name === "NotFoundError") return "没有找到麦克风，请连接设备或使用文字输入。";
  if (name === "NotReadableError") return "麦克风暂时被占用，请关闭占用程序后重试。";
  return "无法录音，请检查麦克风及浏览器支持；文字输入仍可使用。";
};

export const startVoiceInput = async () => {
  cancelVoiceInput();
  const token = generation;
  const stt = getVoiceConfiguration().stt;
  if (stt === "none") { update({ status: "error", error: "当前使用文字输入；可在语音设置中选择识别服务。" }); return; }
  if (stt === "local" && !["cached", "ready"].includes(localSpeechModels.getSnapshot().models["asr-zh"].phase)) {
    update({ status: "error", error: "请先下载本地中文识别模型，或选择 StepFun / 文字输入。" }); return;
  }
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined" || typeof AudioWorkletNode === "undefined") {
    update({ status: "error", error: "此浏览器不支持安全录音，请使用 localhost/HTTPS 下的现代浏览器，或输入文字。" }); return;
  }
  update({ status: "requesting", error: null, text: "", seconds: 0 });
  let acquired: MediaStream | null = null;
  let audio: AudioContext | null = null;
  try {
    audio = new AudioContext({ sampleRate: 16000 });
    // Resume in the original pointer/key gesture, before the permission await.
    await audio.resume();
    if (token !== generation) { await audio.close(); return; }
    context = audio;
    acquired = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
    if (token !== generation) { acquired.getTracks().forEach(track => track.stop()); if (audio.state !== "closed") await audio.close(); return; }
    stream = acquired;
    await audio.audioWorklet.addModule("/audio-capture-worklet.js");
    if (token !== generation) { acquired.getTracks().forEach(track => track.stop()); return; }
    recorder = new AudioWorkletNode(audio, "vivic-pcm-capture", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    recorder.port.onmessage = event => {
      if (token !== generation) return;
      if (event.data?.stopped) { recorderFlushed?.(); recorderFlushed = null; return; }
      if (!(event.data instanceof Float32Array)) return;
      const allowed = Math.max(0, audio!.sampleRate * MAX_RECORDING_SECONDS - frames);
      if (allowed) { const part = event.data.length <= allowed ? event.data : event.data.slice(0, allowed); chunks.push(part); frames += part.length; }
    };
    source = audio.createMediaStreamSource(acquired);
    sink = audio.createGain(); sink.gain.value = 0;
    source.connect(recorder); recorder.connect(sink); sink.connect(audio.destination);
    const began = Date.now();
    update({ status: "recording" });
    acquired.getAudioTracks().forEach(track => track.addEventListener("ended", () => {
      if (token === generation && snapshot.status === "recording") { cancelVoiceInput(); update({ status: "error", error: "麦克风连接已断开，请重试或输入文字。" }); }
    }));
    poll = setInterval(() => {
      if (token !== generation) return;
      const seconds = Math.min(MAX_RECORDING_SECONDS, Math.floor((Date.now() - began) / 1000));
      update({ seconds });
      if (seconds >= MAX_RECORDING_SECONDS) void finishVoiceInput();
    }, 250);
  } catch (error) {
    acquired?.getTracks().forEach(track => track.stop());
    if (audio && audio !== context && audio.state !== "closed") void audio.close().catch(() => undefined);
    if (token !== generation) return;
    releaseCapture(); chunks = [];
    update({ status: "error", error: captureError(error) });
  }
};

export const finishVoiceInput = async () => {
  if (snapshot.status === "requesting") { cancelVoiceInput(); return; }
  if (snapshot.status !== "recording" || !context || !recorder) return;
  const token = generation;
  const rate = context.sampleRate;
  update({ status: "transcribing", error: null });
  if (poll) clearInterval(poll); poll = null;
  try {
    // Flush the worklet tail before closing the stream. Missing flush is an
    // error, so we never send an accidentally truncated utterance.
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => { recorderFlushed = null; reject(new Error("录音收尾失败，请重试。")); }, 1000);
      recorderFlushed = () => { clearTimeout(deadline); resolve(); };
      recorder!.port.postMessage("stop");
    });
    if (token !== generation) return;
    const blob = encodeVoiceWav(chunks, rate);
    releaseCapture(); chunks = []; frames = 0;
    if (getVoiceConfiguration().stt === "local") {
      const bytes = await blob.arrayBuffer();
      const view = new DataView(bytes); const samples = new Float32Array((bytes.byteLength - 44) / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(44 + i * 2, true) / 32768;
      const controller = new AbortController(); upload = controller;
      const text = (await transcribeLocalPcm(samples, { sampleRate: 16000, signal: controller.signal })).trim();
      if (token !== generation) return;
      if (!text || text.length > 500) { update({ status: "error", error: "没有获得可靠的本地转写，请重试或输入文字。" }); return; }
      update({ status: "review", text, error: null }); return;
    }
    const form = new FormData(); form.set("file", blob, "voice.wav");
    const controller = new AbortController(); upload = controller;
    const response = await fetch("/api/transcribe", { method: "POST", body: form,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(40000)]), cache: "no-store" });
    const body: unknown = await response.json();
    if (token !== generation) return;
    if (!response.ok || !body || typeof body !== "object" || !("ok" in body) || body.ok !== true || !("text" in body) || typeof body.text !== "string" || !body.text.trim() || body.text.length > 500) {
      const message = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error.slice(0, 300) : "没有获得可靠转写，请重试或输入文字。";
      update({ status: "error", error: message }); return;
    }
    update({ status: "review", text: body.text.trim(), error: null });
  } catch (error) {
    if (token !== generation) return;
    releaseCapture(); chunks = []; frames = 0;
    update({ status: "error", error: error instanceof Error && /录音|没有录到/.test(error.message)
      ? error.message : "语音识别超时或连接失败，请重试；文字输入仍可使用。" });
  } finally {
    if (token === generation) upload = null;
  }
};

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", cancelVoiceInput);
  window.addEventListener("vivic:voice-config-change", cancelVoiceInput);
  window.addEventListener("blur", () => {
    if (snapshot.status === "requesting" || snapshot.status === "recording") cancelVoiceInput();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && (snapshot.status === "requesting" || snapshot.status === "recording")) cancelVoiceInput();
  });
}
