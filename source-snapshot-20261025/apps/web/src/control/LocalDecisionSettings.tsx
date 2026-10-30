import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "./ConfirmDialog";
import { LocalModelPicker } from "@/launcher/LocalModelPicker";
interface Status {
  phase: string; enabled: boolean; model: string; bytes: number; gpuBytes: number;
  lastMs: number | null; error: string | null; mode?: "provider" | "managed"; configurationError?: string;
  downloadedBytes?: number; totalBytes?: number;
  profileId?:string;
  resources?: { allowed: boolean; freeMemoryBytes: number | null; requiredFreeBytes: number };
  v2?: { configured: boolean; executionEnabled: boolean; available?: boolean };
  lastState?: "accepted" | "deferred" | "error" | "timeout" | "cancelled" | "disabled";
}
function providerPhaseLabel(status: Status): string {
  if (status.configurationError) return "配置无效，已转交原有流程";
  if (!status.enabled) return "未启用";
  if (status.lastState === "timeout") return "请求超时，已转交原有流程";
  if (status.phase === "error" || status.lastState === "error") return "服务暂不可用，已转交原有流程";
  if (status.lastState === "deferred") return "判断不确定或缺少评分，已转交原有流程";
  if (status.lastState === "accepted") return "最近判断已接纳，执行结果请查看对话";
  if (status.lastState === "cancelled") return "最近请求已取消";
  return "已启用（服务状态待请求确认）";
}
export function LocalDecisionSettings({ disabled }: { disabled: boolean }) {
  const [status, setStatus] = useState<Status | null>(null), [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = async () => { try { const r = await fetch("/api/decision/status", { cache: "no-store" }); if (r.ok && active) setStatus(await r.json()); } catch { /* Main app remains usable offline. */ } };
    void refresh(); const timer = setInterval(() => void refresh(), 5000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  const action = async (name: "prepare" | "enable" | "stop" | "clear" | "profile",profileId?:string) => {
    setBusy(true);
    try {
      const response = await fetch(`/api/decision/${name}`, { method: "POST", ...(profileId?{headers:{"content-type":"application/json"},body:JSON.stringify({profileId})}:{}) });
      if (!response.ok) throw new Error("Decision control unavailable");
      setStatus(await response.json());
    }
    catch { setStatus(previous => previous ? { ...previous, error: previous.mode === "provider" ? "决策服务暂不可达，请重试。" : "本地决策服务暂不可达，请重试。" } : previous); }
    finally { setBusy(false); }
  };
  const pending = status && ["downloading", "installing", "loading", "stopping"].includes(status.phase);
  const providerMode = status?.mode === "provider" || Boolean(status?.configurationError);
  const phaseLabel = status ? providerMode ? providerPhaseLabel(status)
    : ({ absent: "尚未准备", downloading: "正在准备模型文件", installing: "正在准备运行环境", cached: "已准备，未启用", loading: "正在加载并预热", stopping: "正在停止并释放内存", ready: "已启用", error: "暂不可用" } as Record<string, string>)[status.phase] ?? status.phase : "";
  return <section className="se-preference-block" data-vivic-local-decision>
    <h2 className="text-sm font-semibold">{providerMode ? "决策服务" : "决策模型"}</h2>
    <p className="mt-2 text-xs text-neutral-500">{providerMode ? "处理操作指令；不确定时交给主模型。" : "在这台电脑运行；停止后释放内存。"}</p>
    {status?.mode==="managed"&&status.profileId&&<LocalModelPicker profileId={status.profileId} disabled={disabled||busy||Boolean(pending)||status.enabled} onChange={id=>void action("profile",id)}/>}
    <p className="mt-2 text-xs text-neutral-600" role="status" data-vivic-decision-status>{status
      ? `${status.configurationError ? "受控决策服务" : status.model} · ${phaseLabel}${status.lastMs !== null ? ` · 最近 ${Math.round(status.lastMs)}ms` : ""}`
      : "本地决策服务未连接，现有文字指令仍可使用。"}</p>
    {status?.v2?.configured && <p className="mt-2 text-xs text-neutral-500" data-vivic-native-status>Jev v2 原生接口{status.v2.available ? "已就绪" : "已接线"}。{!status.v2.executionEnabled && "质量尚未确认，执行保持关闭。"}</p>}
    {!providerMode && status?.resources && !status.enabled && !status.resources.allowed && <p className="mt-2 text-xs text-amber-700" role="status">可用内存{status.resources.freeMemoryBytes === null ? "无法确认" : `约 ${(status.resources.freeMemoryBytes / 2 ** 30).toFixed(1)} GiB`}，此规格需 {(status.resources.requiredFreeBytes / 2 ** 30).toFixed(0)} GiB。请释放内存或选择较小规格。</p>}
    {pending && ["downloading", "installing"].includes(status?.phase ?? "") && status?.totalBytes && <p className="mt-2 text-xs" role="status">已准备 {Math.round((status.downloadedBytes ?? 0) / 1e6)} / {Math.round(status.totalBytes / 1e6)} MB</p>}
    <div className="mt-3 flex flex-wrap gap-2">
      {!providerMode && <Button variant="secondary" size="sm" disabled={disabled || busy || !status || Boolean(pending) || status.enabled} onClick={() => void action("prepare")} data-vivic-decision-prepare>准备模型</Button>}
      <Button variant="secondary" size="sm" disabled={disabled || busy || !status || Boolean(pending) || Boolean(status?.configurationError) || status.enabled || !providerMode && (status.phase === "absent" || status.mode === "managed" && status.resources?.allowed !== true)} onClick={() => void action("enable")} data-vivic-decision-enable>{providerMode ? "启用决策服务" : "启用本地决策"}</Button>
      <Button variant="outline" size="sm" disabled={disabled || busy || !status || status.phase === "stopping" || !status.enabled && !pending} onClick={() => void action("stop")} data-vivic-decision-stop>{providerMode ? "停用决策服务" : "停止并释放内存"}</Button>
      {!providerMode && <ConfirmDialog title="清理本地决策模型缓存？" description="停止本地决策并删除其模型文件，之后需要重新准备；画布和账号连接保留。"
        disabled={disabled || busy || Boolean(pending)} onConfirm={() => void action("clear")} confirmLabel="清理模型"
        trigger={<Button variant="outline" size="sm" disabled={disabled || busy || Boolean(pending)} data-vivic-decision-clear>清理模型缓存</Button>} />}
    </div>
    {(status?.configurationError || status?.error) && <p className="mt-2 text-xs text-amber-700">{status.configurationError || status.error}</p>}
  </section>;
}
