import { useEffect, useRef, useState } from "react";
import { HarkBackdrop, HarkIcon, HarkSurface } from "@/components/hark/HarkPrimitives";
import { hostedAndroidBridge, parseServiceOrigin } from "./origin";
import "./bootstrap.css";

/** Immutable APK bootstrap. The authenticated UI is loaded from the user-confirmed
 * service; this entry does not import App, browser owners or the old remote UI. */
export function HostedBootstrap() {
  const [input, setInput] = useState(""), [confirmed, setConfirmed] = useState<string | null>(null), [message, setMessage] = useState(""), [connecting, setConnecting] = useState(false);
  const inFlight = useRef(false), bridge = hostedAndroidBridge();
  useEffect(() => {
    const received = (event: Event) => { const detail = (event as CustomEvent<{ ok?: unknown; error?: unknown }>).detail;
      if (!detail || typeof detail.ok !== "boolean") return;
      inFlight.current = false; setConnecting(false); setMessage(detail.ok ? "正在打开你的 Space…" : typeof detail.error === "string" ? detail.error.slice(0, 240) : "连接未完成，请重新确认服务地址。");
    };
    window.addEventListener("vivic:space-connect-result", received);
    // Listen first, then read retained native state: either side may finish mounting first.
    try { const error = bridge?.getConnectionError?.(); if (typeof error === "string" && error.trim()) setMessage(error.slice(0, 240)); }
    catch { /* Older native packages may not expose the optional diagnostics getter. Connecting remains available. */ }
    return () => window.removeEventListener("vivic:space-connect-result", received);
  }, [bridge]);
  const connect = () => {
    if (!confirmed || !bridge || inFlight.current) return;
    inFlight.current = true; setConnecting(true); setMessage("请在系统窗口确认服务地址。");
    try { bridge.connectSpace(confirmed); }
    catch { inFlight.current = false; setConnecting(false); setMessage("未能打开连接确认，请重试。"); }
  };
  return <main className="hosted-bootstrap vh-hark" data-theme="light"><HarkBackdrop theme="light" /><HarkSurface as="section" className="hosted-bootstrap-card">
    <span className="hosted-bootstrap-brand">Vivic</span><h1>连接你的 Space</h1>
    {!confirmed ? <form onSubmit={event => { event.preventDefault(); setMessage(""); try { setConfirmed(parseServiceOrigin(input)); } catch (error) { setMessage(error instanceof Error ? error.message : "服务地址无效。"); } }}>
      <label htmlFor="hosted-service-origin">服务地址</label><input id="hosted-service-origin" type="url" inputMode="url" value={input} onChange={event => setInput(event.target.value)} placeholder="https://space.example.com" autoCapitalize="none" autoCorrect="off" autoComplete="url" spellCheck={false} required aria-describedby="hosted-service-hint" />
      <p id="hosted-service-hint" className="hosted-bootstrap-hint">输入你使用的 Vivic 服务域名。账号、设备码和模型连接在服务页面填写。</p><button className="hosted-bootstrap-primary" type="submit" disabled={!input.trim()}>检查地址<HarkIcon name="next" /></button>
    </form> : <div className="hosted-bootstrap-confirm"><p className="hosted-bootstrap-hint">将连接到这个服务</p><strong>{confirmed}</strong>
      {bridge ? <button className="hosted-bootstrap-primary" disabled={connecting} onClick={connect}>{connecting ? "等待确认…" : "确认并连接"}<HarkIcon name="link" /></button>
        : <><p className="hosted-bootstrap-hint">当前没有 App 连接桥。网页版请直接打开服务地址。</p><a className="hosted-bootstrap-primary" href={`${confirmed}/remote/`} target="_blank" rel="noopener noreferrer">打开服务页面<HarkIcon name="link-out" /></a></>}
      <button className="hosted-bootstrap-quiet" disabled={connecting} onClick={() => { setConfirmed(null); setMessage(""); }}>修改地址</button>
    </div>}
    {message && <p className="hosted-bootstrap-message" role="status">{message}</p>}
  </HarkSurface></main>;
}
