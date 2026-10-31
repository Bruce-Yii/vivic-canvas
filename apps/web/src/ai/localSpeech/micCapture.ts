import { abortError, checkAbort } from "./models";
import { StreamingPcmResampler } from "./resample";

export interface MicCaptureOptions {
  onPcm: (samples: Float32Array, sampleRate: 16000) => Promise<void> | void;
  onError: (error: Error) => void;
  signal?: AbortSignal;
  maxSeconds?: number;
  /** Resume audio in the click gesture, then await model initialization before opening the mic. */
  ready?: Promise<unknown>;
}
interface CapturePlatform {
  createContext: () => AudioContext;
  getUserMedia: () => Promise<MediaStream>;
  createWorklet: (context: AudioContext) => AudioWorkletNode;
}
const raceAbort = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { signal.removeEventListener("abort", abort); if (signal.aborted) reject(abortError()); else resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); });
  });
};

/** Owns one foreground, explicit opt-in mic stream. No capture on import/construction. */
export class MicCapture {
  private readonly platform: CapturePlatform;
  private generation = 0;
  private controller: AbortController | null = null;
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private worklet: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private sink: GainNode | null = null;
  private cleanup: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  constructor(platform: Partial<CapturePlatform> = {}) {
    this.platform = {
      createContext: () => { if (typeof AudioContext === "undefined") throw new Error("此浏览器不支持音频采集，请使用文字。"); return new AudioContext(); },
      getUserMedia: () => {
        if (!navigator.mediaDevices?.getUserMedia) return Promise.reject(new Error("此浏览器不支持麦克风采集，请使用文字。"));
        return navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
      },
      createWorklet: context => new AudioWorkletNode(context, "vivic-pcm-capture", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: "explicit" }),
      ...platform,
    };
  }
  /** Call directly in the click handler so AudioContext.resume runs in the user gesture. */
  start = async (options: MicCaptureOptions): Promise<void> => {
    if (this.disposed) throw new Error("麦克风采集器已释放。");
    this.stop(); checkAbort(options.signal);
    const maxSeconds = options.maxSeconds ?? 300;
    if (!Number.isFinite(maxSeconds) || maxSeconds < 1 || maxSeconds > 300) throw new Error("前台监听最长 5 分钟。");
    const generation = this.generation, controller = new AbortController(); this.controller = controller;
    const signal = controller.signal;
    const stop = () => this.stop();
    const hidden = () => { if (document.hidden) stop(); };
    const fail = (cause: unknown) => {
      if (this.generation !== generation) return;
      this.stop(); options.onError(cause instanceof Error ? cause : new Error("麦克风采集失败，请使用 PTT 或文字。"));
    };
    options.signal?.addEventListener("abort", stop, { once: true });
    if (typeof window !== "undefined") {
      window.addEventListener("blur", stop); window.addEventListener("pagehide", stop); document.addEventListener("visibilitychange", hidden);
    }
    this.cleanup = () => {
      options.signal?.removeEventListener("abort", stop);
      if (typeof window !== "undefined") { window.removeEventListener("blur", stop); window.removeEventListener("pagehide", stop); document.removeEventListener("visibilitychange", hidden); }
    };
    this.timer = setTimeout(() => fail(new Error("前台监听已到时，请重新点击开启。")), maxSeconds * 1000);
    try {
      if (typeof window !== "undefined" && (!window.isSecureContext || document.hidden)) throw new Error("请在 localhost/HTTPS 的前台控制页启用麦克风。");
      const audio = this.platform.createContext(); this.context = audio;
      // Invoked before any permission/model await.
      await raceAbort(audio.resume(), signal);
      if (options.ready) await raceAbort(options.ready, signal);
      const acquisition = this.platform.getUserMedia();
      void acquisition.then(stream => { if (this.generation !== generation) stream.getTracks().forEach(track => track.stop()); }).catch(() => {});
      const stream = await raceAbort(acquisition, signal); this.stream = stream;
      await raceAbort(audio.audioWorklet.addModule("/audio-capture-worklet.js"), signal);
      const resampler = new StreamingPcmResampler(audio.sampleRate);
      const worklet = this.platform.createWorklet(audio); this.worklet = worklet;
      let queuedFrames = 0, queue = Promise.resolve();
      worklet.port.onmessage = event => {
        if (this.generation !== generation || signal.aborted || !(event.data instanceof Float32Array)) return;
        try {
          const samples = resampler.push(event.data);
          if (!samples.length) return;
          if (queuedFrames + samples.length > 8000) throw new Error("本地语音处理跟不上录音，已停止；请使用 PTT 或文字。");
          queuedFrames += samples.length;
          queue = queue.then(async () => {
            if (this.generation !== generation || signal.aborted) return;
            try { await options.onPcm(samples, 16000); }
            finally { if (this.generation === generation) queuedFrames -= samples.length; }
          }).catch(fail);
        } catch (error) { fail(error); }
      };
      this.source = audio.createMediaStreamSource(stream); this.sink = audio.createGain(); this.sink.gain.value = 0;
      this.source.connect(worklet); worklet.connect(this.sink); this.sink.connect(audio.destination);
      const ended = () => fail(new Error("麦克风已断开，请使用 PTT 或文字。"));
      const tracks = stream.getAudioTracks(); tracks.forEach(track => track.addEventListener("ended", ended));
      const before = this.cleanup;
      this.cleanup = () => { before?.(); tracks.forEach(track => track.removeEventListener("ended", ended)); };
      checkAbort(signal);
    } catch (error) { fail(error); throw error; }
  };
  stop = () => {
    this.generation++;
    this.controller?.abort(); this.controller = null;
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    this.cleanup?.(); this.cleanup = null;
    if (this.worklet) { this.worklet.port.onmessage = null; this.worklet.disconnect(); this.worklet.port.close(); } this.worklet = null;
    this.source?.disconnect(); this.source = null; this.sink?.disconnect(); this.sink = null;
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    const context = this.context; this.context = null;
    if (context && context.state !== "closed") void context.close().catch(() => {});
  };
  dispose = () => { if (!this.disposed) { this.stop(); this.disposed = true; } };
}
