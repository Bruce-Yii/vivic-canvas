import { useEffect, useRef, useState } from "react";
import { HarkIcon, HarkSurface, HarkTabs } from "@/components/hark/HarkPrimitives";
import { hostedClient, HostedApiError, errorMessage, isUnknownResult } from "./client";

export function HostedAuth({ onConnected }: { onConnected(): Promise<boolean | void> }) {
  const [initialPair] = useState(() => (new URLSearchParams(window.location.search).get("pair") ?? "").trim().slice(0, 128));
  const [mode, setMode] = useState<"login" | "register" | "pair">(initialPair ? "pair" : "login");
  const [username, setUsername] = useState(""), [password, setPassword] = useState(""), [invite, setInvite] = useState(""), [code, setCode] = useState(initialPair);
  const [busy, setBusy] = useState(false), [loadingMessage, setLoadingMessage] = useState(""), [error, setError] = useState("");
  const [recoverable, setRecoverable] = useState(false), working = useRef(false);
  useEffect(() => {
    if (!initialPair) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("pair");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [initialPair]);
  const checkSession = async () => { const connected = await onConnected(); if (connected === false) throw new HostedApiError(401, "session-unconfirmed", "当前会话尚未确认，请检查连接或重新登录。"); };
  return <main className="hosted-auth"><HarkSurface as="section" className="hosted-auth-card" aria-busy={busy || undefined} inert={busy || undefined}><span className="hosted-brand">Vivic</span><h1>你的 Space，随时继续</h1>
    <HarkTabs label="连接方式" value={mode} tabs={[{ id: "login", label: "登录" }, { id: "register", label: "邀请码注册" }, { id: "pair", label: "设备码" }]} onChange={value => { setMode(value); setPassword(""); setInvite(""); setCode(""); setError(""); setRecoverable(false); }} />
    <form className="hosted-form" onSubmit={event => { event.preventDefault(); if (working.current) return; working.current = true; setBusy(true); setLoadingMessage(mode === "pair" ? "正在授权设备…" : mode === "register" ? "正在创建账号…" : "正在登录…"); setError(""); setRecoverable(false); const credential = password; setPassword("");
      const operation = mode === "pair" ? hostedClient.claim(code.trim()) : mode === "register" ? hostedClient.register(invite.trim(), username.trim(), credential) : hostedClient.login(username.trim(), credential);
      void operation.then(checkSession).catch(async error => { if (error instanceof HostedApiError && error.code === "already-authenticated") { try { await checkSession(); return; } catch (failure) { setError(errorMessage(failure)); setRecoverable(true); return; } } setError(errorMessage(error)); setRecoverable(isUnknownResult(error) || error instanceof HostedApiError && error.code === "session-unconfirmed"); }).finally(() => { working.current = false; setBusy(false); setLoadingMessage(""); }); }}>
      {mode !== "pair" ? <><label>用户名<input autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} required minLength={3} maxLength={40} pattern="[a-z0-9_.\-]{3,40}" title="3–40 位小写字母、数字、下划线、点或短横线" disabled={busy} /></label>
        <label>密码<input type="password" autoComplete={mode === "register" ? "new-password" : "current-password"} value={password} onChange={event => setPassword(event.target.value)} required minLength={12} maxLength={256} disabled={busy} /></label>
        {mode === "register" && <label>邀请码<input type="password" autoComplete="off" value={invite} onChange={event => setInvite(event.target.value)} required maxLength={256} disabled={busy} /></label>}</>
        : <><label>设备码<input autoComplete="off" value={code} onChange={event => setCode(event.target.value)} maxLength={128} required disabled={busy} /></label><p className="hosted-muted">在已登录设备的「设置 → 设备授权」生成设备码。继续即授权此设备访问同一账号的 Space。</p></>}
      {error && <p className="hosted-error" role="alert">{error}</p>}
      {recoverable && <button type="button" className="hosted-quiet" disabled={busy} onClick={() => { if (working.current) return; working.current = true; setBusy(true); setLoadingMessage("正在检查当前会话…"); void checkSession().then(() => { setError(""); setRecoverable(false); }).catch(error => { setError(errorMessage(error)); setRecoverable(true); }).finally(() => { working.current = false; setBusy(false); setLoadingMessage(""); }); }}>检查当前会话</button>}
      <button className="hosted-primary" type="submit" disabled={busy || (mode === "pair" ? !code.trim() : !username.trim() || !password || (mode === "register" && !invite.trim()))}>{busy ? "正在连接…" : mode === "pair" ? "授权此设备" : mode === "register" ? "创建账号" : "登录"}<HarkIcon name="next" /></button>
    </form><p className="hosted-muted">Space 保存在服务器。电脑关闭后，手机仍可继续。</p>
  </HarkSurface>{busy && <div className="hosted-auth-loading" role="status" aria-live="polite"><div className="hosted-auth-loading-card"><span className="hosted-auth-spinner" aria-hidden="true" /><span>{loadingMessage}</span></div></div>}</main>;
}
