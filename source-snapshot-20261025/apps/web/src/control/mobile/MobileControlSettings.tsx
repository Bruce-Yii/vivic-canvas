import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button";
import { canvasStore } from "@/state/canvasStore";
import type { ControlHost } from "@/sync/controlHost";
import { createVivicHostAdapter } from "@vivic/mobile-console-prototype/vivicHostAdapter";
import { createComputerConnector, type ConnectorState } from "@vivic/mobile-console-prototype/connector";
import { createWebSocketTransport } from "@vivic/mobile-console-prototype/transport";
import { executeRemoteText } from "./executeRemoteText";
import { ExtensionDefinitionRefSchema } from "@vivic/contracts";
import { extensionDefinitions } from "@/extensions/definitionStore";
import { loadBuiltinOfficeDefinitions, officePlannerKind } from "@/cards/office/builtinOfficePackages";
import { AndroidDownload } from "./AndroidDownload";
import { projectMobileSubcards } from "./projectSubcards";
import { createRemoteFileReader } from "@/files/remoteFiles";
import { createMobileImageProjection } from "./imageProjection";

const stopped: ConnectorState = { status: "stopped", pairCode: null, pairExpiresAt: null, expiresAt: null, controllers: [], error: null };
const subscribeNothing = () => () => {};
const getStopped = () => stopped;
const labels: Record<ConnectorState["status"], string> = { stopped: "未开启", connecting: "正在连接", connected: "已连接中继", offline: "正在重连", expired: "会话已结束", error: "连接失败" };
export function MobileControlSettings({ host, disabled, desktopBusy }: { host: ControlHost; disabled: boolean; desktopBusy(): boolean }) {
  const [connector, setConnector] = useState<ReturnType<typeof createComputerConnector> | null>(null);
  const state = useSyncExternalStore(connector?.subscribe ?? subscribeNothing, connector?.getSnapshot ?? getStopped);
  const [mobileUrl, setMobileUrl] = useState("");
  const [qr, setQr] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [ownerSlot] = useState(() => {
    const key = "vivic.mobile.owner-slot.v1";
    // This is a public tab identifier. No relay token/code or model credential is stored.
    try { const saved = sessionStorage.getItem(key); if (saved && /^[a-f0-9-]{36}$/i.test(saved)) return saved;
      const id = crypto.randomUUID(); sessionStorage.setItem(key, id); return id; } catch { return crypto.randomUUID(); }
  });
  const current = useRef<ReturnType<typeof createComputerConnector> | null>(null);
  const attempt = useRef(0), starting = useRef(false);
  const running = connector && !["stopped", "expired", "error"].includes(state.status);
  const pairCode = state.pairCode && (state.pairExpiresAt ?? 0) > now ? state.pairCode : null;
  useEffect(() => {
    if (disabled) return;
    void start(true);
    const recover = () => { if (document.visibilityState === "visible" && !current.current) void start(true); };
    window.addEventListener("online", recover); window.addEventListener("pageshow", recover); document.addEventListener("visibilitychange", recover);
    const detach = () => { ++attempt.current; current.current?.detach(); current.current = null; };
    window.addEventListener("pagehide", detach);
    return () => { detach(); starting.current = false; window.removeEventListener("pagehide", detach); window.removeEventListener("pageshow", recover); window.removeEventListener("online", recover); document.removeEventListener("visibilitychange", recover); };
  }, [host, disabled]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    let active = true; setQr("");
    if (pairCode && mobileUrl) {
      const url = new URL(mobileUrl); url.hash = new URLSearchParams({ pair: pairCode }).toString();
      void QRCode.toDataURL(url.href, { width: 240, margin: 2, errorCorrectionLevel: "M" }).then(value => { if (active) setQr(value); });
    }
    return () => { active = false; };
  }, [pairCode, mobileUrl]);
  const start = async (resumeOnly = false) => {
    if (starting.current || resumeOnly && current.current) return;
    starting.current = true; const revision = ++attempt.current;
    setBusy(true); setError(null);
    if (!resumeOnly) { current.current?.stop(); current.current = null; setConnector(null); }
    try {
      // A custom extension sharing an Office ID must never select its preview.
      await Promise.all([loadBuiltinOfficeDefinitions(), extensionDefinitions.ready()]).catch(() => {});
      const response = await fetch(`/api/mobile/session${resumeOnly ? "/resume" : ""}`, { method: "POST", cache: "no-store",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ ownerSlot }), signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error("relay_unavailable");
      const body = await response.json();
      if (revision !== attempt.current) return;
      const session = (resumeOnly ? body.session : body) as { relayUrl: string; mobileUrl: string; deviceId: string; token: string } | null;
      if (!session) {
        try { if (sessionStorage.getItem("vivic.mobile.was-active") === "1") setError("本机服务已重启或会话已结束，请重新扫码连接手机。"); } catch {}
        return;
      }
      const images = createMobileImageProjection(host);
      const adapter = createVivicHostAdapter({ projectImages: images.projectImages, readImageChunk: images.readImageChunk,
        connectionEpoch: crypto.randomUUID(), computerName: "Vivic 电脑", shareCardPreviews: true, host: { ...host,
        getSnapshot: () => { const snapshot = host.getSnapshot(); return { ...snapshot, ready: snapshot.ready && !desktopBusy() }; },
        switchCanvas: id => { if (!desktopBusy()) host.switchCanvas(id); },
        setCardSurface: (cardId, surface, position, canvasId) => desktopBusy() ? { ok: false } : host.setCardSurface(cardId, surface, position, canvasId),
        setCardPinned: (...args) => desktopBusy() ? { ok: false } : host.setCardPinned(...args) },
        isOfficeDefinition: ref => {
          const parsed = ExtensionDefinitionRefSchema.safeParse(ref);
          return parsed.success && Boolean(officePlannerKind(extensionDefinitions.get(parsed.data)));
        },
        projectSubcards: projectMobileSubcards,
        readFileChunk: createRemoteFileReader(),
        readCards: () => canvasStore.getState().cards,
        subscribeCards: listener => {
          const cards = canvasStore.subscribe(listener), definitions = extensionDefinitions.subscribe(listener), pictures = images.subscribe(listener);
          return () => { cards(); definitions(); pictures(); };
        },
        submitText: (text, context) => executeRemoteText(host, text, context, desktopBusy) });
      const next = createComputerConnector({ transport: createWebSocketTransport(session.relayUrl), host: adapter,
        deviceId: session.deviceId, deviceName: "Vivic 电脑", token: session.token });
      current.current = next; setMobileUrl(session.mobileUrl); setConnector(next); next.start();
      try { sessionStorage.setItem("vivic.mobile.was-active", "1"); } catch {}
    } catch { if (revision === attempt.current) setError("手机连接未恢复，请检查本机服务和中继后重试。必要时重新扫码。"); }
    finally { if (revision === attempt.current) { starting.current = false; setBusy(false); } }
  };
  const stop = async () => {
    ++attempt.current; current.current?.stop(); current.current = null; setConnector(null); setBusy(true);
    try {
      sessionStorage.removeItem("vivic.mobile.was-active");
      const response = await fetch("/api/mobile/session/end", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ownerSlot }), signal: AbortSignal.timeout(8000) });
      if (!response.ok) setError("手机控制已停止；中继撤权未确认，请检查连接。");
    } catch { setError("手机控制已停止；中继撤权未确认，请检查连接。"); }
    finally { setBusy(false); }
  };
  return <section className="rounded-xl border border-neutral-200 bg-white p-4" data-vivic-mobile-control>
    <h2 className="text-sm font-semibold">扫码连接手机</h2>
    <p className="mt-2 text-xs text-neutral-500">先在电脑连接模型，再扫码。手机可聊天，并查看当前画布的卡片内容。</p>
    {running && <p className="mt-2 text-xs" role="status">{state.status === "connected" ? state.controllers.length ? `已连接 ${state.controllers.length} 部手机` : "等待扫码" : labels[state.status]}</p>}
    <div className="mt-3 flex flex-wrap gap-2">
      <AndroidDownload />
      {!running ? <Button size="sm" disabled={disabled || busy} onClick={() => void start()} data-vivic-mobile-start>生成连接二维码</Button>
        : <><Button size="sm" variant="outline" disabled={busy} onClick={() => void stop()} data-vivic-mobile-stop>停止手机控制</Button>
          <Button size="sm" variant="secondary" disabled={state.status !== "connected"} onClick={() => connector?.rotatePairing()}>生成新配对码</Button></>}
    </div>
    {pairCode && <div className="mt-4"><p className="text-xs">扫码连接，仅可使用一次 · {Math.max(0, Math.ceil(((state.pairExpiresAt ?? 0) - now) / 1000))} 秒后过期</p>
      {qr && <img src={qr} alt="手机控制一次性配对二维码" width={240} height={240} />}
      <output className="font-mono text-lg" data-vivic-mobile-pair-code>{pairCode}</output>
      <p className="text-xs text-neutral-500">也可在手机打开 {mobileUrl}，手动输入配对码。</p></div>}
    {state.controllers.map((id, index) => <div className="mt-2 flex items-center gap-3" key={id}><span className="text-xs">手机 {index + 1}</span><Button size="sm" variant="outline" onClick={() => connector?.revoke(id)}>撤销授权</Button></div>)}
    {(error || state.error) && <p className="mt-2 text-xs text-amber-700" role="alert">{error ?? state.error}</p>}
  </section>;
}
