import { abortError, checkAbort } from "./models";

export interface BrowserVoice { id: string; name: string; lang: string; localService: boolean; default: boolean }
export interface BrowserTtsOptions {
  voiceId?: string;
  localOnly?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  rate?: number;
  volume?: number;
  /** Fires only on the browser's actual start event, never when speak() is called. */
  onStart?: () => void;
  onBoundary?: (charIndex: number, charLength: number) => void;
}

/** Independent OS/browser TTS. localService is a browser claim, not an offline guarantee. */
export class BrowserTtsAdapter {
  private enabled = false;
  private generation = 0;
  private rejectCurrent: (() => void) | null = null;
  private readonly synthesis?: SpeechSynthesis;
  private readonly makeUtterance: (text: string) => SpeechSynthesisUtterance;
  constructor(options: { synthesis?: SpeechSynthesis; makeUtterance?: (text: string) => SpeechSynthesisUtterance } = {}) {
    this.synthesis = options.synthesis ?? (typeof window === "undefined" ? undefined : window.speechSynthesis);
    this.makeUtterance = options.makeUtterance ?? (text => new SpeechSynthesisUtterance(text));
  }
  isEnabled = () => this.enabled;
  setEnabled = (enabled: boolean) => { this.enabled = enabled; if (!enabled) this.cancel(); };
  voices = (): BrowserVoice[] => (this.synthesis?.getVoices() ?? []).map(voice => ({
    id: voice.voiceURI, name: voice.name, lang: voice.lang, localService: voice.localService, default: voice.default,
  }));
  subscribeVoices = (listener: () => void) => {
    this.synthesis?.addEventListener("voiceschanged", listener);
    return () => this.synthesis?.removeEventListener("voiceschanged", listener);
  };
  cancel = () => {
    this.generation++;
    const reject = this.rejectCurrent; this.rejectCurrent = null;
    if (reject) { this.synthesis?.cancel(); reject(); }
  };
  speak = (text: string, options: BrowserTtsOptions = {}): Promise<void> => {
    checkAbort(options.signal);
    if (!this.enabled || !this.synthesis) return Promise.reject(new Error("浏览器语音未启用或不可用；文字操作仍可使用。"));
    if (!text.trim() || text.length > 500 || /[\p{Cc}\p{Cf}]/u.test(text)) return Promise.reject(new Error("播报文字无效。"));
    const timeout = options.timeoutMs ?? 60_000;
    if (!Number.isFinite(timeout) || timeout < 1000 || timeout > 120_000) return Promise.reject(new Error("播报超时参数无效。"));
    const rate = options.rate ?? 1, volume = options.volume ?? 1;
    if (!Number.isFinite(rate) || rate < 0.5 || rate > 2 || !Number.isFinite(volume) || volume < 0 || volume > 1) return Promise.reject(new Error("播报速度或音量参数无效。"));
    const voices = this.synthesis.getVoices().filter(voice => options.localOnly === false || voice.localService);
    const voice = options.voiceId ? voices.find(item => item.voiceURI === options.voiceId)
      : voices.find(item => item.lang.startsWith("zh")) ?? voices.find(item => item.default) ?? voices[0];
    if (!voice) return Promise.reject(new Error("没有符合条件的浏览器音色，请等待音色加载或使用文字。"));
    this.cancel();
    const generation = this.generation;
    const utterance = this.makeUtterance(text.trim()); utterance.voice = voice; utterance.lang = voice.lang;
    utterance.rate = rate; utterance.volume = volume;
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
        utterance.onend = null; utterance.onerror = null; utterance.onstart = null; utterance.onboundary = null;
        if (this.generation === generation) this.rejectCurrent = null;
      };
      const complete = (error?: Error) => { if (settled) return; settled = true; cleanup(); if (error) reject(error); else resolve(); };
      const abort = () => this.cancel();
      const timer = setTimeout(() => {
        if (this.generation !== generation) return;
        this.synthesis?.cancel(); complete(new Error("浏览器播报超时；文字操作仍可使用。"));
      }, timeout);
      this.rejectCurrent = () => complete(abortError());
      utterance.onstart = () => { if (!settled && this.generation === generation) options.onStart?.(); };
      utterance.onboundary = event => {
        if (!settled && this.generation === generation && Number.isInteger(event.charIndex) && event.charIndex >= 0 && event.charIndex <= utterance.text.length) {
          const length = Number.isInteger(event.charLength) && event.charLength >= 0 ? Math.min(event.charLength, utterance.text.length - event.charIndex) : 0;
          options.onBoundary?.(event.charIndex, length);
        }
      };
      utterance.onend = () => { if (this.generation === generation) complete(); };
      utterance.onerror = () => { if (this.generation === generation) complete(new Error("浏览器播报失败或被自动播放策略阻止。")); };
      options.signal?.addEventListener("abort", abort, { once: true });
      try { this.synthesis!.speak(utterance); } catch { complete(new Error("浏览器播报不可用。")); }
    });
  };
  dispose = () => { this.setEnabled(false); };
}
export const createBrowserTtsAdapter = (options?: ConstructorParameters<typeof BrowserTtsAdapter>[0]) => new BrowserTtsAdapter(options);
