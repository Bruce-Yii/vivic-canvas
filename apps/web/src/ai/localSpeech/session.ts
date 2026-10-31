import { encodeVoiceWav } from "../pcm";
import { abortError, checkAbort, validatePcm } from "./models";
import { SpeechWorkerClient } from "./workerClient";
import type { LocalSpeechEvent, LocalSpeechOptions, PcmTranscriptionOptions } from "./types";

export async function transcribeLocalPcm(samples: Float32Array, options: PcmTranscriptionOptions): Promise<string> {
  checkAbort(options.signal);
  validatePcm(samples, options.sampleRate);
  const timeout = options.timeoutMs ?? 120_000;
  if (!Number.isFinite(timeout) || timeout < 1000 || timeout > 300_000) throw new Error("识别超时参数无效。");
  const copy = new Float32Array(samples);
  const worker = new SpeechWorkerClient({ signal: options.signal });
  try {
    const result = await worker.request({ op: "transcribe", samples: copy }, [copy.buffer], timeout);
    checkAbort(options.signal);
    if (result.type !== "transcript") throw new Error("本地识别没有返回文字。");
    return result.text;
  } finally { worker.close(); }
}

export class LocalSpeechSession {
  private readonly options: LocalSpeechOptions;
  private readonly maxSegmentSeconds: number;
  private readonly maxListenSeconds: number;
  private generation = 0;
  private controller: AbortController | null = null;
  private worker: SpeechWorkerClient | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private ready = false;
  private finishing = false;
  private processing: Promise<void> | null = null;
  private lifecycle: (() => void) | null = null;
  private externalAbort: (() => void) | null = null;
  constructor(options: LocalSpeechOptions) {
    this.maxSegmentSeconds = options.maxSegmentSeconds ?? 15;
    this.maxListenSeconds = options.maxListenSeconds ?? 60;
    if (!["ptt", "vad", "wake"].includes(options.mode) || !["local", "segment"].includes(options.recognition) ||
      !Number.isFinite(this.maxSegmentSeconds) || this.maxSegmentSeconds < 0.5 || this.maxSegmentSeconds > 60 ||
      !Number.isFinite(this.maxListenSeconds) || this.maxListenSeconds < 1 || this.maxListenSeconds > 300) throw new Error("本地监听参数无效。");
    if (options.mode === "wake" && (!options.keywords?.length || options.keywords.length > 16)) throw new Error("请提供 1–16 个已编码的唤醒词。");
    if (options.keywords?.some(item => !item.matches?.length || item.matches.length > 8 || item.matches.some(match => !match.tokens.length || match.tokens.length > 32))) throw new Error("唤醒词词元数量无效。");
    this.options = { ...options, keywords: options.keywords ? structuredClone(options.keywords) : undefined };
  }
  private emit(event: LocalSpeechEvent) { this.options.onEvent(event); }
  private fail(error: unknown, generation: number) {
    if (this.generation !== generation) return;
    const message = error instanceof Error ? error.message : "本地语音失败，请使用 PTT 或文字。";
    this.stop();
    this.emit({ type: "fallback", message });
  }
  start = async () => {
    if (this.disposed) throw new Error("本地语音会话已释放。");
    this.stop(); checkAbort(this.options.signal);
    const generation = this.generation;
    const controller = new AbortController(); this.controller = controller;
    this.finishing = false; this.processing = null;
    this.externalAbort = () => this.stop();
    this.options.signal?.addEventListener("abort", this.externalAbort, { once: true });
    this.emit({ type: "status", status: "loading" });
    const stop = () => this.stop();
    const hidden = () => { if (document.hidden) stop(); };
    if (typeof window !== "undefined") {
      window.addEventListener("blur", stop); window.addEventListener("pagehide", stop);
      document.addEventListener("visibilitychange", hidden);
      this.lifecycle = () => {
        window.removeEventListener("blur", stop); window.removeEventListener("pagehide", stop);
        document.removeEventListener("visibilitychange", hidden);
      };
    }
    this.timer = setTimeout(() => this.fail(new Error("本次前台监听已到时，请重新开启或使用 PTT/文字。"), generation), this.maxListenSeconds * 1000);
    try {
      if (typeof document !== "undefined" && document.hidden) throw new Error("请先回到控制页再开启语音。");
      this.worker = new SpeechWorkerClient({ signal: controller.signal, onFailure: error => this.fail(error, generation), onEvent: message => {
        if (this.generation !== generation || controller.signal.aborted) return;
        if (message.type === "wake") this.emit({ type: "wake", label: message.label });
        if (message.type === "recording") this.emit({ type: "status", status: "recording" });
        if (message.type === "segment" && !this.finishing) {
          this.finishing = true;
          this.processing = this.deliver(message.samples, generation, controller.signal);
        }
      } });
      await this.worker.request({ op: "listen", config: { mode: this.options.mode, keywords: this.options.keywords,
        maxSegmentSeconds: this.maxSegmentSeconds, requireAsr: this.options.recognition === "local" } });
      if (this.generation !== generation || controller.signal.aborted) throw abortError();
      this.ready = true;
      this.emit({ type: "status", status: this.options.mode === "ptt" ? "recording" : "listening" });
    } catch (error) { this.fail(error, generation); throw error; }
  };
  acceptPcm = async (samples: Float32Array, sampleRate = 16000): Promise<void> => {
    const generation = this.generation;
    if (!this.ready || !this.worker || this.finishing) throw new Error("监听未就绪或已收尾。");
    try {
      validatePcm(samples, sampleRate, 16000);
      const copy = new Float32Array(samples);
      await this.worker.request({ op: "pcm", samples: copy }, [copy.buffer]);
    } catch (error) { this.fail(error, generation); throw error; }
  };
  private async deliver(samples: Float32Array, generation: number, signal: AbortSignal) {
    // Segment ack is resolved before this hook: destroy the listener before starting ASR.
    this.ready = false; this.worker?.close(); this.worker = null;
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    try {
      validatePcm(samples, 16000, Math.floor(this.maxSegmentSeconds * 16000));
      if (this.options.recognition === "segment") {
        const wav = encodeVoiceWav([samples], 16000);
        if (this.generation === generation && !signal.aborted) {
          this.emit({ type: "status", status: "stopped" });
          this.emit({ type: "segment", samples, sampleRate: 16000, wav, signal });
        }
      } else {
        this.emit({ type: "status", status: "transcribing" });
        const text = await transcribeLocalPcm(samples, { sampleRate: 16000, signal });
        if (this.generation === generation && !signal.aborted) {
          this.emit({ type: "status", status: "stopped" });
          this.emit({ type: "transcript", text });
        }
      }
    } catch (error) { this.fail(error, generation); }
  }
  finish = async (): Promise<void> => {
    if (this.processing) return this.processing;
    if (!this.ready || !this.worker) throw new Error("监听未就绪或已结束。");
    const generation = this.generation;
    try {
      await this.worker.request({ op: "finish" });
      await this.processing;
    } catch (error) { this.fail(error, generation); throw error; }
  };
  stop = () => {
    this.generation++;
    this.ready = false;
    this.controller?.abort(); this.controller = null;
    this.worker?.close(); this.worker = null;
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    this.lifecycle?.(); this.lifecycle = null;
    if (this.externalAbort) this.options.signal?.removeEventListener("abort", this.externalAbort);
    this.externalAbort = null;
    this.processing = null;
    this.emit({ type: "status", status: "stopped" });
  };
  dispose = () => { if (!this.disposed) { this.stop(); this.disposed = true; } };
}
export const createLocalSpeechSession = (options: LocalSpeechOptions) => new LocalSpeechSession(options);
