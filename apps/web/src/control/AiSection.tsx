import { ONLINE_BUILD } from "@/online/mode";
import { AudioOutputSettings } from "./AudioOutputSettings";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { CompactVoiceSettings } from "./CompactVoiceSettings";
import { Select } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";
import {
  cancelSpeech, getSpeechSnapshot, previewSpeech, setSpeechEnabled, setSpeechPreferences,
  SPEECH_VOICES, SPEECH_VOICES_SOURCE, subscribeSpeech, type SpeechVoiceId,
} from "@/ai/speech";
import {
  disconnectPlatform,
  disconnectStepfun,
  getProvidersStatus,
  validatePlatformKey,
  validateStepfunKey,
  type ProvidersStatusResponse,
} from "@/ai/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Choice } from "./Choice";
import { GptConnection } from "./GptConnection";
import { selectLlmModel, selectLlmProvider, type LlmProvider } from "@/ai/providers";
import { getVoiceConfiguration, setVoiceConfiguration, subscribeVoiceConfiguration, type SttProvider, type TtsProvider } from "@/ai/voiceConfig";
import { createBrowserTtsAdapter } from "@/ai/localSpeech/browserTts";
import { getMicrophonePermission, requestMicrophonePermission, subscribeMicrophonePermission } from "@/permissions/devicePermissions";
import { AvailableCards } from "./AvailableCards";
import stepfunIcon from "./assets/stepfun-icon.svg";

const STEPFUN_SITE = "https://www.stepfun.com/";
const StepFunBrand = ({ label = "StepFun" }: { label?: string }) => (
  <span className="se-stepfun-brand">
    <a className="se-stepfun-link" href={STEPFUN_SITE} target="_blank" rel="noopener noreferrer"
      aria-label="打开 StepFun 官网" title="打开 StepFun 官网" data-vivic-stepfun-site>
      <img src={stepfunIcon} alt="" width={18} height={18} />
    </a>
    <span>{label}</span>
  </span>
);

type BackendState =
  | { status: "checking" }
  | { status: "offline" }
  | { status: "online"; data: ProvidersStatusResponse };

interface AiSectionProps {
  onBackendChange?: (online: boolean) => void;
  disabled?: boolean;
  renderPanels?: (connection: ReactNode, voice: ReactNode) => ReactNode;
}

/** Honest AI connection panel — no fake provider states, no key retention. */
export const AiSection = ({ onBackendChange, disabled = false, renderPanels }: AiSectionProps) => {
  const [backend, setBackend] = useState<BackendState>({ status: "checking" });
  const [keyInput, setKeyInput] = useState("");
  const [platformInput, setPlatformInput] = useState("");
  const [busy, setBusy] = useState<"stepfun" | "platform" | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [platformError, setPlatformError] = useState<string | null>(null);
  const [restartNote, setRestartNote] = useState<string | null>(null);
  const seen = useRef<{ instance?: string; stepfunConnected: boolean }>({ stepfunConnected: false });
  const speech = useSyncExternalStore(subscribeSpeech, getSpeechSnapshot);
  const voiceConfig = useSyncExternalStore(subscribeVoiceConfiguration, getVoiceConfiguration);
  const microphone = useSyncExternalStore(subscribeMicrophonePermission, getMicrophonePermission);
  const [browserVoices, setBrowserVoices] = useState<Array<{ value: string; label: string }>>([]);
  const previewController = useRef<AbortController | null>(null);

  useEffect(() => () => { previewController.current?.abort(); }, []);
  useEffect(() => {
    const adapter = createBrowserTtsAdapter();
    const refreshVoices = () => setBrowserVoices(adapter.voices().filter(voice => voice.localService).map(voice => ({ value: voice.id, label: `${voice.name} · ${voice.lang}` })));
    refreshVoices(); const unsubscribe = adapter.subscribeVoices(refreshVoices);
    return () => { unsubscribe(); adapter.dispose(); };
  }, []);

  const preview = () => {
    if (speech.kind === "preview" && (speech.loading || speech.playing)) {
      cancelSpeech();
      return;
    }
    previewController.current?.abort();
    const controller = new AbortController();
    previewController.current = controller;
    void previewSpeech({ signal: controller.signal });
  };

  const refresh = useCallback(async () => {
    try {
      const data = await getProvidersStatus();
      if (getVoiceConfiguration().tts === "stepfun" && !data.providers.some((provider) => provider.name === "stepfun" && provider.connected)) {
        // Losing the cloud connection must not erase the user's opt-in to
        // bundled feedback. Stop only an in-flight cloud utterance.
        if (getSpeechSnapshot().source === "stepfun") cancelSpeech();
      }
      // The key lives only in backend memory, so a restart clears it. Say so
      // rather than leaving an unexplained "未连接".
      const stepfunConnected = data.providers.some(provider => provider.name === "stepfun" && provider.connected);
      const previous = seen.current;
      if (stepfunConnected) setRestartNote(null);
      else if (previous.stepfunConnected && previous.instance && data.instance && previous.instance !== data.instance) {
        setRestartNote(ONLINE_BUILD ? "连接会话已重置，StepFun Key 已从服务端内存清除。请重新输入 Key 连接。" : "本地服务刚刚重启，StepFun Key 只保存在后端内存中，已随重启清除。请重新输入 Key 连接。");
      }
      seen.current = { instance: data.instance, stepfunConnected };
      setBackend({ status: "online", data });
      onBackendChange?.(true);
      return data;
    } catch {
      setBackend({ status: "offline" });
      if (getVoiceConfiguration().tts === "stepfun" && getSpeechSnapshot().source === "stepfun") cancelSpeech();
      onBackendChange?.(false);
      return null;
    }
  }, [onBackendChange]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    window.addEventListener("focus", refresh);
    return () => { clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [refresh]);

  const stepfun =
    backend.status === "online" ? backend.data.providers.find(provider => provider.name === "stepfun") : undefined;
  const platform = backend.status === "online" ? backend.data.platform : undefined;
  const pending = busy !== null;
  const linkState = (connected: boolean | undefined) =>
    backend.status === "checking" ? "检查中…" : backend.status === "offline" ? "服务不可用" : connected ? "已连接" : "未连接";
  const activeProvider = backend.status === "online" ? backend.data.activeProvider ?? "stepfun" : "stepfun";
  const active = backend.status === "online" ? backend.data.providers.find(provider => provider.name === activeProvider) : undefined;
  const gpt = backend.status === "online" ? backend.data.providers.find(provider => provider.name === "gpt") : undefined;
  const modelOptions = (active?.models ?? []).filter(model => activeProvider === "gpt" || model === active?.defaultModel || ["step-3.5-flash", "step-3.5-flash-2603", "step-3.7-flash", "step-5-preview", "step-router-v1"].includes(model));
  const ttsReady = voiceConfig.tts === "browser" ? browserVoices.length > 0 : voiceConfig.tts === "local" ? false : voiceConfig.tts === "stepfun" && Boolean(stepfun?.connected);
  const configureModel = async (work: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy("stepfun"); setLastError(null);
    try { const result = await work(); if (!result.ok) setLastError(result.error ?? "模型选择或推理验证失败。"); }
    catch (error) { setLastError(error instanceof Error ? error.message : "连接服务暂不可达。"); }
    finally { setBusy(null); await refresh(); }
  };

  const connect = async () => {
    const apiKey = keyInput.trim();
    if (!apiKey || busy) return;
    if (getVoiceConfiguration().tts === "stepfun") setSpeechEnabled(false);
    setBusy("stepfun");
    setLastError(null);
    try {
      const result = await validateStepfunKey(apiKey);
      if (!result.ok) {
        setLastError(result.error ?? "连接测试失败");
      }
    } catch {
      setLastError("连接服务暂时不可达");
    } finally {
      setKeyInput(""); // clear after every attempt, including rejected keys
      setBusy(null);
      await refresh();
    }
  };

  const disconnect = async () => {
    if (busy) return;
    if (getVoiceConfiguration().tts === "stepfun") setSpeechEnabled(false);
    setBusy("stepfun");
    try {
      await disconnectStepfun();
    } catch {
      // offline anyway; the badge refresh below reflects reality
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  const connectPlatform = async () => {
    const apiKey = platformInput.trim();
    if (!apiKey || busy) return;
    setBusy("platform");
    setPlatformError(null);
    try {
      const result = await validatePlatformKey(apiKey);
      if (!result.ok) setPlatformError(result.error ?? "平台连接未确认，请检查 Key 后重试。");
    } catch {
      setPlatformError("连接服务暂时不可达");
    } finally {
      setPlatformInput("");
      setBusy(null);
      await refresh();
    }
  };

  const disconnectPlatformKey = async () => {
    if (busy) return;
    setBusy("platform");
    setPlatformError(null);
    try { await disconnectPlatform(); }
    catch { setPlatformError("连接服务暂时不可达"); }
    finally { setBusy(null); await refresh(); }
  };

  const badge = (() => {
    if (backend.status === "checking") {
      return { text: "检查中…", cls: "bg-neutral-100 text-neutral-600" };
    }
    if (backend.status === "offline") {
      return {
        text: ONLINE_BUILD ? "在线服务暂不可用" : "后端离线 · 本地规则模式",
        cls: "bg-neutral-200 text-neutral-700",
      };
    }
    if (backend.data.restoring === "gpt" && !active?.connected) {
      return { text: "正在恢复 GPT 连接…", cls: "bg-neutral-100 text-neutral-600" };
    }
    if (active?.connected) {
      return {
        text: `已连接 · ${active.defaultModel ?? activeProvider}`,
        cls: "bg-emerald-100 text-emerald-800",
      };
    }
    return { text: "未连接", cls: "bg-amber-100 text-amber-800" };
  })();

  if (renderPanels) return renderPanels(
    <section className="se-connection" data-vivic-ai-section>
      <form className="se-key-block" onSubmit={event => { event.preventDefault(); void connect(); }}>
        <div className="se-row se-connection-heading"><StepFunBrand />
          <span className="se-connection-state" data-vivic-ai-badge data-connected={Boolean(stepfun?.connected)}>{linkState(stepfun?.connected)}</span>
        </div>
        <div className="se-provider-key">
          <Input type="password" autoComplete="off" placeholder="输入 StepFun API Key" value={keyInput} aria-label="StepFun API Key" data-vivic-ai-key-input
            onChange={event => setKeyInput(event.target.value)} disabled={disabled || pending} />
          <Button type="submit" disabled={disabled || pending || !keyInput.trim()} data-vivic-ai-connect>{busy === "stepfun" ? "验证中…" : "连接"}</Button>
        </div>
        {(lastError || stepfun?.lastError || restartNote) && <p className="se-error" role="status" data-vivic-ai-note>{lastError || stepfun?.lastError || restartNote}</p>}
        {stepfun?.connected && <Button type="button" variant="ghost" className="se-disconnect" disabled={disabled || pending} onClick={() => void disconnect()} data-vivic-ai-disconnect>断开</Button>}
      </form>
      <form className="se-key-block" onSubmit={event => { event.preventDefault(); void connectPlatform(); }}>
        <div className="se-row se-connection-heading"><span>本地 API 平台</span>
          <span className="se-connection-state" data-vivic-platform-badge data-connected={Boolean(platform?.connected)}>{linkState(platform?.connected)}</span>
        </div>
        <div className="se-provider-key">
          <Input type="password" autoComplete="off" placeholder="输入本地 API 平台 Key" value={platformInput} aria-label="本地 API 平台 Key" data-vivic-platform-key-input
            onChange={event => setPlatformInput(event.target.value)} disabled={disabled || pending} />
          <Button type="submit" disabled={disabled || pending || !platformInput.trim()} data-vivic-platform-connect>{busy === "platform" ? "验证中…" : "连接"}</Button>
        </div>
        {(platformError || platform?.lastError) && <p className="se-error" role="status" data-vivic-platform-note>{platformError || platform?.lastError}</p>}
        {platform?.connected && <Button type="button" variant="ghost" className="se-disconnect" disabled={disabled || pending} onClick={() => void disconnectPlatformKey()} data-vivic-platform-disconnect>断开</Button>}
      </form>
    </section>,
    <CompactVoiceSettings connected={Boolean(stepfun?.connected)} disabled={disabled} busy={pending} onPreview={preview} browserVoices={browserVoices} />,
  );

  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-4" data-vivic-ai-section>
      <div className="se-ai-block">
      <div className="se-ai-heading">
        <h2 className="text-sm font-semibold">{ONLINE_BUILD ? "在线 AI" : "大语言模型 · API / OAuth"}</h2>
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-medium ${badge.cls}`}
          data-vivic-ai-badge
        >
          {badge.text}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {!ONLINE_BUILD && <Choice label="LLM 连接方式" testId="llm-provider" value={activeProvider} disabled={disabled || pending || backend.status !== "online"}
          options={[{ value: "stepfun", label: "StepFun Coding Plan" }, { value: "gpt", label: "GPT · Pi 登录" }]}
          onChange={provider => void configureModel(() => selectLlmProvider(provider as LlmProvider))} />}
        {active?.connected && modelOptions.length > 0 && <Choice label="当前推理模型" testId="llm-model" value={active.defaultModel ?? modelOptions[0]} disabled={disabled || pending}
          options={modelOptions.map(model => ({ value: model, label: model }))} onChange={model => void configureModel(() => selectLlmModel(activeProvider, model))} />}
      </div>
      {!ONLINE_BUILD && activeProvider === "gpt" && <GptConnection disabled={disabled || pending || backend.status !== "online"} connected={Boolean(gpt?.connected)} onChange={refresh} />}
      <p className="mt-3 text-xs font-medium text-neutral-700"><StepFunBrand label="StepFun Plan 连接" /> · 可独立用于语音</p>

      <div className="se-provider-key">
        <Input
          type="password"
          autoComplete="off"
          placeholder={ONLINE_BUILD ? "StepFun Coding Plan Key（仅存当前会话内存）" : "StepFun Coding Plan Key（仅存本机后端内存）"}
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          disabled={disabled || pending || backend.status !== "online" || stepfun?.connected}
          aria-label="StepFun API Key"
          data-vivic-ai-key-input
        />
        <Button
          onClick={connect}
          disabled={disabled || pending || backend.status !== "online" || !keyInput.trim() || stepfun?.connected}
          data-vivic-ai-connect
        >
          {pending ? "验证推理中…" : "连接测试"}
        </Button>
        <Button
          variant="secondary"
          onClick={disconnect}
          disabled={disabled || pending || !stepfun?.connected}
          data-vivic-ai-disconnect
        >
          断开
        </Button>
      </div>

      <p className="mt-3 text-xs text-neutral-500" aria-live="polite" data-vivic-ai-note>
        {restartNote && !lastError
          ? restartNote
          : lastError || stepfun?.lastError
          ? `连接失败：${lastError ?? stepfun?.lastError}`
          : backend.status === "offline"
            ? ONLINE_BUILD ? "在线服务暂不可用，请稍后重试；内置文字指令仍可使用。" : "本地服务未连接。请打开启动器检查运行状态；当前仍可使用内置文字指令。"
            : stepfun?.connected
              ? `Plan 推理验证已通过 · 模型列表 ${stepfun.models?.length ?? 0} 个 · TTS 权限以实际调用为准；Key 仅在后端内存，断开即清除。`
              : ONLINE_BUILD ? "输入你自己的 Coding Plan Key，验证后即可使用。Key 仅保留在当前在线会话内存；断开或会话结束即清除。" : "StepFun 使用 Coding Plan Key；连接测试会读取目录并验证推理。GPT 可复用本机 Pi 登录或在上方授权；未连接时本地指令照常可用。"}
      </p>

      <AvailableCards backendStatus={backend.status} provider={active} connectionText={badge.text} />
      </div>

      <div className="se-ai-block">
      <div className="se-ai-heading"><h2 className="text-sm font-semibold">语音输入与反馈</h2><span className="text-xs text-neutral-500">按需开启</span></div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="space-y-1"><p className="text-xs text-neutral-700">语音输入（STT）</p><Choice label="语音输入服务" testId="stt-provider" value={voiceConfig.stt} disabled={disabled || pending}
          options={ONLINE_BUILD ? [{ value: "stepfun", label: "StepFun Plan ASR" }, { value: "none", label: "仅文字输入" }] : [{ value: "stepfun", label: "StepFun Plan ASR" }, { value: "local", label: "本地 Sherpaw ASR" }, { value: "none", label: "仅文字输入" }]}
          onChange={stt => setVoiceConfiguration({ stt: stt as SttProvider })} /></div>
        <div className="space-y-1"><p className="text-xs text-neutral-700">语音输出（TTS）</p><Choice label="语音输出服务" testId="tts-provider" value={voiceConfig.tts} disabled={disabled || pending}
          options={ONLINE_BUILD ? [{ value: "stepfun", label: "StepFun Plan TTS" }, { value: "none", label: "仅卡片与字幕" }] : [{ value: "stepfun", label: "StepFun Plan TTS" }, { value: "local", label: "本地 Sherpa-ONNX TTS" }, { value: "browser", label: "系统本地音色" }, { value: "none", label: "仅卡片与字幕" }]}
          onChange={tts => { setSpeechEnabled(false); setVoiceConfiguration({ tts: tts as TtsProvider }); }} /></div>
      </div>
      <p className="mt-2 text-xs text-neutral-500">{ONLINE_BUILD ? "语音按需开启，权限和音色以实际调用结果为准。" : "语音与模型连接独立。选择本地识别或系统音色可减少对云端语音的依赖；本地模型下载进度在“本地能力”中查看。"}</p>

      <div className="mt-3 flex flex-wrap items-center gap-2" data-vivic-microphone-permission data-status={microphone.phase}>
        <p className="text-xs text-neutral-600" role="status">{ONLINE_BUILD && microphone.phase === "idle" ? "需要语音时，再授权麦克风；文字输入无需授权。" : microphone.phase === "idle" && voiceConfig.stt === "none" ? "当前仅文字输入，未请求麦克风权限。" : microphone.message}</p>
        {microphone.phase !== "granted" && <Button variant="outline" size="sm"
          disabled={disabled || microphone.phase === "requesting" || microphone.phase === "unsupported"}
          onClick={() => void requestMicrophonePermission()}>
          {microphone.phase === "requesting" ? "等待麦克风授权…" : microphone.phase === "denied" ? "重新检查麦克风权限" : "请求麦克风权限"}
        </Button>}
      </div>

      <AudioOutputSettings disabled={disabled || pending} />
      <label className="mt-3 flex items-center gap-2 text-xs text-neutral-700">
        <Input
          type="checkbox"
          className="h-4 w-4 shrink-0 accent-neutral-900"
          checked={speech.enabled}
          onChange={(event) => setSpeechEnabled(event.target.checked)}
          disabled={disabled || pending || voiceConfig.tts === "none"}
          aria-describedby="vivic-tts-note"
          data-vivic-tts-toggle
        />
        开启语音反馈（TTS）
      </label>
      <p className="mt-2 text-xs text-neutral-500">选择 StepFun 温柔女声并开启语音反馈后，匹配的常用短句使用内置音频；其他内容与音色按所选服务生成。{!ttsReady && voiceConfig.tts !== "none" ? "当前语音服务尚未就绪，请先检查连接或系统音色。" : ""}</p>
      {voiceConfig.tts === "stepfun" && <label className="mt-2 flex items-center gap-2 text-xs text-neutral-700">
        <Input type="checkbox" className="h-4 w-4 shrink-0 accent-neutral-900" checked={speech.preferences.timestamps === true}
          disabled={disabled || pending} onChange={event => setSpeechPreferences({ timestamps: event.target.checked })} data-vivic-word-timing />
        请求逐词字幕（需语音服务支持，默认关闭）
      </label>}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {voiceConfig.tts === "stepfun" && <div className="sm:col-span-2">
          <label htmlFor="vivic-tts-voice" className="text-xs text-neutral-700">音色</label>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Select.Root
              value={speech.preferences.voice}
              onValueChange={(voice) => setSpeechPreferences({ voice: voice as SpeechVoiceId })}
            >
              <Select.Trigger asChild>
                <Button id="vivic-tts-voice" variant="outline" className="min-w-40 flex-1 justify-between" data-vivic-tts-voice>
                  <Select.Value />
                  <Select.Icon><ChevronDown className="size-4" aria-hidden="true" /></Select.Icon>
                </Button>
              </Select.Trigger>
              <Select.Portal>
                <Select.Content
                  position="popper" sideOffset={4} collisionPadding={12}
                  className="z-50 max-h-64 min-w-[var(--radix-select-trigger-width)] overflow-y-auto rounded-md border border-neutral-200 bg-white p-1 text-sm text-neutral-900 shadow-md"
                >
                  <Select.Viewport>
                    {SPEECH_VOICES.map((voice) => (
                      <Select.Item
                        key={voice.id} value={voice.id}
                        className="relative flex cursor-default select-none items-center rounded-sm py-2 pl-7 pr-3 outline-none data-[highlighted]:bg-neutral-100"
                      >
                        <Select.ItemIndicator className="absolute left-2"><Check className="size-3" aria-hidden="true" /></Select.ItemIndicator>
                        <Select.ItemText>{voice.name}</Select.ItemText>
                      </Select.Item>
                    ))}
                  </Select.Viewport>
                </Select.Content>
              </Select.Portal>
            </Select.Root>
            <Button variant="secondary" onClick={preview} disabled={disabled || pending || !stepfun?.connected} data-vivic-tts-preview>
              {speech.kind === "preview" && speech.loading ? "取消试听" : speech.kind === "preview" && speech.playing ? "停止试听" : "试听音色"}
            </Button>
          </div>
        </div>}
        {voiceConfig.tts === "browser" && <div className="sm:col-span-2 space-y-2">
          {browserVoices.length ? <Choice label="系统音色" value={voiceConfig.browserVoice || browserVoices[0].value} options={browserVoices} disabled={disabled}
            onChange={browserVoice => setVoiceConfiguration({ browserVoice })} /> : <p className="text-xs text-neutral-500">尚无系统本地音色，可保留文字或等待音色加载。</p>}
          <p className="text-xs text-neutral-500">仅显示浏览器标为本地的音色；实际离线可用性取决于系统安装情况。</p>
        </div>}
        <div>
          <label htmlFor="vivic-tts-speed" className="flex justify-between gap-2 text-xs text-neutral-700">
            语速 <span>{speech.preferences.speed.toFixed(1)}×</span>
          </label>
          <Input
            id="vivic-tts-speed" type="range" min={0.5} max={2} step={0.1}
            value={speech.preferences.speed}
            onChange={(event) => setSpeechPreferences({ speed: Number(event.target.value) })}
            className="mt-1 h-7 border-0 px-0 shadow-none accent-neutral-900"
            aria-valuetext={`${speech.preferences.speed.toFixed(1)} 倍速`} data-vivic-tts-speed
          />
        </div>
        <div>
          <label htmlFor="vivic-tts-volume" className="flex justify-between gap-2 text-xs text-neutral-700">
            音量 <span>{Math.round(speech.preferences.volume * 100)}%</span>
          </label>
          <Input
            id="vivic-tts-volume" type="range" min={0} max={1} step={0.01}
            value={speech.preferences.volume}
            onChange={(event) => setSpeechPreferences({ volume: Number(event.target.value) })}
            className="mt-1 h-7 border-0 px-0 shadow-none accent-neutral-900"
            aria-valuetext={`${Math.round(speech.preferences.volume * 100)}%`} data-vivic-tts-volume
          />
        </div>
      </div>
      <p id="vivic-tts-note" className="mt-2 text-xs text-neutral-500" aria-live="polite" data-vivic-tts-note>
        {speech.error ?? (speech.loading ? "正在合成语音…" : speech.playing ? "正在播放…" : "偏好会保存；刷新后自动语音仍关闭。试听使用同一 Plan Key，消耗套餐额度；权限以实际调用为准。")}
      </p>
      {speech.preferenceError && <p className="mt-1 text-xs text-amber-700" role="status">{speech.preferenceError}</p>}
      <a href={SPEECH_VOICES_SOURCE} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-neutral-500 underline underline-offset-2">
        官方音色清单
      </a>
      </div>
    </section>
  );
};
