import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle, Mic } from "lucide-react";
import { createLocalSpeechSession, DEFAULT_WAKE_KEYWORDS, DEFAULT_WAKE_PHRASE, MicCapture, localSpeechModels } from "@/ai/localSpeech";
import type { LocalSpeechEvent, LocalSpeechSession } from "@/ai/localSpeech";
import { beginWakeActivity } from "@/ai/wakeActivity";
import { OWNER_ONLINE_BUILD } from "@/online/mode";
import { OnlineWakeInput } from "./OnlineWakeInput";

type Segment = Extract<LocalSpeechEvent, { type: "segment" }>;
export interface LocalWakeInputProps {
  disabled?: boolean;
  ownerKey: string;
  recognition: "local" | "segment";
  mode?: "wake" | "vad";
  onTranscript: (text: string) => void;
  onSegment?: (segment: Segment) => void | Promise<void>;
  /** Parent cancels any TTS/PTT here; no recording is started by mounting this component. */
  onBegin?: () => void;
  /** Increment on provider change, external cancellation, or a PTT start in the same window. */
  cancelKey?: string | number;
  /** Stop/prevent listening while TTS is playing or preparing to play. */
  speaking?: boolean;
  /** Chat composer footer: a small chip, with the caption only once listening has started. */
  compact?: boolean;
}
type Phase = "idle" | "loading" | "listening" | "recording" | "transcribing" | "delivering" | "done" | "error";
interface Active { controller: AbortController; session: LocalSpeechSession; mic: MicCapture; accepting: boolean }

/** Explicit foreground one-utterance opt-in; never a background/always-on listener. */
export const LocalWakeInput = (props: LocalWakeInputProps) => OWNER_ONLINE_BUILD ? <OnlineWakeInput {...props} /> : <BrowserWakeInput {...props} />;
const BrowserWakeInput = (props: LocalWakeInputProps) => {
  const currentProps = useRef(props); currentProps.current = props;
  const active = useRef<Active | null>(null);
  const activity = useRef<ReturnType<typeof beginWakeActivity> | null>(null);
  const mounted = useRef(true);
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [armed, setArmed] = useState(true);
  const [kick, setKick] = useState(0);
  const hold = useRef(false);
  const stop = useCallback((next: Phase = "idle", note: string | null = null) => {
    const old = active.current; active.current = null;
    old?.controller.abort(); old?.mic.dispose(); old?.session.dispose();
    activity.current?.end(); activity.current = null;
    if (mounted.current) { setPhase(next); setMessage(note); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; stop(); };
  }, [stop]);
  useEffect(() => { stop(); }, [props.ownerKey, props.recognition, props.mode, props.cancelKey, stop]);
  useEffect(() => {
    const pause = () => { hold.current = true; stop(); };
    const resume = () => { if (document.hidden) return; hold.current = false; setKick(value => value + 1); };
    const hidden = () => { if (document.hidden) pause(); else resume(); };
    window.addEventListener("blur", pause); window.addEventListener("focus", resume); window.addEventListener("pagehide", pause); document.addEventListener("visibilitychange", hidden);
    return () => { window.removeEventListener("blur", pause); window.removeEventListener("focus", resume); window.removeEventListener("pagehide", pause); document.removeEventListener("visibilitychange", hidden); };
  }, [stop]);
  const begin = () => {
    if (props.disabled || props.speaking) return;
    stop();
    const ownerKey = props.ownerKey, cancelKey = props.cancelKey, mode = props.mode ?? "wake", recognition = props.recognition;
    const controller = new AbortController(), mic = new MicCapture();
    let scope: Active;
    const isCurrent = () => active.current === scope && !controller.signal.aborted && !currentProps.current.disabled && !currentProps.current.speaking &&
      currentProps.current.ownerKey === ownerKey && currentProps.current.cancelKey === cancelKey && currentProps.current.recognition === recognition && (currentProps.current.mode ?? "wake") === mode;
    const fail = (error: unknown) => {
      if (!isCurrent()) return;
      stop("error", error instanceof Error ? error.message : "本地监听失败，请使用 PTT 或文字。");
    };
    const session = createLocalSpeechSession({ mode, recognition, keywords: mode === "wake" ? DEFAULT_WAKE_KEYWORDS : undefined,
      maxListenSeconds: 300, maxSegmentSeconds: 60, signal: controller.signal,
      onEvent: event => {
        if (!isCurrent()) return;
        if (event.type === "status" && event.status !== "stopped") {
          if (event.status === "transcribing") { scope.accepting = false; mic.stop(); }
          setPhase(event.status); activity.current?.phase(event.status);
        } else if (event.type === "wake") { activity.current?.detected(); setMessage("在听，请说。"); }
        else if (event.type === "fallback") fail(new Error(event.message));
        else if (event.type === "transcript") {
          scope.accepting = false; mic.stop();
          try { currentProps.current.onTranscript(event.text); }
          catch { fail(new Error("转写交付失败，请使用文字输入。")); return; }
          if (isCurrent()) stop("done");
        } else if (event.type === "segment") {
          scope.accepting = false; mic.stop();
          if (!currentProps.current.onSegment) { fail(new Error("尚未配置语音识别，请改用本地识别或文字。")); return; }
          setPhase("delivering");
          activity.current?.phase("delivering");
          try {
            const delivery = currentProps.current.onSegment(event);
            if (delivery && typeof delivery.then === "function") {
              void delivery.then(() => { if (isCurrent()) stop("done"); }, fail);
            } else {
              // Keep event.signal alive for a fire-and-forget caller until explicit cancellation.
              setPhase("done");
            }
          } catch (error) { fail(error); }
        }
      },
    });
    scope = { controller, mic, session, accepting: true }; active.current = scope;
    setPhase("loading"); setMessage(null);
    try {
      props.onBegin?.();
      activity.current = beginWakeActivity(() => stop());
      // Only this explicit click prepares KWS/VAD. Online users need no desktop launcher.
      const required = mode === "wake" ? ["vad", "kws-zh-en"] as const : ["vad"] as const;
      const ready = Promise.all(required.map(id => localSpeechModels.prepareModel(id, { signal: controller.signal }))).then(() => {
        controller.signal.throwIfAborted(); return session.start();
      });
      // Called synchronously from click: MicCapture resumes AudioContext before awaiting ready.
      const capture = mic.start({ ready, signal: controller.signal, maxSeconds: 300, onError: fail,
        onPcm: async (samples, rate) => { if (isCurrent() && scope.accepting) await session.acceptPcm(samples, rate); },
      });
      void Promise.all([ready, capture]).catch(fail);
    } catch (error) { fail(error); }
  };
  const beginRef = useRef(begin);
  beginRef.current = begin;
  useEffect(() => {
    if (!armed || hold.current || props.disabled || props.speaking) {
      if (phase !== "idle" && phase !== "error") stop();
      return;
    }
    if (phase === "idle" || phase === "done") beginRef.current();
  }, [armed, kick, phase, props.disabled, props.speaking, stop]);
  const toggle = () => {
    if (armed) { setArmed(false); return; }
    setArmed(true);
    setPhase("idle");
    setKick(value => value + 1);
  };
  const caption = message ?? (phase === "loading" ? "正在准备本地模型与麦克风权限…"
    : phase === "listening" ? (props.mode === "vad" ? "正在前台等待一句话…" : `正在前台等待「${DEFAULT_WAKE_PHRASE}」…`)
    : phase === "recording" ? "正在收取一条指令，静音后结束。"
    : phase === "transcribing" ? "已停止麦克风，正在本地识别…"
    : phase === "delivering" ? "已停止麦克风，正在交付语音识别…"
    : phase === "done" ? "本次识别已结束；继续使用需重新开启。"
    : "默认不监听。一次开启最多前台等待 5 分钟，只收一段后停止；失焦即取消。");
  const title = props.mode === "vad" ? "本地语音分段（单次）" : `本地唤醒（单次）· 固定短语：${DEFAULT_WAKE_PHRASE}`;
  const mic = <button type="button" className="vivic-wake-mic" data-on={armed} aria-pressed={armed} data-vivic-local-wake-toggle
    aria-label={armed ? "关闭监听" : "开启监听"} title={armed ? "监听已开启" : "监听已关闭"} onClick={toggle}>
    {phase === "loading" ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Mic aria-hidden="true" />}
  </button>;
  if (props.compact) return <div className="vivic-wake" data-vivic-local-wake data-local-wake-phase={phase} data-listening={armed || undefined}>
    {mic}
    {phase === "error" && <p className="vivic-composer-note vivic-composer-note-error" role="status" aria-live="polite">{message ?? caption}</p>}
  </div>;
  return <div className="mt-3" data-vivic-local-wake data-local-wake-phase={phase}>
    <p className="mb-2 text-xs text-neutral-600">{title}</p>
    {mic}
    <p className={`mt-2 text-xs ${phase === "error" ? "text-red-700" : "text-neutral-500"}`} role="status" aria-live="polite">{armed ? caption : "监听已关闭。"}</p>
  </div>;
};
