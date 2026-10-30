import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/control/ConfirmDialog";
import { HarkBackdrop, HarkIcon, HarkSurface } from "@/components/hark/HarkPrimitives";
import "@/components/hark/hark.css";
import "./launcher.css";
import { LocalModelPicker } from "./LocalModelPicker";
import { LocalTtsSettings } from "@/control/LocalTtsSettings";

interface RuntimeStatus {
  phase: string; enabled: boolean; model: string; mode?: "managed" | "provider";
  error: string | null; downloadedBytes?: number; totalBytes?: number;
  lastMs?: number | null; lastState?: string; configurationError?: string;
  profileId?: string;engine?: string;
  resources?: { allowed: boolean; freeMemoryBytes: number | null; requiredFreeBytes: number; basis: string };
  v2?: { configured: boolean; executionEnabled: boolean; available?: boolean };
}
type Action = "prepare" | "enable" | "stop" | "clear" | "profile";
const phases: Record<string, string> = {
  absent: "尚未准备", downloading: "正在下载并校验", installing: "正在整理模型文件",
  cached: "已准备，可启动", loading: "正在加载并预热", ready: "模型已就绪", stopping: "正在停止并释放内存", error: "需要处理",
};
const working = new Set(["downloading", "installing", "loading", "stopping"]);
function parseStatus(value: unknown): RuntimeStatus {
  if (!value || typeof value !== "object" || !("phase" in value) || typeof value.phase !== "string"
    || !("model" in value) || typeof value.model !== "string" || !("enabled" in value) || typeof value.enabled !== "boolean") throw new Error("invalid_status");
  return value as RuntimeStatus;
}

/** A service console only: never mounts a canvas owner, microphone or persistence. */
export default function LauncherApp() {
  const [theme, setTheme] = useState<"light" | "dark">(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [connected, setConnected] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null), [checkedAt, setCheckedAt] = useState("");
  const mounted = useRef(false), epoch = useRef(0), mutating = useRef(false), reading = useRef(false);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;
    const update = () => setTheme(media.matches ? "dark" : "light");
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const refresh = async () => {
    if (reading.current || mutating.current) return;
    reading.current = true; const revision = epoch.current;
    try {
      const response = await fetch("/api/decision/status", { cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error("unavailable");
      const next = parseStatus(await response.json());
      if (mounted.current && revision === epoch.current) { setStatus(next); setConnected(true); setError(null); setCheckedAt(new Date().toLocaleTimeString()); }
    } catch {
      if (mounted.current && revision === epoch.current) setConnected(false);
    } finally { reading.current = false; }
  };
  useEffect(() => {
    mounted.current = true; queueMicrotask(() => void refresh());
    const timer = setInterval(() => void refresh(), 1500);
    // The epoch deliberately invalidates requests across StrictMode remounts.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    return () => { mounted.current = false; ++epoch.current; clearInterval(timer); };
  }, []);
  const action = async (name: Action, profileId?:string) => {
    if (mutating.current) return;
    mutating.current = true; ++epoch.current; setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/decision/${name}`, { method: "POST", signal: AbortSignal.timeout(8000), ...(profileId?{headers:{"content-type":"application/json"},body:JSON.stringify({profileId})}:{}) });
      if (!response.ok) throw new Error("unavailable");
      const next = parseStatus(await response.json());
      if (mounted.current) { setStatus(next); setConnected(true); setCheckedAt(new Date().toLocaleTimeString()); }
    } catch {
      if (mounted.current) { setConnected(false); setError("操作结果尚未确认。恢复连接后会刷新实际状态，请勿重复操作。"); }
    } finally { mutating.current = false; if (mounted.current) setBusy(false); }
  };
  const managed = status?.mode === "managed";
  const pending = Boolean(status && working.has(status.phase));
  const ready = connected && status?.phase === "ready" && status.enabled;
  const unavailable = busy || !connected || !status;
  const total = status?.totalBytes ?? 0, downloaded = status?.downloadedBytes ?? 0;
  const progress = total > 0 ? Math.min(100, Math.max(0, Math.round(downloaded / total * 100))) : 0;
  const phase = !connected ? "状态待连接确认" : !managed ? status?.enabled ? "已启用，健康状态以实际请求为准" : "尚未启用" : phases[status?.phase ?? ""] ?? "状态待确认";
  return <main className="vivic-launcher vh-hark" data-appearance={theme} data-hark-workspace="local-launcher">
    <HarkBackdrop theme={theme} />
    <div className="launcher-panel">
    <header className="launcher-topbar">
      <div><span className="launcher-brand">Vivic</span><h1>本地服务</h1></div>
      <a className="launcher-primary" href="/">打开 Vivic<HarkIcon name="arrow-up-right" size={16} /></a>
    </header>
        <HarkSurface className="launcher-runtime" aria-labelledby="runtime-title"><div className="launcher-card-heading"><h2 id="runtime-title"><HarkIcon name="cpu" size={20} />{managed ? "决策模型" : "决策服务"}</h2>{connected && <span className="launcher-tag">{managed ? "本地 · CPU" : "服务连接"}</span>}</div>
          {status && <p className="launcher-model-name">{status.model}</p>}
          {status?.v2?.configured && <p className="launcher-footer" data-vivic-native-status>Jev v2 原生接口{status.v2.available ? "已就绪" : "已接线"}。{!status.v2.executionEnabled && "质量尚未确认，执行保持关闭。"}</p>}
          {managed&&status?.profileId&&<LocalModelPicker profileId={status.profileId} disabled={unavailable||pending||status.enabled} onChange={id=>void action("profile",id)}/>}
          <div className={`launcher-runtime-status ${ready && managed ? "is-ready" : ""}`} role="status" aria-live="polite">{pending && connected ? <HarkIcon name="refresh" className="launcher-spinner" size={17} aria-hidden="true" /> : ready && managed ? <HarkIcon name="check" size={17} aria-hidden="true" /> : <span className="launcher-dot" />}<strong>{phase}</strong></div>
          {managed && connected && status?.phase === "downloading" && <div className="launcher-download"><progress aria-label="模型下载进度" max={100} value={total > 0 ? progress : undefined} /><div><span>{Math.round(downloaded / 1e6)}{total > 0 ? ` / ${Math.round(total / 1e6)}` : ""} MB</span>{total > 0 && <span>{progress}%</span>}</div></div>}
          {!connected && <div className="launcher-alert"><HarkIcon name="alert" size={16} aria-hidden="true" /><span>请运行 Start-Vivic。连接恢复后会自动更新。</span></div>}
          {(error || status?.error || status?.configurationError) && <div className="launcher-alert" role="alert"><HarkIcon name="alert" size={16} aria-hidden="true" /><span>{error || status?.configurationError || status?.error}</span></div>}
          {status && <div className="launcher-actions">
            {managed && <Button className="launcher-secondary" disabled={unavailable || pending || status.enabled} onClick={() => void action("prepare")}><HarkIcon name="download" size={16} aria-hidden="true" />{status.phase === "error" ? "重新准备" : status.phase === "cached" ? "检查文件" : "准备模型"}</Button>}
            <Button className="launcher-secondary" disabled={unavailable || pending || Boolean(status?.configurationError) || Boolean(status?.enabled) || managed && (status?.phase === "absent" || status.resources?.allowed !== true)} onClick={() => void action("enable")}><HarkIcon name="cpu" size={16} aria-hidden="true" />{managed ? "启动模型" : "启用服务"}</Button>
            <Button className="launcher-secondary" disabled={unavailable || status?.phase === "stopping" || !status?.enabled && !pending} onClick={() => void action("stop")}><HarkIcon name="stop" size={14} aria-hidden="true" />{pending && status?.phase !== "loading" && status?.phase !== "stopping" ? "取消准备" : managed ? "停止模型" : "停用服务"}</Button>
          </div>}
          {managed && status?.resources && !status.enabled && <p className="launcher-footer" role="status">{status.resources.freeMemoryBytes === null ? "可用内存暂无法确认，已阻止启动。" : `当前可用 ${(status.resources.freeMemoryBytes / 2 ** 30).toFixed(1)} GiB，此规格需 ${(status.resources.requiredFreeBytes / 2 ** 30).toFixed(0)} GiB。`}{!status.resources.allowed && "请释放内存或选择较小规格。"}启动前会重新检查。</p>}
          {status && <div className="launcher-runtime-footer">{managed ? <><span>{total > 0 ? `模型文件约 ${Math.round(total / 1e6)} MB` : "文件大小待确认"}</span><ConfirmDialog title="清理本地模型文件？" description="本地模型会停止并删除其下载缓存，下次使用需要重新准备。" confirmLabel="清理模型" disabled={unavailable || pending} onConfirm={() => void action("clear")} trigger={<Button className="launcher-text-button" variant="ghost" disabled={unavailable || pending}>清理缓存</Button>} /></> : <a href="/control">管理连接<HarkIcon name="arrow-up-right" size={14} /></a>}</div>}
        </HarkSurface>
        {managed&&<HarkSurface className="launcher-runtime"><details className="launcher-local-voice"><summary>本地语音<HarkIcon name="chevron-down" size={16}/></summary><LocalTtsSettings /></details></HarkSurface>}
        <div className="launcher-refresh"><span>{checkedAt ? `最近检查 ${checkedAt}` : "等待首次状态"}</span><Button className="launcher-text-button" variant="ghost" disabled={busy} onClick={() => { setError(null); void refresh(); }} aria-label="刷新状态"><HarkIcon name="refresh" size={14} aria-hidden="true" />刷新</Button></div>
        <p className="launcher-footer">退出本地服务时，运行 <strong>Stop-Vivic</strong>。</p>
    </div>
  </main>;
}
