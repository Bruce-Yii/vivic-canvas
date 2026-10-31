import { useEffect, useState, useSyncExternalStore } from "react";
import { Download, HardDrive, Square, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DEFAULT_WAKE_PHRASE, localSpeechModels, SPEECH_MODELS } from "@/ai/localSpeech";
import type { LocalSpeechModelManager } from "@/ai/localSpeech";
export { LocalWakeInput } from "./LocalWakeInput";
export type { LocalWakeInputProps } from "./LocalWakeInput";

export interface LocalSpeechSettingsProps {
  disabled?: boolean;
  /** Injection for isolated hosts/tests. The parent owns session enablement and microphone. */
  manager?: LocalSpeechModelManager;
  /** Parent must stop/dispose active sessions before deleting cached weights. */
  onBeforeClear?: () => void | Promise<void>;
}
export const LocalSpeechSettings = ({ disabled = false, manager = localSpeechModels, onBeforeClear }: LocalSpeechSettingsProps) => {
  const snapshot = useSyncExternalStore(manager.subscribe, manager.getSnapshot);
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  useEffect(() => {
    let active = true;
    const prepare = manager.refresh();
    void prepare.catch(cause => {
      if (active && !(cause instanceof DOMException && cause.name === "AbortError")) setError("无法读取本地模型缓存，仍可使用 PTT 或文字。");
    });
    return () => { active = false; };
  }, [manager, disabled]);
  const clear = async () => {
    setClearing(true); setError(null);
    try { await onBeforeClear?.(); await manager.clearModelCache(); }
    catch { setError("缓存清理失败，请停止本地语音后重试。"); }
    finally { setClearing(false); }
  };
  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-4" data-vivic-local-speech>
      <div className="flex items-center gap-2 text-sm font-semibold"><HardDrive className="h-4 w-4" />本地语音</div>
      <p className="mt-2 text-xs text-neutral-500">按需下载，打开设置不会下载模型。云端识别无需准备本地识别模型。</p>
      <p className="mt-2 text-xs text-neutral-600">默认唤醒词已配置为「{DEFAULT_WAKE_PHRASE}」。麦克风权限会在启动时请求；点击“开启单次监听”后才开始监听，默认不监听。</p>
      <ul className="mt-3 space-y-3">
        {SPEECH_MODELS.map(model => {
          const state = snapshot.models[model.id];
          const busy = state.phase === "downloading" || state.phase === "verifying";
          const cached = state.phase === "cached" || state.phase === "ready";
          const percent = Math.min(100, Math.floor(state.loaded / state.total * 100));
          return <li key={model.id} className="rounded-lg border border-neutral-200 p-3" data-local-speech-model={model.id}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div><p className="text-sm font-medium">{model.label}</p><p className="mt-1 text-xs text-neutral-500">{(model.bytes / 1_000_000).toFixed(2)} MB · {cached ? "已缓存，加载时再次校验" : state.phase === "verifying" ? "正在校验完整性…" : busy ? `下载 ${percent}%` : "尚未就绪"}</p></div>
              {busy ? <Button size="sm" variant="outline" disabled={disabled || clearing} onClick={() => manager.cancelDownload(model.id)}><Square className="h-3 w-3" />取消</Button>
                : <Button size="sm" variant="outline" disabled={disabled || clearing} onClick={() => {
                  setError(null);
                  void manager.prepareModel(model.id).catch(cause => {
                    if (!(cause instanceof DOMException && cause.name === "AbortError")) setError(cause instanceof Error ? cause.message : "下载失败。");
                  });
                }}><Download className="h-3 w-3" />{cached ? "重新校验" : "下载"}</Button>}
            </div>
            {busy && <progress className="mt-2 h-2 w-full" max={state.total} value={state.loaded} aria-label={`${model.label}下载进度`} />}
            {state.error && <p className="mt-2 text-xs text-red-700" role="alert">{state.error}</p>}
          </li>;
        })}
      </ul>
      <div className="mt-3 flex items-center justify-between gap-2">
        <p className="text-xs text-neutral-500">仅控制页前台监听；模型缓存可能被浏览器回收。</p>
        <Button size="sm" variant="ghost" disabled={disabled || clearing} onClick={() => void clear()}><Trash2 className="h-3 w-3" />{clearing ? "正在清理…" : "清理模型缓存"}</Button>
      </div>
      {error && <p className="mt-2 text-xs text-red-700" role="alert">{error}</p>}
    </section>
  );
};
