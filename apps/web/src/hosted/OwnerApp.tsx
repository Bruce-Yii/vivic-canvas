import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { HostedAuth } from "./HostedAuth";
import { hostedClient, type HostedSession } from "./client";
import { HarkBackdrop } from "@/components/hark/HarkPrimitives";
import { HostedAssetProvider } from "@/hostedAssets/HostedAssets";
import { HostedDefinitions } from "./HostedDefinitions";
import { getControlHost } from "@/sync/browserRuntime";
import { invalidateOwnerDB } from "./ownerDB";
import { setOwnerAccount } from "./ownerScope";
import { OnlineWorkspace } from "@/online/OnlineWorkspace";
import "./hosted.css";

const ControlApp = lazy(() => import("@/control/ControlApp").then(module => ({ default: module.ControlApp })));
const DisplayApp = lazy(() => import("@/display/DisplayApp").then(module => ({ default: module.DisplayApp })));

export function OwnerApp() {
  const [session, setSession] = useState<HostedSession | null>(null), [error, setError] = useState("");
  const [bootMounted, setBootMounted] = useState(true), [bootLeaving, setBootLeaving] = useState(false), [bootMinimumElapsed, setBootMinimumElapsed] = useState(false);
  const refresh = useCallback(async () => { const next = await hostedClient.session(); setSession(next); return next.authenticated; }, []);
  useEffect(() => { void refresh().catch(() => setError("连接暂不可用，请重新载入。")); }, [refresh]);
  useEffect(() => {
    const timer = window.setTimeout(() => setBootMinimumElapsed(true), 1200);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (!session || !bootMinimumElapsed) return;
    setBootLeaving(true);
    const timer = window.setTimeout(() => setBootMounted(false), 700);
    return () => window.clearTimeout(timer);
  }, [session, bootMinimumElapsed]);
  useEffect(() => {
    if (!session?.user) return;
    const account = session.user.id;
    const timer = setInterval(() => { void hostedClient.session().then(next => { if (!next.authenticated || next.user?.id !== account) window.location.reload(); }).catch(() => {}); }, 15000);
    return () => clearInterval(timer);
  }, [session]);
  const authenticated = Boolean(session?.authenticated && session.user);
  if (authenticated && session?.user) setOwnerAccount(session.user.id);
  const workspace = authenticated && session?.user
    ? <OwnerWorkspace key={session.user.id} />
    : null;
  return <>
    {!session ? null : authenticated && workspace
      ? (/^\/display(?:\/|$)/.test(window.location.pathname) ? workspace : <OnlineWorkspace>{workspace}</OnlineWorkspace>)
      : <div className="hosted-root vh-hark" data-theme="light" data-appearance="light"><HarkBackdrop /><HostedAuth onConnected={refresh} /></div>}
    {bootMounted && <div className="hosted-boot-screen" data-vivic-boot data-leaving={bootLeaving || undefined} role="status" aria-live="polite">
      <span>{error || "正在加载"}</span>
      {error && !session && <button type="button" onClick={() => window.location.reload()}>重新载入</button>}
    </div>}
  </>;
}

function OwnerWorkspace() {
  const [spaceId, setSpaceId] = useState(""), [error, setError] = useState("");
  const display = window.location.pathname === "/display";
  const pinned = new URLSearchParams(window.location.search).get("canvasId");
  useEffect(() => {
    if (display && pinned) { setSpaceId(pinned); return; }
    let unsubscribe = () => {}, alive = true;
    void getControlHost().then(host => { if (!alive) return; const update = () => setSpaceId(host.getSnapshot().activeCanvasId ?? ""); update(); unsubscribe = host.subscribe(update); }).catch(() => setError("云端画布读取失败，请重新载入后重试。"));
    return () => { alive = false; unsubscribe(); };
  }, [display, pinned]);
  const recovered = useCallback(() => { invalidateOwnerDB(); if (display) window.location.reload(); else void getControlHost().then(host => host.refreshFromStorage()); }, [display]);
  if (!spaceId) return <div className="hosted-boot-screen" role="status" aria-live="polite"><span>{error || "正在加载"}</span></div>;
  return <HostedDefinitions enabled><HostedAssetProvider spaceId={spaceId} onSnapshot={recovered}><Suspense fallback={<div className="hosted-boot-screen" role="status" aria-live="polite"><span>正在加载</span></div>}>{display ? <DisplayApp /> : <ControlApp />}</Suspense></HostedAssetProvider></HostedDefinitions>;
}
