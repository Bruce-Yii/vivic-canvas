import { useEffect, useState, useSyncExternalStore } from "react";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button";
import { HarkIcon } from "@/components/hark/HarkPrimitives";
import { canvasStore } from "@/state/canvasStore";
import type { ControlHost } from "@/sync/controlHost";
import { createVivicHostAdapter } from "@vivic/mobile-console-prototype/vivicHostAdapter";
import { createComputerConnector, type ConnectorState } from "@vivic/mobile-console-prototype/connector";
import { createOnlineHttpTransport } from "@vivic/mobile-console-prototype/transport";
import { ExtensionDefinitionRefSchema } from "@vivic/contracts";
import { extensionDefinitions } from "@/extensions/definitionStore";
import { loadBuiltinOfficeDefinitions, officePlannerKind } from "@/cards/office/builtinOfficePackages";
import { executeRemoteText } from "./executeRemoteText";
import { AndroidDownload } from "./AndroidDownload";
import { projectMobileSubcards } from "./projectSubcards";
import { createRemoteFileReader } from "@/files/remoteFiles";
import { createMobileImageProjection } from "./imageProjection";

const stopped: ConnectorState = { status: "stopped", pairCode: null, pairExpiresAt: null, expiresAt: null, controllers: [], error: null };
const subscribeNothing = () => () => {};
const getStopped = () => stopped;
/** Persistent owner connector. Hiding settings must not unmount this component. */
export function OnlineMobileControlSettings({ host, disabled, desktopBusy }: { host: ControlHost; disabled: boolean; desktopBusy(): boolean }) {
  const [connector, setConnector] = useState<ReturnType<typeof createComputerConnector> | null>(null);
  const state = useSyncExternalStore(connector?.subscribe ?? subscribeNothing, connector?.getSnapshot ?? getStopped);
  const [qr, setQr] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now);
  const running = Boolean(connector && !["stopped", "expired", "error"].includes(state.status));
  const pairCode = state.pairCode && (state.pairExpiresAt ?? 0) > now ? state.pairCode : null;
  const mobileUrl = `${window.location.origin}/remote/`;
  useEffect(() => () => connector?.stop(), [connector]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    let active = true; setQr("");
    if (pairCode) {
      const url = `${mobileUrl}#pair=${pairCode}&online=1`;
      void QRCode.toDataURL(url, { width: 220, margin: 2, errorCorrectionLevel: "M" }).then(value => { if (active) setQr(value); }).catch(() => { if (active) setError("二维码生成失败，可使用下方配对链接。"); });
    }
    return () => { active = false; };
  }, [pairCode, mobileUrl]);
  const start = async () => {
    setBusy(true); setError(null); connector?.stop(); setConnector(null);
    try {
      await Promise.all([loadBuiltinOfficeDefinitions(), extensionDefinitions.ready()]).catch(() => {});
      const images = createMobileImageProjection(host);
      const adapter = createVivicHostAdapter({ projectImages: images.projectImages, readImageChunk: images.readImageChunk,
        connectionEpoch: crypto.randomUUID(), computerName: "Vivic 电脑", shareCardPreviews: true,
        host: { ...host, getSnapshot: () => { const snapshot = host.getSnapshot(); return { ...snapshot, ready: snapshot.ready && !desktopBusy() }; },
          switchCanvas: id => { if (!desktopBusy()) host.switchCanvas(id); },
          setCardSurface: (cardId, surface, position, canvasId) => desktopBusy() ? { ok: false } : host.setCardSurface(cardId, surface, position, canvasId),
        setCardPinned: (...args) => desktopBusy() ? { ok: false } : host.setCardPinned(...args) },
        isOfficeDefinition: ref => { const parsed = ExtensionDefinitionRefSchema.safeParse(ref); return parsed.success && Boolean(officePlannerKind(extensionDefinitions.get(parsed.data))); },
        projectSubcards: projectMobileSubcards,
        readFileChunk: createRemoteFileReader(),
        readCards: () => canvasStore.getState().cards,
        subscribeCards: listener => { const cards = canvasStore.subscribe(listener), definitions = extensionDefinitions.subscribe(listener), pictures = images.subscribe(listener); return () => { cards(); definitions(); pictures(); }; },
        submitText: (text, context) => executeRemoteText(host, text, context, desktopBusy),
      });
      const next = createComputerConnector({ transport: createOnlineHttpTransport(`${window.location.origin}/api/online/mobile/owner`, "owner"),
        host: adapter, deviceId: crypto.randomUUID(), deviceName: "Vivic 电脑", accessKey: "online-cookie-owner-boundary" });
      setConnector(next); next.start();
    } catch { setError("连接暂不可用，请检查线上会话后重试。"); }
    finally { setBusy(false); }
  };
  return <section data-vivic-online-mobile-control>
    <p className="text-xs opacity-60">手机只连接当前电脑工作区。请保持电脑聊天页打开。</p>
    <div className="mt-3 flex flex-wrap gap-2">
      <AndroidDownload />
      {!running ? <Button size="sm" disabled={disabled || busy} onClick={() => void start()} data-vivic-mobile-start><HarkIcon name="link" />生成连接二维码</Button>
        : <><Button size="sm" variant="outline" onClick={() => { connector?.stop(); setConnector(null); }} data-vivic-mobile-stop>停止手机控制</Button>
          <Button size="sm" variant="ghost" disabled={state.status !== "connected"} onClick={() => connector?.rotatePairing()}>重新生成</Button></>}
    </div>
    {running && <p className="mt-2 text-xs" role="status">{state.status === "connected" ? state.controllers.length ? `已连接 ${state.controllers.length} 部手机` : "等待手机连接" : "正在连接"}</p>}
    {pairCode && <div className="mt-3"><p className="text-xs opacity-60">一次性配对 · {Math.max(0, Math.ceil(((state.pairExpiresAt ?? 0) - now) / 1000))} 秒后过期</p>
      {qr && <img src={qr} alt="手机控制一次性配对二维码" width={220} height={220} />}
      <output className="font-mono" data-vivic-mobile-pair-code>{pairCode}</output>
      <p className="mt-2 text-xs"><a href={`${mobileUrl}#pair=${pairCode}&online=1`} target="_blank" rel="noreferrer">打开手机配对页面</a></p></div>}
    {state.controllers.map((id, index) => <div className="mt-2 flex items-center gap-3" key={id}><span className="text-xs">手机 {index + 1}</span><Button size="sm" variant="ghost" onClick={() => connector?.revoke(id)}>撤销授权</Button></div>)}
    {(error || state.error) && <p className="mt-2 text-xs" role="alert">{error ?? state.error}</p>}
  </section>;
}
