import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent, type TouchEvent } from "react";
import { HarkBackdrop, HarkIcon, HarkSurface } from "@/components/hark/HarkPrimitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createMobileClient, type MobileClient, type MobileState } from "@vivic/mobile-console-prototype/client";
import type { CardSnapshot, Operation } from "@vivic/mobile-console-prototype/protocol";
import { createOnlineHttpTransport, createWebSocketTransport, validateRelayUrl } from "@vivic/mobile-console-prototype/transport";
import { NATIVE_ORIGIN, PRODUCTION_RELAY_URL, parseControllerPairingInput, type ControllerPairing } from "./pairing";
import { MobileCardPreview } from "./MobileCardPreview";
import { MobileSubcards } from "./MobileSubcards";
import { MobileFileSheet } from "./MobileFileSheet";
import { PairingScanner } from "./PairingScanner";
import "./mobile.css";

type MobilePage = "chat" | "space";
const connectionLabels: Record<MobileState["status"], string> = {
  unpaired: "尚未配对", connecting: "正在连接", connected: "已连接", reconnecting: "正在重连",
  offline: "连接已断开", expired: "配对已过期", revoked: "授权已撤销", error: "连接遇到问题",
};
const resultLabels = {
  sending: "正在发送", accepted: "中继已接收，等待电脑确认", executing: "电脑正在执行", succeeded: "电脑已执行",
  rejected: "电脑未执行", cancelled: "已取消", unknown: "执行结果未知",
};
const operationLabel = (operation: Operation) => operation.kind === "text.submit" ? operation.text
  : operation.kind === "canvas.switch" ? "切换电脑活动画布" : operation.kind === "card.surface" ? operation.surface === "user" ? "将卡片移到聊天" : "将卡片移回 Space" : operation.pinned ? "固定卡片" : "取消固定卡片";
const developmentRelayEnabled = import.meta.env.DEV && ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
/** Production always uses the paired Vivic service. Only loopback development exposes an override. */
export const defaultRelayUrl = () => /^\/remote\/(?:index\.html)?$/.test(window.location.pathname) ? `${window.location.origin}/api/online/mobile/phone`
  : developmentRelayEnabled ? "ws://127.0.0.1:8791/relay" : PRODUCTION_RELAY_URL;

export interface MobileConsoleProps {
  /** Inject only in isolated tests; the normal entry always uses the real relay client. */
  client?: MobileClient;
  initialRelayUrl?: string;
}
// Capture and erase once, outside React's repeatable render/initializer lifecycle.
const scannedPairingCode = (() => {
  if (!window.location.hash) return null;
  const value = window.location.href;
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  try { return parseControllerPairingInput(value); } catch { return null; }
})();

/** Two remote views only: the computer owns configuration, execution and saving. */
export function MobileConsole({ client: suppliedClient, initialRelayUrl }: MobileConsoleProps) {
  const [client] = useState(() => suppliedClient ?? createMobileClient({ name: window.location.origin === NATIVE_ORIGIN ? "Vivic Android" : "手机浏览器",
    transportFactory: url => /^https?:/.test(url) ? createOnlineHttpTransport(url, "phone") : createWebSocketTransport(url) }));
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const [relayUrl, setRelayUrl] = useState(initialRelayUrl ?? defaultRelayUrl);
  const [pairCode, setPairCode] = useState("");
  const [draft, setDraft] = useState("");
  const [page, setPage] = useState<MobilePage>("chat");
  const [settings, setSettings] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [largeText, setLargeText] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [scanner, setScanner] = useState(false);
  const [scanCandidate, setScanCandidate] = useState<ControllerPairing | null>(null);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [disconnectedByUser, setDisconnectedByUser] = useState(false);
  const [subcardSelection, setSubcardSelection] = useState<{ cardId: string; canvasId: string | null } | null>(null);
  const [fileSelection, setFileSelection] = useState<{ cardId: string; canvasId: string | null } | null>(null);
  const [portal, setPortal] = useState<{ requestId: string; cardId: string; surface: "user" | "display"; canvasId: string | null } | null>(null);
  const viewportBaseline = useRef({ height: window.visualViewport?.height ?? window.innerHeight, width: window.visualViewport?.width ?? window.innerWidth });
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const settingsDialog = useRef<HTMLDialogElement>(null);
  const chatScroll = useRef<HTMLDivElement>(null);
  const spaceScroll = useRef<HTMLDivElement>(null);
  const pageScroll = useRef({ chat: 0, space: 0 });
  const stickToMessages = useRef(true);
  const composing = useRef(false);
  const swipe = useRef<{ id: number; x: number; y: number; started: number } | null>(null);
  const stage = state.snapshot;
  const online = state.status === "connected" && Boolean(stage?.ownerAvailable);
  const working = state.requests.some(request => ["sending", "accepted", "executing"].includes(request.status));
  const uncertain = state.requests.some(request => request.status === "unknown");
  const connecting = state.status === "connecting" || state.status === "reconnecting";
  const paired = Boolean(stage) && !["unpaired", "revoked", "expired"].includes(state.status);
  const spaceCards = stage?.cards.filter(card => card.surface !== "user") ?? [];
  const chatCards = stage?.cards.filter(card => card.surface === "user") ?? [];
  const portalAllowed = state.permissions?.includes("card.surface") === true;
  const portalRequest = state.requests.find(request => request.requestId === portal?.requestId);
  const subcardCard = paired && subcardSelection?.canvasId === stage?.activeCanvasId ? stage?.cards.find(card => card.id === subcardSelection?.cardId && card.subcards?.length) : undefined;
  const fileCard = paired && fileSelection?.canvasId === stage?.activeCanvasId ? stage?.cards.find(card => card.id === fileSelection?.cardId && card.file) : undefined;
  const spacePartial = Boolean(stage?.cardsTruncated || (stage?.cardCount ?? 0) > (stage?.cards.length ?? 0));
  const statusLabel = state.status === "connected" && !stage?.ownerAvailable ? "电脑控制页不可用" : connectionLabels[state.status];

  useEffect(() => {
    if (!portal || !portalRequest) return;
    if (!paired || portal.canvasId !== stage?.activeCanvasId) { setPortal(null); return; }
    if (["rejected", "cancelled"].includes(portalRequest.status)) { setLocalError(portalRequest.message); setPortal(null); return; }
    if (portalRequest.status === "succeeded" && stage?.cards.some(card => card.id === portal.cardId && (card.surface ?? "display") === portal.surface)) {
      setPage(portal.surface === "user" ? "chat" : "space"); setPortal(null);
    }
  }, [portal, portalRequest, paired, stage]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(media.matches);
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const viewport = window.visualViewport;
    const update = () => {
      const height = viewport?.height ?? window.innerHeight, width = viewport?.width ?? window.innerWidth;
      if (Math.abs(width - viewportBaseline.current.width) > 80) viewportBaseline.current = { height, width };
      else viewportBaseline.current.height = Math.max(viewportBaseline.current.height, height);
      document.documentElement.style.setProperty("--mobile-viewport-height", `${height}px`);
      const editing = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement;
      setKeyboardOpen(editing && viewportBaseline.current.height - height > 100);
    };
    update(); viewport?.addEventListener("resize", update); window.addEventListener("resize", update);
    document.addEventListener("focusin", update); document.addEventListener("focusout", update);
    return () => { viewport?.removeEventListener("resize", update); window.removeEventListener("resize", update); document.removeEventListener("focusin", update); document.removeEventListener("focusout", update); document.documentElement.style.removeProperty("--mobile-viewport-height"); };
  }, []);
  useEffect(() => {
    if (keyboardOpen) requestAnimationFrame(() => document.activeElement?.scrollIntoView?.({ block: "nearest" }));
  }, [keyboardOpen]);
  useEffect(() => {
    const resize = () => {
      const field = composerInput.current;
      if (!field || page !== "chat") return;
      field.style.height = "48px";
      field.style.height = `${Math.max(48, Math.min(219, field.scrollHeight))}px`;
      field.style.overflowY = field.scrollHeight > 219 ? "auto" : "hidden";
    };
    resize(); window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [draft, page, paired, largeText]);
  useEffect(() => {
    const recover = () => { if (disconnectedByUser) return; if (!document.hidden && state.status === "offline") client.reconnect(); else if (!document.hidden && state.status === "connected") client.refresh(); };
    window.addEventListener("online", recover); window.addEventListener("pageshow", recover); document.addEventListener("visibilitychange", recover);
    return () => { window.removeEventListener("online", recover); window.removeEventListener("pageshow", recover); document.removeEventListener("visibilitychange", recover); };
  }, [client, state.status, disconnectedByUser]);
  useLayoutEffect(() => {
    const panel = page === "chat" ? chatScroll.current : spaceScroll.current;
    if (panel) panel.scrollTop = pageScroll.current[page];
  }, [page]);
  useEffect(() => {
    if (page !== "chat" || !stickToMessages.current || !chatScroll.current) return;
    const panel = chatScroll.current;
    panel.scrollTo?.({ top: panel.scrollHeight, behavior: reducedMotion ? "instant" : "smooth" });
  }, [state.requests, page, reducedMotion]);
  useEffect(() => {
    if (!settings) return;
    const focused = document.activeElement as HTMLElement | null;
    settingsDialog.current?.showModal?.();
    return () => focused?.focus();
  }, [settings]);
  useEffect(() => () => client.disconnect(), [client]);
  useEffect(() => {
    const back = (event: Event) => {
      if (fileCard) { setFileSelection(null); event.preventDefault(); }
      else if (subcardCard) { setSubcardSelection(null); event.preventDefault(); }
      else if (scanner) { setScanner(false); event.preventDefault(); }
      else if (scanCandidate) { setScanCandidate(null); event.preventDefault(); }
      else if (confirmRevoke) { setConfirmRevoke(false); event.preventDefault(); }
      else if (settings) { setSettings(false); event.preventDefault(); }
      else if (page === "space") { setPage("chat"); event.preventDefault(); }
    };
    window.addEventListener("vivic:native-back", back);
    return () => window.removeEventListener("vivic:native-back", back);
  }, [scanner, scanCandidate, confirmRevoke, settings, page, subcardCard, fileCard]);
  useEffect(() => {
    if (scannedPairingCode) { try { client.pair(scannedPairingCode.transportUrl ?? initialRelayUrl ?? defaultRelayUrl(), scannedPairingCode.code); } catch { setLocalError("配对码已过期或电脑不可用，请在电脑生成新码。"); } }
  }, [client, initialRelayUrl]);

  const connect = (code: string, endpoint?: string) => {
    setLocalError(null); setScanCandidate(null); setPairCode(""); setDisconnectedByUser(false); setPage("chat");
    try { const selected = endpoint ?? relayUrl.trim(); client.pair(/^https?:/.test(selected) ? selected : validateRelayUrl(selected), code); }
    catch (error) { setLocalError(error instanceof Error ? error.message : "连接失败，请在电脑重新获取配对码。"); }
  };
  const pair = (event: FormEvent) => {
    event.preventDefault(); setLocalError(null);
    try {
      const candidate = parseControllerPairingInput(pairCode);
      if (/^https?:/i.test(pairCode.trim())) { setScanCandidate(candidate); setPairCode(""); }
      else connect(candidate.code, candidate.transportUrl);
    } catch (error) { setLocalError(error instanceof Error ? error.message : "配对码无效"); }
  };
  const scanned = useCallback((value: string) => {
    setScanner(false); setLocalError(null);
    try { setScanCandidate(parseControllerPairingInput(value)); }
    catch (error) { setLocalError(error instanceof Error ? error.message : "配对二维码无效"); }
  }, []);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !online || working || uncertain || composing.current) return;
    stickToMessages.current = true;
    const id = client.submit({ kind: "text.submit", text });
    if (id) { setDraft(""); setLocalError(null); }
    else setLocalError("未发送，请先确认电脑在线。");
  };
  const retry = (operation: Operation) => { if (online && !working && !uncertain) client.submit(operation); };
  const switchPage = (next: MobilePage) => {
    if (next === page) return;
    const panel = page === "chat" ? chatScroll.current : spaceScroll.current;
    if (panel) pageScroll.current[page] = panel.scrollTop;
    swipe.current = null; setPage(next);
  };
  const startSwipe = (event: TouchEvent<HTMLDivElement>) => {
    swipe.current = null;
    if (!paired || settings || scanner || scanCandidate || subcardCard || fileCard || event.touches.length !== 1) return;
    if (!(event.target instanceof Element) || event.target.closest("input,textarea,select,button,a,dialog,pre,table,[contenteditable],[data-mobile-swipe-block],.mobile-card-preview-table,.recharts-wrapper,[role=img]")) return;
    const point = event.touches[0]!;
    swipe.current = { id: point.identifier, x: point.clientX, y: point.clientY, started: Date.now() };
  };
  const moveSwipe = (event: TouchEvent<HTMLDivElement>) => {
    const start = swipe.current;
    if (!start || event.touches.length !== 1) { swipe.current = null; return; }
    const point = event.touches[0]!;
    if (point.identifier !== start.id) { swipe.current = null; return; }
    const dx = point.clientX - start.x, dy = point.clientY - start.y;
    if (Math.abs(dy) > 12 && Math.abs(dy) >= Math.abs(dx)) swipe.current = null;
  };
  const endSwipe = (event: TouchEvent<HTMLDivElement>) => {
    const start = swipe.current; swipe.current = null;
    if (!start || settings || scanner || scanCandidate || subcardCard || fileCard || event.touches.length) return;
    const point = Array.from(event.changedTouches).find(touch => touch.identifier === start.id);
    if (!point) return;
    const dx = point.clientX - start.x, dy = point.clientY - start.y;
    if (Date.now() - start.started > 900 || Math.abs(dx) < 64 || Math.abs(dx) < Math.abs(dy) * 1.5 || Math.abs(dy) > 64) return;
    if (page === "chat" && dx > 0) switchPage("space");
    else if (page === "space" && dx < 0) switchPage("chat");
  };
  const reconnect = () => {
    setDisconnectedByUser(false);
    if (state.status === "connected") client.refresh(); else client.reconnect();
  };
  const closeSettings = () => { setConfirmRevoke(false); setSettings(false); };
  const moveCard = (card: CardSnapshot) => {
    if (!online || working || uncertain || !portalAllowed) return;
    const surface = card.surface === "user" ? "display" : "user";
    const requestId = client.submit({ kind: "card.surface", cardId: card.id, surface });
    if (requestId) { setPortal({ requestId, cardId: card.id, surface, canvasId: stage?.activeCanvasId ?? null }); setLocalError(null); }
    else setLocalError("未移动，请同步电脑状态后重试。");
  };
  const renderCard = (card: CardSnapshot) => <li key={card.id}><HarkSurface as="article" className="mobile-space-card" data-mobile-card-id={card.id} data-mobile-card-surface={card.surface ?? "display"}
    onClick={event => { if (card.file && state.permissions?.includes("file.read") && client.readFile && !(event.target as Element).closest("button,a,input,select")) setFileSelection({ cardId: card.id, canvasId: stage?.activeCanvasId ?? null }); }}>
    <MobileCardPreview card={card} client={client} online={online} action={<div className="mobile-card-controls">
      {Boolean(card.subcards?.length) && <Button className="mobile-card-subcards" variant="ghost" size="icon" aria-label={`查看子卡片：${card.title || "未命名卡片"}`} onClick={() => setSubcardSelection({ cardId: card.id, canvasId: stage?.activeCanvasId ?? null })}><HarkIcon name="chat" size={16} /><span>{card.subcards!.length}</span></Button>}
      <Button className="mobile-card-pin" variant="ghost" size="icon" disabled={!online || working || uncertain} aria-pressed={card.pinned} title={card.pinned ? "取消固定" : "固定"} aria-label={`${card.pinned ? "取消固定" : "固定"} ${card.title || "未命名卡片"}`} onClick={() => client.submit({ kind: "card.pin", cardId: card.id, pinned: !card.pinned })}><HarkIcon name="pin" size={16} /></Button>
      {portalAllowed && <Button className="mobile-card-portal" variant="ghost" size="icon" disabled={!online || working || uncertain} title={card.surface === "user" ? "移回 Space" : "移到聊天"} aria-label={`${card.surface === "user" ? "移回 Space" : "移到聊天"}：${card.title || "未命名卡片"}`} onClick={() => moveCard(card)}><HarkIcon name={card.surface === "user" ? "card" : "chat"} size={17} /></Button>}
    </div>} />
    {card.file && state.permissions?.includes("file.read") && client.readFile && <Button className="mobile-file-open" variant="ghost" size="sm" onClick={() => setFileSelection({ cardId: card.id, canvasId: stage?.activeCanvasId ?? null })}>打开文件</Button>}
  </HarkSurface></li>;

  return <main className={`mobile-console vh-hark ${theme === "dark" ? "dark" : ""}`} data-mobile-theme={theme} data-hark-theme={theme} data-large-text={largeText} data-mobile-keyboard={keyboardOpen} data-mobile-page={paired ? page : "pair"}>
    <HarkBackdrop theme={theme} className="mobile-atmosphere" />
    <div className="mobile-shell">
      <header className={`mobile-header${paired ? " mobile-header-paired" : ""}`}>
        {paired ? <span aria-hidden="true" /> : <div className="mobile-wordmark" aria-label="Vivic">vivic</div>}
        {paired && <nav className="mobile-page-tabs" aria-label="手机主页面" role="tablist" onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === "Home" ? "chat" : event.key === "End" ? "space" : page === "chat" ? "space" : "chat";
          switchPage(next); document.getElementById(`mobile-tab-${next}`)?.focus();
        }}>
          <button id="mobile-tab-chat" type="button" role="tab" aria-selected={page === "chat"} aria-controls="mobile-chat" tabIndex={page === "chat" ? 0 : -1} onClick={() => switchPage("chat")}>聊天</button>
          <button id="mobile-tab-space" type="button" role="tab" aria-selected={page === "space"} aria-controls="mobile-space" tabIndex={page === "space" ? 0 : -1} onClick={() => switchPage("space")}>Space</button>
        </nav>}
        <Button variant="ghost" size="icon" className="mobile-icon-button" aria-label="打开设置" onClick={() => setSettings(true)}><HarkIcon name="gear" size={20} /></Button>
      </header>
      {(localError || state.error) && <div role="alert" className="mobile-alert"><HarkIcon name="info" size={18} /><p>{localError ?? state.error}</p></div>}
      {paired ? <>
        {!online && <div className="mobile-context" aria-label="连接状态" aria-live="polite"><span className="mobile-status-dot" /><span>{statusLabel}</span></div>}
        {page === "space" && portalRequest && <div className="mobile-portal-status" role="status"><p>{portalRequest.message}</p>{portalRequest.status === "unknown" && <Button variant="ghost" disabled={!online} onClick={() => client.query(portalRequest.requestId)}>查询执行结果</Button>}</div>}
        <div className="mobile-views" onTouchStart={startSwipe} onTouchMove={moveSwipe} onTouchEnd={endSwipe} onTouchCancel={() => { swipe.current = null; }}>
          <section id="mobile-chat" className="mobile-chat mobile-page" role="tabpanel" aria-labelledby="mobile-tab-chat" hidden={page !== "chat"} data-empty={state.requests.length === 0 && chatCards.length === 0}>
            <div ref={chatScroll} className="mobile-page-scroll mobile-chat-scroll" onScroll={event => {
              if (page !== "chat") return;
              const panel = event.currentTarget; pageScroll.current.chat = panel.scrollTop;
              stickToMessages.current = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 80;
            }}>
              {!state.requests.length ? null : <div className="mobile-requests" aria-label="聊天与执行反馈" aria-live="polite">
                {state.requests.map(request => <article className={`mobile-request mobile-request-${request.status}`} key={request.requestId}>
                  <HarkSurface as="div" className="mobile-user-message"><p>{operationLabel(request.operation)}</p></HarkSurface>
                  <HarkSurface as="div" className="mobile-result">
                    <div className={`mobile-result-heading${request.status === "succeeded" ? " sr-only" : ""}`}>{request.status === "succeeded" ? <HarkIcon name="check" size={16} /> : ["sending", "accepted", "executing"].includes(request.status) ? <HarkIcon name="refresh" size={16} className="mobile-spin" /> : request.status === "unknown" ? <HarkIcon name="info" size={16} /> : <HarkIcon name="close" size={16} />}<span>{resultLabels[request.status]}</span></div>
                    <p className="mobile-result-message">{request.message}</p>
                    {request.status === "unknown" && <><p className="mobile-hint">先查询结果，不重复发送这条指令。</p><Button variant="ghost" disabled={!online} onClick={() => client.query(request.requestId)}><HarkIcon name="refresh" size={15} />查询执行结果</Button></>}
                    {["sending", "accepted", "executing"].includes(request.status) && <Button variant="ghost" disabled={!online} onClick={() => client.cancel(request.requestId)}>请求取消</Button>}
                    {request.status === "rejected" && <Button variant="ghost" disabled={!online || working || uncertain} onClick={() => retry(request.operation)}>重新发送</Button>}
                  </HarkSurface>
                </article>)}
              </div>}
              {Boolean(chatCards.length) && <ul className="mobile-card-list mobile-chat-cards" aria-label="聊天页面卡片">{chatCards.map(renderCard)}</ul>}
            </div>
            <form className="mobile-composer" onSubmit={submit}>
              {uncertain && <p role="status" className="mobile-composer-warning">有一条指令结果未知，请先查询执行结果。</p>}
              <HarkSurface as="div" className="mobile-composer-bar"><textarea ref={composerInput} rows={1} aria-label="发送给电脑的文字指令" value={draft} onChange={event => setDraft(event.target.value)} placeholder={online ? "让 Vivic 做点什么…" : "电脑恢复连接后可输入指令"} maxLength={2000} disabled={!online}
                onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onBlur={() => { composing.current = false; }}
                onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} /><Button type="submit" size="icon" className="mobile-send-button" aria-label="发送指令" disabled={!online || working || uncertain || !draft.trim()}><span className="mobile-send-disc"><HarkIcon name="up" size={16} /></span></Button></HarkSurface>
            </form>
          </section>
          <section id="mobile-space" className="mobile-space mobile-page" role="tabpanel" aria-labelledby="mobile-tab-space" hidden={page !== "space"}>
            <div ref={spaceScroll} className="mobile-page-scroll mobile-space-scroll" onScroll={event => { if (page === "space") pageScroll.current.space = event.currentTarget.scrollTop; }}>
              <div className="mobile-space-context" hidden={(stage?.canvases.length ?? 0) < 2}><label className="sr-only" htmlFor="mobile-canvas">目标画布</label><div className="mobile-select-wrap"><select id="mobile-canvas" value={stage?.activeCanvasId ?? ""} disabled={!online || working || uncertain} onChange={event => client.submit({ kind: "canvas.switch", targetCanvasId: event.target.value })}>
                {!stage?.canvases.length && <option value="">没有可用画布</option>}{stage?.canvases.map(canvas => <option value={canvas.id} key={canvas.id}>{canvas.title}</option>)}
              </select><HarkIcon name="down" size={14} /></div></div>
              {spacePartial && <p className="mobile-space-limit" role="status">手机当前显示部分卡片，完整 Space 请在电脑查看。</p>}
              {!spaceCards.length ? <div className="mobile-space-empty"><HarkIcon name="card" size={28} /><h2>{spacePartial ? "请在电脑查看完整 Space" : "这里还没有卡片"}</h2><Button variant="ghost" onClick={() => switchPage("chat")}>回到聊天</Button></div> : <ul className="mobile-card-list" aria-label="Vivic Space 卡片">{spaceCards.map((card, index) => <Fragment key={card.id}>{card.section && card.section !== spaceCards[index - 1]?.section && <li className="mobile-section-heading" role="presentation"><h2>{card.section}</h2></li>}{renderCard(card)}</Fragment>)}</ul>}
            </div>
          </section>
        </div>
      </> : <div className="mobile-pair-scroll"><section className="mobile-pair" aria-labelledby="mobile-pair-title">
        <h1 id="mobile-pair-title">连接电脑</h1><p className="mobile-lead">先在电脑完成设置，再扫码连接。</p>
        <Button className="mobile-primary mobile-scan-button" disabled={connecting} onClick={() => { setLocalError(null); setScanner(true); }}><HarkIcon name="expand" size={20} />扫描电脑二维码</Button>
        {scanCandidate && <HarkSurface as="div" className="mobile-pair-confirm" role="region" aria-label="确认配对"><HarkIcon name="security" size={22} /><h2>连接这台电脑？</h2><p>配对服务：{scanCandidate.host}</p><p>连接后可以聊天、查看 Space 卡片。执行和保存由电脑完成。</p><Button className="mobile-primary" disabled={connecting} onClick={() => connect(scanCandidate.code, scanCandidate.transportUrl)}>确认连接电脑</Button><Button variant="ghost" onClick={() => setScanCandidate(null)}>取消</Button></HarkSurface>}
        <details className="mobile-manual-pair" open={developmentRelayEnabled || undefined}><summary>输入配对码</summary><form className="mobile-pair-form" onSubmit={pair}>
          {developmentRelayEnabled && <details className="mobile-relay-details"><summary>本机开发连接</summary><label htmlFor="mobile-relay-url">开发中继地址</label><Input id="mobile-relay-url" type="url" value={relayUrl} onChange={event => setRelayUrl(event.target.value)} spellCheck={false} autoCapitalize="none" autoCorrect="off" required disabled={connecting} /></details>}
          <label htmlFor="mobile-pair-code">电脑上的一次性配对码</label><Input id="mobile-pair-code" value={pairCode} onChange={event => setPairCode(event.target.value)} placeholder="输入配对码，或粘贴配对链接" maxLength={1024} autoComplete="off" autoCapitalize="characters" spellCheck={false} required disabled={connecting} className="mobile-code-input" />
          <Button type="submit" variant="outline" className="mobile-pair-submit" disabled={connecting || !pairCode.trim()}>{connecting ? <HarkIcon name="refresh" size={18} className="mobile-spin" /> : <HarkIcon name="link" size={18} />}{connecting ? "正在连接电脑" : "连接我的电脑"}</Button>
        </form></details>
        {state.status !== "unpaired" && <p className="mobile-pair-status" role="status">{statusLabel}</p>}
      </section></div>}
    </div>
    {settings && <dialog ref={settingsDialog} className="mobile-settings-sheet" aria-labelledby="mobile-settings-title" onCancel={event => { event.preventDefault(); closeSettings(); }} onClick={event => { if (event.target === settingsDialog.current) closeSettings(); }}>
      <div className="mobile-sheet-handle" /><header className="mobile-sheet-heading"><h2 id="mobile-settings-title">设置</h2><Button variant="ghost" size="icon" className="mobile-icon-button" aria-label="关闭设置" onClick={closeSettings}><HarkIcon name="close" size={20} /></Button></header>
      <div className="mobile-setting-row"><label htmlFor="mobile-theme">外观</label><select id="mobile-theme" value={theme} onChange={event => setTheme(event.target.value as "dark" | "light")}><option value="light">浅色</option><option value="dark">深色</option></select></div>
      <div className="mobile-setting-row"><label htmlFor="mobile-text-size">文字</label><select id="mobile-text-size" value={largeText ? "large" : "normal"} onChange={event => setLargeText(event.target.value === "large")}><option value="normal">标准</option><option value="large">较大</option></select></div>
      <div className={`mobile-settings-connection ${online ? "is-online" : ""}`}><span className="mobile-status-dot" /><div>{paired && <strong>{stage?.computerName}</strong>}<p>{statusLabel}</p></div></div>
      {paired && <div className="mobile-session-actions">{!online && <Button variant="outline" disabled={connecting} onClick={reconnect}><HarkIcon name="refresh" size={16} className={connecting ? "mobile-spin" : ""} />重新连接</Button>}<Button variant="ghost" onClick={() => { setDisconnectedByUser(true); client.disconnect(); closeSettings(); }}>断开连接</Button>
        {!confirmRevoke ? <Button variant="ghost" onClick={() => setConfirmRevoke(true)}>撤销手机授权</Button> : <div className="mobile-revoke-confirm"><p>撤销后需在电脑重新配对。</p><Button variant="destructive" onClick={() => { client.revoke(); setPage("chat"); closeSettings(); }}>确认撤销</Button><Button variant="ghost" onClick={() => setConfirmRevoke(false)}>返回</Button></div>}
      </div>}
      <p className="mobile-settings-note">其他设置请在电脑调整。</p>
    </dialog>}
    {scanner && <PairingScanner onResult={scanned} onClose={() => setScanner(false)} />}
    {subcardCard && <MobileSubcards card={subcardCard} onClose={() => setSubcardSelection(null)} />}
    {fileCard && <MobileFileSheet key={`${stage?.activeCanvasId}:${stage?.ownerEpoch}:${stage?.version}:${fileCard.id}:${fileCard.file?.sha256}`} card={fileCard} client={client} online={online} onClose={() => setFileSelection(null)} />}
  </main>;
}
