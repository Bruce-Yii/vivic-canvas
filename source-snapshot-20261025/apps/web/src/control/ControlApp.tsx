import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { fetchWeatherHere, intentStageLabel } from "@/ai/api";
import { runDecisionTask, cancelDecisionTask } from "@/ai/decisionTask";
import { cancelWakeActivity, getWakeActivity, isWakeInputBusy, subscribeWakeActivity } from "@/ai/wakeActivity";
import { fixForRequest, freshFix, looksLikeWeather, subscribeLocation } from "@/location/deviceLocation";
import { requestStartupPermissions } from "@/permissions/devicePermissions";
import { startLiveWeather } from "@/location/liveWeather";
import { LocationSettings } from "./LocationSettings";
import { cancelSpeech, speakText, subscribeSpeech, getSpeechSnapshot, speakShortFeedback, cancelShortFeedback } from "@/ai/speech";
import { speechDisplayFrame, type SpeechRange } from "@/ai/speechTelemetry";
import { LocalDecisionSettings } from "./LocalDecisionSettings";
import { MobileControlSettings } from "./mobile/MobileControlSettings";
import { OnlineMobileControlSettings } from "./mobile/OnlineMobileControlSettings";
import { clarifiedCardAction, parseCommand, type CommandResult } from "@/commands/parse";
import { choiceNumber } from "@/commands/choice";
import { completedCountdown } from "@/canvas/reminderPresentation";
import type { ResolvedCard } from "@/commands/references";
import { applyUrlTheme } from "@/lib/urlTheme";
import { newId } from "@/lib/id";
import { canvasStore, useDisplayPreferences } from "@/state/canvasStore";
import { getControlHost } from "@/sync/browserRuntime";
import type { ControlHost } from "@/sync/controlHost";
import { AiSection } from "./AiSection";
import type { ClarifyState } from "./ChatComposer";
import { ChatPage } from "./ChatPage";
import { BackgroundSettings } from "./BackgroundSettings";
import { DataActions } from "./DataActions";
import type { ReminderNotice } from "@/reminders/reminders";
import { deliveredNoticeCurrent } from "@/reminders/reminders";
import { cancelVoiceInput, getVoiceInputSnapshot, isVoiceInputBusy, subscribeVoiceInput } from "@/ai/voiceInput";
import { LocalSpeechSettings } from "./LocalSpeechSettings";
import { CanvasSettings } from "./CanvasSettings";
import { NotificationSettings } from "./NotificationSettings";
import { SettingsExperience } from "./SettingsExperience";
import type { Attachment } from "@/ai/attachments";
import { startsNewInstruction } from "@vivic/contracts";
import { focusResponseActions } from "@/commands/responseFocus";
import { armReminderSound } from "@/reminders/sound";
import { useSystemReducedMotion } from "@/motion/useMotionVisibility";
import { HarkCanvasBackdrop as AtmosphereBackground } from "@/components/hark/HarkCanvasBackdrop";
import { paletteFor } from "@/components/atmosphere/palettes";
import { useResolvedTheme } from "@/stage/useResolvedTheme";
import { pathForView, viewForPath, type ControlView } from "./controlView";
import "@/components/hark/hark.css";
import "./hark-control.css";
import { ONLINE_BUILD } from "@/online/mode";

export const INTENT_TIMEOUT_MS = 100_000;

/** A non-action result must still reach Display after the thinking lease ends, and is spoken. */
const publishFeedback = (host: ControlHost, text: string) => {
  const { activeCanvasId, ownerMode } = host.getSnapshot();
  if (!activeCanvasId || ownerMode !== "owner") return;
  host.dispatch({ schemaVersion: "0.6", requestId: newId("feedback"), canvasId: activeCanvasId,
    actions: [{ type: "subtitle.show", text: text.slice(0, 120), durationMs: 12000 }] });
};

declare global {
  interface Window {
    __vivicControl?: {
      snapshot: () => unknown;
      switchCanvas: (id: string) => void;
      createCanvas: (title?: string) => string;
      undo: () => boolean;
      takeover: () => void;
    };
  }
}

export const ControlApp = () => {
  const [host, setHost] = useState<ControlHost | null>(null);
  const [clarify, setClarify] = useState<ClarifyState | null>(null);
  const [feedback, setFeedbackState] = useState<string | null>(null);
  // The ref mirrors feedback synchronously for updaters that read the previous line.
  const feedbackRef = useRef<string | null>(null);
  const setFeedback = useCallback((next: string | null | ((prev: string | null) => string | null)) => {
    const value = typeof next === "function" ? next(feedbackRef.current) : next;
    feedbackRef.current = value;
    setFeedbackState(value);
  }, []);
  const [view, setView] = useState<ControlView>(() => viewForPath(window.location.pathname));
  useEffect(() => {
    const sync = () => setView(viewForPath(window.location.pathname));
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  const navigate = useCallback((next: ControlView) => {
    const path = pathForView(next);
    if (window.location.pathname !== path) window.history.pushState(null, "", `${path}${window.location.search}`);
    setView(next);
  }, []);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [backendOnline, setBackendOnline] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!host || busy || event.isComposing || !(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (event.target instanceof Element && event.target.closest("input,textarea,[contenteditable=true]")) return;
      const key = event.key.toLowerCase(), redo = key === "y" || key === "z" && event.shiftKey;
      if (key !== "z" && key !== "y") return;
      if (host.getSnapshot().ownerMode !== "owner") return;
      event.preventDefault();
      const applied = redo ? host.redo() : host.undo();
      setFeedback(applied ? `已${redo ? "重做" : "撤销"}上一步操作` : "没有可恢复的操作，或目标内容已变化。");
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [host, busy, setFeedback]);
  const submitAnswer = useRef<((text: string) => void) | null>(null);
  const pending = useRef<{
    requestId: string;
    canvasId: string;
    controller: AbortController;
    slowTimer: ReturnType<typeof setTimeout>;
    deadlineTimer: ReturnType<typeof setTimeout>;
    feedbackTimer: ReturnType<typeof setTimeout>;
    expiresAt: number;
    text: string;
  } | null>(null);
  const reminderQueue = useRef<ReminderNotice[]>([]);
  useEffect(() => {
    const unlock = () => { if (host?.getSnapshot().ownerMode === "owner") armReminderSound(); };
    window.addEventListener("pointerdown", unlock); window.addEventListener("keydown", unlock);
    return () => { window.removeEventListener("pointerdown", unlock); window.removeEventListener("keydown", unlock); };
  }, [host]);
  // "Where I am" weather cards follow the device while this owner page is open.
  useEffect(() => {
    if (!host) return;
    return startLiveWeather({
      cards: () => host.getSnapshot().ownerMode === "owner"
        ? canvasStore.getState().cards.filter(entry => !entry.exitingRequestId).map(entry => entry.record) : [],
      fix: freshFix, subscribeFix: subscribeLocation, fetchHere: fix => fetchWeatherHere(fix),
      refresh: (cardId, fields) => host.refreshWeatherCard(cardId, fields),
    });
  }, [host]);
  const announcing = useRef(false);
  const previousQuestion = useRef<{ canvasId: string; utterance: string; question: string; at: number; taskId?: string } | null>(null);

  const cancelPending = useCallback(() => {
    cancelVoiceInput();
    cancelWakeActivity();
    cancelSpeech();
    setSuggestions([]);
    const current = pending.current;
    if (!current) return;
    pending.current = null;
    current.controller.abort();
    clearTimeout(current.slowTimer);
    clearTimeout(current.deadlineTimer);
    clearTimeout(current.feedbackTimer);
    host?.setActivity(current.requestId, null);
    setBusy(false);
    setFeedback("已取消本次请求");
  }, [host, setFeedback]);

  useEffect(() => {
    const cancelVoiceActivity = () => { cancelVoiceInput(); cancelWakeActivity(); cancelSpeech(); };
    window.addEventListener("vivic:provider-change", cancelPending);
    window.addEventListener("vivic:voice-config-change", cancelVoiceActivity);
    return () => { window.removeEventListener("vivic:provider-change", cancelPending); window.removeEventListener("vivic:voice-config-change", cancelVoiceActivity); };
  }, [cancelPending]);

  // Speech state follows actual audio loading/playback, rather than a guessed
  // fixed subtitle duration. The short lease also expires if control disappears.
  useEffect(() => {
    if (!host) return;
    let voiceActivityId: string | null = null;
    let lastSpeechRange: SpeechRange | null = null;
    const update = () => {
      const speech = getSpeechSnapshot();
      if (isVoiceInputBusy() || isWakeInputBusy() || host.getSnapshot().ownerMode !== "owner") return;
      const live = speech.status === "loading" || speech.status === "playing";
      if (pending.current && (!live || speech.kind !== "phrase" || speech.status === "loading")) {
        if (voiceActivityId) {
          host.setActivity(voiceActivityId, null); voiceActivityId = null;
          const current = pending.current;
          host.setActivity(current.requestId, { requestId: current.requestId, text: current.text, phase: "thinking", expiresAt: current.expiresAt });
        }
        return;
      }
      if (live && speech.requestId) {
        const requestId = `voice_${speech.requestId}`.slice(0, 128);
        if (voiceActivityId !== requestId) lastSpeechRange = null;
        voiceActivityId = requestId;
        const frame = speechDisplayFrame(speech.text || "正在说话…", speech.wordRange, lastSpeechRange);
        if (speech.wordRange) lastSpeechRange = speech.wordRange;
        host.setActivity(requestId, { requestId,
          text: speech.status === "loading" ? "正在准备语音…" : frame.text,
          phase: speech.status === "loading" ? "preparing-speech" : "speaking",
          ...(speech.status === "playing" ? { speech: { amplitude: speech.amplitude,
            ...(frame.wordStart !== undefined ? { wordStart: frame.wordStart, wordEnd: frame.wordEnd } : {}) } } : {}),
          expiresAt: Date.now() + 6000,
        });
      } else if (voiceActivityId) {
        host.setActivity(voiceActivityId, null);
        voiceActivityId = null;
      }
    };
    const unsubscribe = subscribeSpeech(update);
    const timer = setInterval(update, 2000);
    return () => { unsubscribe(); clearInterval(timer); if (voiceActivityId) host.setActivity(voiceActivityId, null); };
  }, [host]);

  useEffect(() => {
    if (!host) return;
    let requestId: string | null = null;
    let wakeWasDetected = false;
    const update = () => {
      const voice = getVoiceInputSnapshot();
      const wake = getWakeActivity();
      if (host.getSnapshot().ownerMode !== "owner") return;
      if (wake.detected && !wakeWasDetected) {
        const canvasId = host.getSnapshot().activeCanvasId;
        if (canvasId) host.dispatch({ schemaVersion: "0.6", requestId: newId("wake"), canvasId, actions: [{ type: "stage.awaken" }] });
      }
      wakeWasDetected = wake.detected;
      if (isVoiceInputBusy() || isWakeInputBusy()) {
        requestId ??= newId("microphone");
        const transcribing = voice.status === "transcribing" || wake.phase === "transcribing" || wake.phase === "delivering";
        host.setActivity(requestId, { requestId,
          phase: transcribing ? "transcribing" : "listening",
          text: transcribing ? "正在识别语音…" : voice.status === "requesting" ? "等待麦克风授权…" : wake.phase === "loading" ? "正在准备唤醒…" : wake.phase === "listening" && !wake.detected ? "等待你说 Vivic…" : "在听，请说…",
          expiresAt: Date.now() + 6000,
        });
      } else if (requestId) { host.setActivity(requestId, null); requestId = null; }
    };
    const unsubscribe = subscribeVoiceInput(update);
    const unsubscribeWake = subscribeWakeActivity(update);
    const timer = setInterval(update, 2000);
    return () => { unsubscribe(); unsubscribeWake(); clearInterval(timer); if (requestId) host.setActivity(requestId, null); };
  }, [host]);

  useEffect(() => {
    if (!host) return;
    const seen = new Set(host.getSnapshot().reminderNotices.map(n => n.id));
    let cancelled = false;
    const drain = async () => {
      if (announcing.current || pending.current || isVoiceInputBusy() || isWakeInputBusy() || getSpeechSnapshot().status === "playing" || getSpeechSnapshot().status === "loading") return;
      announcing.current = true;
      try {
        while (!cancelled && reminderQueue.current.length && !pending.current && !isVoiceInputBusy() && !isWakeInputBusy() && host.getSnapshot().ownerMode === "owner" &&
          getSpeechSnapshot().status !== "playing" && getSpeechSnapshot().status !== "loading") {
          const notice = reminderQueue.current.shift()!;
          // If the timer was removed/rescheduled after firing, don't read a
          // now-obsolete queued announcement when another sound finishes.
          const current = host.getSnapshot().reminders.find(r => r.canvasId === notice.canvasId && r.card.id === notice.cardId);
          if (!current || !deliveredNoticeCurrent(notice, current.card)) continue;
          await speakText(`提醒：${notice.text}`.slice(0, 200), { requestId: notice.id });
        }
      } finally { announcing.current = false; }
    };
    const collect = () => {
      for (const notice of host.getSnapshot().reminderNotices) {
        if (seen.has(notice.id)) continue;
        const timer = host.getSnapshot().reminders.find(r => r.canvasId === notice.canvasId && r.card.id === notice.cardId);
        if (!timer || !deliveredNoticeCurrent(notice, timer.card)) continue;
        seen.add(notice.id);
        reminderQueue.current.push(notice);
      }
      if (host.getSnapshot().ownerMode !== "owner") reminderQueue.current = [];
      void drain();
    };
    const unsubscribe = host.subscribe(collect);
    const timer = setInterval(() => void drain(), 500);
    return () => { cancelled = true; unsubscribe(); clearInterval(timer); reminderQueue.current = []; };
  }, [host]);

  useEffect(() => {
    if (!host) return;
    let lastCanvasId = host.getSnapshot().activeCanvasId;
    const unsubscribe = host.subscribe(() => {
      const current = pending.current;
      const snap = host.getSnapshot();
      if (snap.activeCanvasId !== lastCanvasId || snap.ownerMode !== "owner") { cancelSpeech(); cancelVoiceInput(); cancelWakeActivity(); setClarify(null); setSuggestions([]); previousQuestion.current = null; }
      lastCanvasId = snap.activeCanvasId;
      if (current && (snap.activeCanvasId !== current.canvasId || snap.ownerMode !== "owner")) {
        cancelPending();
      }
    });
    return () => {
      unsubscribe();
      cancelPending();
    };
  }, [host, cancelPending]);

  useEffect(() => {
    let cancelled = false;
    applyUrlTheme();
    void getControlHost().then((h) => {
      if (cancelled) return;
      setHost(h);
      if (import.meta.env.DEV) {
        window.__vivic = {
          dispatch: (raw) => h.dispatch(raw),
          internal: (action) =>
            canvasStore.internal(
              action as Parameters<typeof canvasStore.internal>[0],
            ),
          getState: () => canvasStore.getState(),
        };
        window.__vivicControl = {
          snapshot: () => h.getSnapshot(),
          switchCanvas: (id) => h.switchCanvas(id),
          createCanvas: (title) => h.createCanvas(title),
          undo: () => h.undo(),
          takeover: () => h.takeover(),
        };
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const applyResult = useCallback(
    (h: ControlHost, result: CommandResult) => {
      const { activeCanvasId } = h.getSnapshot();
      setClarify(null); h.setTargetChoice(null); setSuggestions([]);
      if (result.kind === "unknown") {
        setFeedback(result.message);
        publishFeedback(h, result.message);
        return;
      }
      if (result.kind === "undo") {
        const label = h.getSnapshot().history?.undoLabel;
        const text = h.undo() ? `已撤销${label ?? "上一步操作"}` : "没有可撤销的操作，或目标内容已变化。";
        setFeedback(text);
        void speakText(text, { requestId: newId("speech") });
        return;
      }
      if (result.kind === "redo") {
        const text = h.redo() ? "已重做上一步操作" : "没有可重做的操作，或目标内容已变化。";
        setFeedback(text); publishFeedback(h, text); return;
      }
      if (result.kind === "clarify") {
        const choiceId = newId("choice"), expiresAt = Date.now() + 120_000;
        const prompt = `${result.prompt} 请回复几号，也可以点击选择。`;
        setClarify({ ...result, prompt, choiceId, expiresAt, canvasId: activeCanvasId ?? undefined });
        h.setTargetChoice({ id: choiceId, targets: result.candidates.map(c => c.card.id), expiresAt });
        setFeedback(prompt); publishFeedback(h, prompt);
        void speakText(prompt, { requestId: newId("speech") });
        return;
      }
      const res = h.dispatch({
        schemaVersion: "0.6",
        requestId: newId("cmd"),
        canvasId: activeCanvasId ?? "",
        spokenText: result.spokenText,
        actions: focusResponseActions(result.actions, canvasStore.getState()),
      });
      const message = res.ok ? result.spokenText ?? result.description : `指令未执行（${res.error}）`;
      setFeedback(message);
      if (!res.ok) publishFeedback(h, message);
      if (res.ok && result.spokenText) void speakText(result.spokenText, { requestId: newId("speech") });
    },
    [setFeedback],
  );

  const pickClarify = useCallback(
    (candidate: ResolvedCard) => {
      if (!host || !clarify) return;
      if (clarify.taskId) {
        const index = clarify.candidates.findIndex(item => item.card.id === candidate.card.id);
        if (index >= 0) submitAnswer.current?.(`${clarify.numbers?.[index] ?? index + 1}号`);
        return;
      }
      host.setTargetChoice(null);
      const { activeCanvasId, ownerMode } = host.getSnapshot();
      if (!activeCanvasId || ownerMode !== "owner" || !clarify.candidates.some(item => item.card.id === candidate.card.id)) return;
      if ((clarify.expiresAt && Date.now() >= clarify.expiresAt) || (clarify.canvasId && clarify.canvasId !== activeCanvasId)) { setClarify(null); setFeedback("画布已变更，请重新指定卡片。"); return; }
      const current = canvasStore.getState().cards.find(item => item.record.id === candidate.card.id && !item.exitingRequestId && !completedCountdown(item))?.record;
      const action = current ? clarifiedCardAction(clarify.action, current) : null;
      if (!action) { setClarify(null); setFeedback("目标已变更，请重新指定卡片。"); return; }
      const verb = { delete: "删除", focus: "聚焦", highlight: "高亮", expand: "展开", collapse: "收起" }[clarify.action];
      const message = `已${verb}${candidate.label}`;
      const res = host.dispatch({
        schemaVersion: "0.6",
        requestId: newId("cmd"),
        canvasId: activeCanvasId ?? "",
        spokenText: message,
        actions: action.type === "card.update" && action.variant !== undefined ? [action, { type: "canvas.fit" }] : [action],
      });
      setClarify(null);
      setFeedback(res.ok ? `${message}${clarify.action === "delete" ? "，可撤销" : ""}` : res.error);
      if (res.ok) void speakText(message, { requestId: newId("speech") });
    },
    [host, clarify, setFeedback],
  );

  useEffect(() => {
    if (!host || !clarify) return;
    const check = () => {
      const snapshot = host.getSnapshot();
      const cards = canvasStore.getState().cards;
      if (snapshot.ownerMode !== "owner" || snapshot.activeCanvasId !== clarify.canvasId
        || Date.now() >= (clarify.expiresAt ?? Infinity)
        || clarify.candidates.some(c => !cards.some(entry => entry.record.id === c.card.id && !entry.exitingRequestId && !completedCountdown(entry)))) {
        setClarify(null); host.setTargetChoice(null); setFeedback("选择已失效，请重新指定目标。");
      }
    };
    const unsubscribe = host.subscribe(check), timer = setInterval(check, 1000);
    check(); return () => { unsubscribe(); clearInterval(timer); };
  }, [host, clarify, setFeedback]);

  const submitCommand = useCallback(
    (text: string, attachments?: Attachment[]) => {
      if (!host) return;
      const snap = host.getSnapshot();
      if (!snap.activeCanvasId || snap.ownerMode !== "owner") return;
      armReminderSound();
      const trimmed = text.trim();
      // A request still running is cancelled before this one starts; the page keeps no history.
      if (pending.current) cancelPending();
      setFeedback(null);
      if (clarify && !clarify.taskId && !attachments?.length) {
        const number = choiceNumber(trimmed);
        if (number !== null) {
          const candidate = clarify.candidates[number - 1];
          if (!candidate) { setFeedback(`请选 1 到 ${clarify.candidates.length} 号。`); return; }
          pickClarify(candidate); return;
        }
        if (/^(?:取消|算了|不删了|不用了)$/.test(trimmed)) {
          setClarify(null); host.setTargetChoice(null); setFeedback("已取消选择"); return;
        }
      }
      cancelPending();
      setClarify(null); host.setTargetChoice(null); setSuggestions([]);
      const activeCanvasId = snap.activeCanvasId;
      const previous = previousQuestion.current;
      const continuation = previous && previous.canvasId === activeCanvasId && Date.now() - previous.at < 120_000 && trimmed.length <= 80
        && !attachments?.length && !startsNewInstruction(trimmed, previous.utterance)
        ? { utterance: previous.utterance, question: previous.question } : undefined;
      previousQuestion.current = null;
      const runLocal = () =>
        applyResult(
          host,
          parseCommand(trimmed, {
            state: canvasStore.getState(),
            canvasId: activeCanvasId,
          }),
        );
      const requestId = newId("intent");
      const controller = new AbortController();
      const expiresAt = Date.now() + INTENT_TIMEOUT_MS;
      const isCurrent = () => !controller.signal.aborted && pending.current?.requestId === requestId &&
        host.getSnapshot().activeCanvasId === activeCanvasId &&
        host.getSnapshot().ownerMode === "owner";
      pending.current = {
        requestId,
        canvasId: activeCanvasId,
        controller,
        deadlineTimer: setTimeout(() => controller.abort(new DOMException("请求超时", "TimeoutError")), INTENT_TIMEOUT_MS),
        feedbackTimer: setTimeout(() => {
          if (isCurrent()) void speakShortFeedback("我看看", { requestId: `${requestId}:checking`, signal: controller.signal });
        }, 300),
        slowTimer: setTimeout(() => {
          if (!isCurrent()) return;
          const text = "响应较慢，仍在处理…";
          pending.current!.text = text;
          setFeedback(text);
          host.setActivity(requestId, { requestId, text, expiresAt, phase: "thinking" });
          void speakShortFeedback("稍等", { requestId: `${requestId}:slow`, signal: controller.signal });
        }, 5000),
        expiresAt, text: "让我想想…",
      };
      setBusy(true);
      setFeedback("正在理解你的指令…");
      host.setActivity(requestId, { requestId, text: "让我想想…", expiresAt, phase: "thinking" });
      // Every language entry reaches the configured decision service first.
      // Deterministic clicks remain direct owner actions; offline fallback is explicit.
      void (async () => {
        try {
          // Weather and "where am I" wording carries the rounded live fix; the first ask shows
          // the browser's location prompt. A follow-up answer inherits the original question's wording.
          const deviceLocation = !attachments?.length && looksLikeWeather(continuation ? `${continuation.utterance} ${trimmed}` : trimmed)
            ? await fixForRequest() : null;
          if (!isCurrent()) return;
          const result = await runDecisionTask({
            host, text: trimmed, signal: controller.signal, isCurrent,
            taskId: continuation ? previous?.taskId : undefined,
            attachments, continuation, deviceLocation,
            onProgress: event => {
              if (!isCurrent() || event.status !== "started" || event.stage === "total") return;
              const text = intentStageLabel(event.stage);
              pending.current!.text = text;
              setFeedback(text);
              host.setActivity(requestId, { requestId, text, expiresAt, phase: "thinking" });
            },
          });
          if (!isCurrent()) {
            if (pending.current?.requestId === requestId && controller.signal.aborted) setFeedback(result.executed ? "后续处理已停止，请检查已有卡片。" : controller.signal.reason?.name === "TimeoutError" ? "本次请求超时，请重试。" : "已取消本次请求");
            return;
          }
          cancelShortFeedback(requestId);
          setBackendOnline(true);
          // In explicit legacy fallback, retain the old exact target chooser.
          // Only its clarification UI is reused; never bypass a rejected task by executing its envelope.
          if (!result.executed && !attachments?.length && result.task?.decision === "legacy-fallback" && ["unknown", "clarify", "error"].includes(result.kind)) {
            const choice = parseCommand(trimmed, { state: canvasStore.getState(), canvasId: activeCanvasId });
            if (choice.kind === "clarify") { void cancelDecisionTask(host, result.task.id); applyResult(host, choice); return; }
          }
          if (result.task || result.executed || result.handled) {
            const message = result.message ?? (result.task?.status === "completed" ? "已完成并保存。" : "操作未完成，请重试。");
            setFeedback(message); publishFeedback(host, message); setSuggestions(result.suggestions ?? []);
            if (result.kind === "clarify" && result.task?.status === "awaiting_clarification") previousQuestion.current = {
              canvasId: activeCanvasId, utterance: continuation?.utterance ?? trimmed,
              question: message.slice(0, 180), at: Date.now(), taskId: result.task.id,
            };
            if (result.task?.status === "awaiting_clarification" && result.task.clarification?.candidates.length) {
              const choices = result.task.clarification.candidates.flatMap(choice => {
                const card = canvasStore.getState().cards.find(entry => !entry.exitingRequestId && entry.record.id === choice.id)?.record;
                return card ? [{ card, label: choice.label, number: choice.number }] : [];
              });
              if (choices.length === result.task.clarification.candidates.length) {
                const expiresAt = Date.now() + 120000, choiceId = newId("choice");
                setClarify({ action: "focus", canvasId: activeCanvasId, taskId: result.task.id, candidates: choices, numbers: choices.map(choice => choice.number), prompt: message, choiceId, expiresAt });
                host.setTargetChoice({ id: choiceId, targets: choices.map(choice => choice.card.id), expiresAt });
              }
            }
            if (result.task?.status === "completed") void speakText(message, { requestId });
          } else if (result.kind === "envelope" && result.envelope) {
            const res = host.dispatch({ ...result.envelope, actions: focusResponseActions(result.envelope.actions, canvasStore.getState()) });
            const message = res.ok ? result.envelope.spokenText ?? "已执行" : `指令未执行（${res.error}）`;
            setFeedback(message);
            if (!res.ok) publishFeedback(host, message);
            if (res.ok && !res.deduplicated && result.envelope.spokenText) {
              void speakText(result.envelope.spokenText, { requestId: result.envelope.requestId });
            }
          } else {
            // No envelope (rules miss / model offline / planner failed):
            // the in-browser parser knows the local references better — try
            // it before surfacing the server's honest "can't do that" line.
            const local = attachments?.length ? { kind: "unknown" as const, message: result.message ?? "图片分析未完成。" } : parseCommand(trimmed, {
              state: canvasStore.getState(),
              canvasId: activeCanvasId,
            });
            if (result.kind === "locale" && result.locale) {
              // A place answer, not a card: shown and spoken like other feedback.
              const answer = result.locale.answer;
              setFeedback(answer);
              publishFeedback(host, answer);
              void speakText(answer, { requestId: newId("speech") });
              setSuggestions([]);
            } else if (local.kind !== "unknown") {
              applyResult(host, local);
            } else {
              const message = result.message ?? local.message;
              setFeedback(message);
              publishFeedback(host, message);
              setSuggestions(result.suggestions ?? []);
              if (result.kind === "clarify" && result.message) previousQuestion.current = {
                canvasId: activeCanvasId, utterance: continuation?.utterance ?? trimmed,
                question: result.message.slice(0, 180), at: Date.now(),
              };
            }
          }
        } catch (error) {
          if (!isCurrent()) return;
          cancelShortFeedback(requestId);
          if (controller.signal.aborted) {
            setFeedback(controller.signal.reason?.name === "TimeoutError" ? "本次请求超时，请重试。" : "已取消本次请求");
            return;
          }
          if (error instanceof DOMException && error.name === "TimeoutError") {
            setFeedback("本次请求超时，请重试。");
            publishFeedback(host, "本次请求超时，请重试。");
            return;
          }
          setBackendOnline(false);
          if (attachments?.length) { setFeedback("图片分析服务暂不可达，未执行任何动作；文字输入仍可使用。"); return; }
          runLocal();
          setFeedback((prev) => (prev ? `离线本地模式 · ${prev}` : prev));
        } finally {
          if (pending.current?.requestId === requestId) {
            cancelShortFeedback(requestId);
            clearTimeout(pending.current.slowTimer);
            clearTimeout(pending.current.deadlineTimer);
            clearTimeout(pending.current.feedbackTimer);
            pending.current = null;
            host.setActivity(requestId, null);
            setBusy(false);
          }
        }
      })();
    },
    [host, applyResult, cancelPending, clarify, pickClarify, setFeedback],
  );

  const dismissClarify = useCallback(() => {
    if (!host) return;
    if (clarify?.taskId) { void cancelDecisionTask(host, clarify.taskId); previousQuestion.current = null; }
    setClarify(null); host.setTargetChoice(null); setFeedback("已取消选择");
  }, [host, clarify, setFeedback]);
  useEffect(() => { submitAnswer.current = submitCommand; }, [submitCommand]);

  if (!host) {
    return (
      <div className="vh-hark vivic-control-loading" role="status">
        正在载入本地画布…
      </div>
    );
  }

  return (
    <ControlShell
      host={host}
      desktopBusy={() => Boolean(pending.current)}
      view={view}
      onNavigate={navigate}
      clarify={clarify}
      feedback={feedback}
      suggestions={suggestions}
      onSubmit={submitCommand}
      onPickClarify={pickClarify}
      onCancelClarify={dismissClarify}
      backendOnline={backendOnline}
      onBackendChange={setBackendOnline}
      busy={busy}
      onCancel={cancelPending}
    />
  );
};

interface ShellProps {
  host: ControlHost;
  desktopBusy(): boolean;
  view: ControlView;
  onNavigate: (view: ControlView) => void;
  clarify: ClarifyState | null;
  feedback: string | null;
  suggestions: string[];
  backendOnline: boolean | null;
  onSubmit: (text: string, attachments?: Attachment[]) => void;
  onPickClarify: (candidate: ResolvedCard) => void;
  onCancelClarify: () => void;
  onBackendChange: (online: boolean) => void;
  busy: boolean;
  onCancel: () => void;
}

/**
 * One owner window, two pages that stay mounted (drafts, voice and in-flight
 * requests survive the switch) over the shared 流光以太 background.
 */
const ControlShell = (props: ShellProps) => {
  const snap = useSyncExternalStore(props.host.subscribe, props.host.getSnapshot);
  const readonly = snap.ownerMode !== "owner";
  const theme = useResolvedTheme();
  const preferences = useDisplayPreferences();
  const reduced = useSystemReducedMotion() || preferences.reducedMotion;

  useEffect(() => {
    if (ONLINE_BUILD) return;
    if (readonly || !snap.ready) return;
    requestStartupPermissions();
    document.addEventListener("visibilitychange", requestStartupPermissions);
    return () => document.removeEventListener("visibilitychange", requestStartupPermissions);
  }, [readonly, snap.ready]);

  const openDisplay = () => {
    const id = snap.activeCanvasId ?? "";
    const width = window.screen.availWidth || window.innerWidth;
    const height = window.screen.availHeight || window.innerHeight;
    window.open(`/display?canvasId=${encodeURIComponent(id)}`, "_blank", `popup,noopener,width=${width},height=${height}`);
  };
  const readonlyNotice = readonly && (
    <div className="vivic-readonly-notice" data-vivic-readonly-notice>
      <span>另一个控制窗口正在写入，本窗口为只读。</span>
      <button
        type="button"
        className="vivic-chip"
        onClick={() => props.host.takeover()}
        data-vivic-takeover
      >
        接管控制权
      </button>
    </div>
  );

  return (
    <div
      className="vivic-control-root vh-hark"
      data-vivic-control="ready"
      data-vivic-owner={snap.ownerMode}
      data-vivic-active-canvas={snap.activeCanvasId ?? ""}
      data-vivic-view={props.view}
      data-appearance={theme}
      data-reduced-motion={reduced || undefined}
      data-space-motion={preferences.ambientMotion ?? "subtle"}
    >
      <AtmosphereBackground theme={theme} palette={paletteFor(theme, preferences)} paused={reduced} motionMode={preferences.ambientMotion} intensity={preferences.ambientIntensity} className="fixed inset-0" />

      <ChatPage
        hidden={false}
        host={props.host}
        theme={theme}
        feedback={props.feedback}
        notice={props.view === "chat" ? readonlyNotice : null}
        onOpenSettings={() => props.onNavigate("settings")}
        onOpenDisplay={openDisplay}
        ownerKey={`${snap.activeCanvasId}:${snap.ownerMode}`}
        disabled={readonly || !snap.ready}
        clarify={props.clarify}
        suggestions={props.suggestions}
        backendOnline={props.backendOnline}
        onSubmit={props.onSubmit}
        onPickClarify={props.onPickClarify}
        onPreviewClarify={candidate => {
          const current = props.host.getSnapshot();
          if (current.ownerMode === "owner" && current.activeCanvasId === props.clarify?.canvasId) {
            props.host.dispatch({ schemaVersion: "0.6", requestId: newId("preview"), canvasId: current.activeCanvasId,
              actions: [{ type: "card.highlight", targetId: candidate.card.id, durationMs: 5000 }] });
          }
        }}
        onCancelClarify={props.onCancelClarify}
        busy={props.busy}
        onCancel={props.onCancel}
      />

      <AiSection disabled={readonly || !snap.ready} onBackendChange={props.onBackendChange} renderPanels={(connection, voice) => <SettingsExperience
        hidden={props.view !== "settings"}
        onBack={() => props.onNavigate("chat")}
        notice={props.view === "settings" ? readonlyNotice : null}
        local={<>
          {!ONLINE_BUILD && <><LocalDecisionSettings disabled={readonly || !snap.ready} />
          <LocalSpeechSettings disabled={readonly || !snap.ready} onBeforeClear={props.onCancel} /></>}
        </>}
        connections={connection}
        voice={voice}
        appearance={<>
          <CanvasSettings host={props.host} disabled={readonly || !snap.ready} compact />
          <BackgroundSettings host={props.host} disabled={readonly || !snap.ready} resolvedTheme={theme} compact />
        </>}
        notifications={<NotificationSettings disabled={readonly || !snap.ready} compact />}
        mobile={ONLINE_BUILD
          ? <OnlineMobileControlSettings host={props.host} disabled={readonly || !snap.ready} desktopBusy={props.desktopBusy} />
          : <MobileControlSettings host={props.host} disabled={readonly || !snap.ready} desktopBusy={props.desktopBusy} />}
        permissions={<LocationSettings disabled={readonly} compact />}
        data={<DataActions host={props.host} readonly={readonly || !snap.ready} onBeforeClear={props.onCancel} compact />}
      />} />
    </div>
  );
};
