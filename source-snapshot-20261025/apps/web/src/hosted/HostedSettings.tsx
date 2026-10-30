import { useCallback, useEffect, useRef, useState } from "react";
import type { HostedSpaceSnapshot } from "@vivic/contracts";
import { HarkIcon } from "@/components/hark/HarkPrimitives";
import { HostedDialog } from "./HostedDialog";
import { errorMessage, HostedApiError, hostedClient, hostedRequest, type HostedDevice, type HostedSession } from "./client";
import { useHostedAssets } from "@/hostedAssets/HostedAssets";
import { useRefreshHostedDefinitions } from "./HostedDefinitions";

interface Providers { activeProvider?: string; providers: { name: string; connected: boolean; defaultModel?: string }[] }
const sessionFailure = (error: unknown) => error instanceof HostedApiError && error.status === 401 && ["login-required", "session-required", "device-revoked"].includes(error.code);
export function HostedSettings({ session, snapshot, theme, onTheme, onClose, onLogout, onImport }: {
  session: HostedSession; snapshot: HostedSpaceSnapshot | null; theme: "light" | "dark"; onTheme(value: "light" | "dark"): void; onClose(): void; onLogout(): void; onImport(): void;
}) {
  const assets = useHostedAssets();
  const refreshDefinitions = useRefreshHostedDefinitions();
  const [devices, setDevices] = useState<HostedDevice[]>([]), [providers, setProviders] = useState<Providers | null>(null);
  const [key, setKey] = useState(""), [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  const [modelKey, setModelKey] = useState(""), [models, setModels] = useState<{ configured: boolean; message?: string } | null>(null);
  const [pair, setPair] = useState<{ code: string; expiresAt: string } | null>(null);
  const lifecycle = useRef({ alive: true, revision: 0, running: false }), keyRevision = useRef(0), modelKeyRevision = useRef(0);
  const current = useCallback((revision: number) => lifecycle.current.alive && lifecycle.current.revision === revision, []);
  const expire = useCallback(() => { setKey(""); setModelKey(""); setProviders(null); setModels(null); setPair(null); onLogout(); }, [onLogout]);
  const refresh = useCallback(async (revision: number, signal?: AbortSignal) => {
    const values = await Promise.allSettled([hostedClient.devices(), hostedRequest<Providers>("/api/providers/status", undefined, "GET", signal), hostedRequest<{ configured: boolean; message?: string }>("/api/space/models/status", undefined, "GET", signal)]);
    if (!current(revision)) return false;
    if (values.some(value => value.status === "rejected" && value.reason instanceof HostedApiError && value.reason.status === 401)) { expire(); return false; }
    setDevices(values[0].status === "fulfilled" ? values[0].value.devices : []);
    setProviders(values[1].status === "fulfilled" ? values[1].value : null); setModels(values[2].status === "fulfilled" ? values[2].value : null);
    refreshDefinitions();
    const complete = values.every(value => value.status === "fulfilled"); if (!complete) setMessage("部分连接状态暂不可用，请检查连接后重试。");
    return complete;
  }, [current, expire, refreshDefinitions]);
  useEffect(() => { const scope = lifecycle.current, controller = new AbortController(); scope.alive = true; const revision = ++scope.revision; void refresh(revision, controller.signal); return () => { controller.abort(); scope.alive = false; scope.revision++; scope.running = false; }; }, [refresh]);
  const run = (operation: (revision: number) => Promise<void>) => { const scope = lifecycle.current; if (!scope.alive || scope.running) return; scope.running = true; const revision = ++scope.revision; setBusy(true); setMessage("");
    void operation(revision).catch(error => { if (!current(revision)) return; if (sessionFailure(error)) expire(); else setMessage(error instanceof HostedApiError ? errorMessage(error) : "连接中断，请先检查连接状态后重试。"); }).finally(() => { if (current(revision)) { scope.running = false; setBusy(false); } }); };
  const connected = providers?.providers.find(provider => provider.name === (providers.activeProvider ?? "stepfun"));
  return <HostedDialog title="设置" onClose={onClose} className="hosted-settings"><div className="hosted-settings-content">
    <section><h3>外观</h3><label className="hosted-setting-row"><span>明暗</span><select value={theme} onChange={event => onTheme(event.target.value as "light" | "dark")} aria-label="界面明暗"><option value="light">浅色</option><option value="dark">深色</option></select></label></section>
    <section><h3>模型连接</h3><div className="hosted-setting-row"><span>{providers === null ? "连接状态待确认" : connected?.connected ? connected.defaultModel ?? "已连接" : "未连接"}</span><button className="hosted-quiet" disabled={busy} onClick={() => run(async revision => { await refresh(revision); })}>检查连接</button></div>
      <details><summary>StepFun Coding Plan</summary><form className="hosted-form" onSubmit={event => { event.preventDefault(); const apiKey = key.trim(), submittedRevision = keyRevision.current; if (!apiKey || busy) return; setProviders(null); run(async revision => {
        const result = await hostedRequest<{ ok: boolean; connected: boolean }>("/api/credentials/stepfun/validate", { apiKey });
        if (!current(revision)) return; if (!result.connected) { setMessage("连接未通过，请检查 Key 后重试。"); return; } if (keyRevision.current === submittedRevision) setKey(""); if (await refresh(revision) && current(revision)) setMessage("模型已连接。");
      }); }}><label>API Key<input type="password" value={key} onChange={event => { keyRevision.current++; setKey(event.target.value); }} autoComplete="off" spellCheck={false} placeholder="仅保留在服务端内存" /></label><button type="submit" className="hosted-primary" disabled={!key.trim() || busy}>连接</button></form>
      <button className="hosted-quiet" disabled={busy} onClick={() => { keyRevision.current++; setKey(""); setProviders(null); run(async revision => { await hostedRequest("/api/credentials/stepfun/disconnect", {}); if (current(revision) && await refresh(revision) && current(revision)) setMessage("已断开模型连接。"); }); }}>断开</button></details>
      <details><summary>语音与小模型</summary><p className="hosted-muted">决策分类仍待质量验收，暂不控制卡片执行。</p><p className="hosted-muted">{models === null ? "平台连接状态待确认。" : models.configured ? "已配置平台连接；识别和合成按实际调用反馈。" : "连接后可按需使用语音。"}</p><form className="hosted-form" onSubmit={event => { event.preventDefault(); const apiKey = modelKey.trim(), submittedRevision = modelKeyRevision.current; if (!apiKey || busy) return; setModels(null); run(async revision => { const result = await hostedRequest<{ configured: boolean }>("/api/space/models/connect", { apiKey }); if (!current(revision)) return; if (!result.configured) { setMessage("平台连接未确认，请检查后重试。"); return; } if (modelKeyRevision.current === submittedRevision) setModelKey(""); if (await refresh(revision) && current(revision)) setMessage("已配置平台连接。"); }); }}><label>平台 Key<input type="password" autoComplete="off" spellCheck={false} value={modelKey} onChange={event => { modelKeyRevision.current++; setModelKey(event.target.value); }} placeholder="与 LLM Key 分开，仅存服务端内存" /></label><button type="submit" className="hosted-primary" disabled={!modelKey.trim() || busy}>连接平台</button></form><button className="hosted-quiet" disabled={busy} onClick={() => { modelKeyRevision.current++; setModelKey(""); setModels(null); run(async revision => { await hostedRequest("/api/space/models/disconnect", {}); if (current(revision) && await refresh(revision) && current(revision)) setMessage("已断开平台连接。"); }); }}>断开</button></details>
    </section>
    <section><h3>数据</h3><div className="hosted-setting-row"><span>原件</span><button className="hosted-quiet" onClick={() => { onClose(); setTimeout(() => assets.manageAssets(), 0); }}>管理</button></div><div className="hosted-setting-row"><span>旧浏览器数据</span><button className="hosted-quiet" onClick={() => { onClose(); setTimeout(onImport, 0); }}>导入此浏览器旧 Space</button></div><div className="hosted-setting-row"><span>当前 Space</span><button className="hosted-quiet" disabled={!snapshot} onClick={() => {
      if (!snapshot) return; const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot.space, null, 2)], { type: "application/json" })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = "vivic-space.json"; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }}><HarkIcon name="download" />导出</button></div></section>
    <section><h3>设备授权</h3><div className="hosted-setting-row"><span>{session.user?.username}</span><button className="hosted-quiet" disabled={busy} onClick={() => { setPair(null); run(async revision => { const value = await hostedClient.pair(); if (current(revision)) setPair(value); }); }}>生成设备码</button></div>
      {pair && <div className="hosted-pair"><label>在另一台设备输入<input readOnly value={pair.code} aria-label="设备码" /></label><p className="hosted-muted">有效至 {new Date(pair.expiresAt).toLocaleTimeString()}。输入后需在新设备点击「授权此设备」。</p><button className="hosted-quiet" onClick={() => setPair(null)}>收起</button></div>}
      {devices.map(device => <div className="hosted-setting-row" key={device.id}><span>{device.name}{device.id === session.device?.id ? " · 此设备" : ""}</span><button className="hosted-quiet" disabled={busy} onClick={() => run(async revision => { await hostedClient.revokeDevice(device.id); if (!current(revision)) return; if (device.id === session.device?.id) expire(); else if (await refresh(revision) && current(revision)) setMessage("已撤销设备授权。"); })}>撤销</button></div>)}
      <button className="hosted-quiet" disabled={busy} onClick={() => run(async revision => { await hostedClient.logout(); if (current(revision)) expire(); })}><HarkIcon name="sign-out" />退出登录</button>
    </section>{message && <p role="status" className="hosted-muted">{message}</p>}
  </div></HostedDialog>;
}
