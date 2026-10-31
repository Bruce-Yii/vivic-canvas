import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { HarkBackdrop, HarkSurface } from "@/components/hark/HarkPrimitives";
import { ONLINE_BUILD } from "./mode";
import { cancelVoiceInput } from "@/ai/voiceInput";
import { cancelSpeech } from "@/ai/speech";
import "./online.css";
import { OnlineWorkspaceSuspended } from "./OnlineWorkspace";

let bootstrap: Promise<void> | undefined;
function connectSession() {
  return bootstrap ??= (async () => {
    const runtime = await fetch("/api/runtime", { cache: "no-store", signal: AbortSignal.timeout(10000) });
    if (!runtime.ok || (await runtime.json()).mode !== "online") throw new Error("online_unavailable");
    const session = await fetch("/api/online/session", { method: "POST", headers: { "content-type": "application/json" },
      body: "{}", cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(10000) });
    if (!session.ok) throw new Error("online_unavailable");
  })().finally(() => { bootstrap = undefined; });
}

/** Session cookies stay HttpOnly; a failed bootstrap never mounts the credential form. */
export function OnlineBoundary({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(!ONLINE_BUILD), [failed, setFailed] = useState(false), [retry, setRetry] = useState(0);
  const [connecting, setConnecting] = useState(ONLINE_BUILD);
  useEffect(() => { if (failed) { cancelVoiceInput(); cancelSpeech(); } }, [failed]);
  useEffect(() => {
    if (!ONLINE_BUILD) return;
    let active = true;
    void connectSession().then(() => { if (active) { setReady(true); setFailed(false); setConnecting(false); } }, () => { if (active) { setFailed(true); setConnecting(false); } });
    return () => { active = false; };
  }, [retry]);
  useEffect(() => {
    if (!ONLINE_BUILD || !ready) return;
    const controller = new AbortController();
    const check = async () => {
      try {
        const response = await fetch("/api/runtime", { cache: "no-store", signal: controller.signal });
        if (response.ok && (await response.json()).session === "missing" && !controller.signal.aborted) setFailed(true);
      } catch { /* Brief network failures are handled by the current request's UI. */ }
    };
    const timer = setInterval(() => void check(), 60000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [ready, retry]);
  return <>
    {ready && <OnlineWorkspaceSuspended.Provider value={failed || connecting}><div className="online-workspace-host" hidden={failed || connecting} inert={failed || connecting}>{children}</div></OnlineWorkspaceSuspended.Provider>}
    {(!ready || failed || connecting) && <main className="online-session-screen vh-hark" role="main">
      <HarkBackdrop />
      <HarkSurface className="online-session-card" as="section">
        <h1>{failed ? "重新连接 Vivic" : "正在连接 Vivic"}</h1>
        <p role="status">{failed ? "在线会话暂不可用或已结束。画布保留在此浏览器，重新连接后可再次配置 AI。" : "马上就好。"}</p>
        {failed && <Button onClick={() => { setConnecting(true); setFailed(false); setRetry(value => value + 1); }}>重新连接</Button>}
      </HarkSurface>
    </main>}
  </>;
}
