import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import { Laptop, Link2, Pin, RefreshCw, ShieldCheck, Smartphone, Square } from "lucide-react";
import { AtmosphereBackground } from "@/components/atmosphere/AtmosphereBackground";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createComputerConnector, type ComputerHostAdapter, type ConnectorState } from "@vivic/mobile-console-prototype/connector";
import { createWebSocketTransport } from "@vivic/mobile-console-prototype/transport";
import type { CanvasSnapshot } from "@vivic/mobile-console-prototype/protocol";
import { defaultRelayUrl } from "./MobileConsole";
import "./mobile.css";

const stoppedState: ConnectorState = { status: "stopped", pairCode: null, pairExpiresAt: null, expiresAt: null, controllers: [], error: null };
const subscribeToNothing = () => () => {};
const getStoppedState = () => stoppedState;
const statusLabels: Record<ConnectorState["status"], string> = { stopped: "未连接", connecting: "正在连接中继", connected: "中继已连接", offline: "中继已断开，正在恢复", expired: "本次连接已结束", error: "连接遇到问题" };

/** Intentionally artificial memory canvas. This does not import or start the real Vivic owner. */
export function createDemoComputerHost(): ComputerHostAdapter {
  type Card = CanvasSnapshot["cards"][number];
  const canvases = new Map<string, { title: string; version: number; cards: Card[] }>([
    ["demo-thoughts", { title: "DEMO · 今日想法", version: 0, cards: [{ id: "demo-note", title: "DEMO · 这是一张内存便笺", type: "NoteCard", pinned: false }] }],
    ["demo-plans", { title: "DEMO · 下一步", version: 0, cards: [] }],
  ]);
  let activeId = "demo-thoughts";
  let ownerEpoch = crypto.randomUUID();
  const listeners = new Set<() => void>();
  let snapshot: CanvasSnapshot;
  const publish = () => {
    const canvas = canvases.get(activeId)!;
    snapshot = { computerName: "DEMO · 电脑连接原型", ownerAvailable: true, ownerEpoch, activeCanvasId: activeId, version: canvas.version,
      canvases: [...canvases].map(([id, item]) => ({ id, title: item.title, version: item.version })), cards: canvas.cards.map(card => ({ ...card })) };
    listeners.forEach(listener => listener());
  };
  publish();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async submitText(text, context) {
      await Promise.resolve();
      // All asynchronous work must re-check the connector lease immediately before committing.
      if (context.signal.aborted || !context.isCurrent()) return { ok: false, message: "DEMO：本次请求已取消或授权失效，没有修改内存画布。" };
      const canvas = canvases.get(activeId)!;
      if (canvas.cards.length >= 100) return { ok: false, message: "DEMO 内存卡片已满，请停止并重新启动本页。" };
      canvas.cards.push({ id: `demo-${context.requestId}`, title: `DEMO · ${text}`.slice(0, 160), type: "NoteCard", pinned: false });
      canvas.version += 1; publish();
      return { ok: true, message: "DEMO 已在本页内存画布新增便笺；没有调用模型，也没有修改正式 Vivic。" };
    },
    switchCanvas(id) {
      if (!canvases.has(id)) return { ok: false, message: "DEMO 目标画布不存在。" };
      activeId = id; publish(); return { ok: true, message: "DEMO 已切换本页内存画布。" };
    },
    setCardPinned(cardId, pinned) {
      const canvas = canvases.get(activeId)!;
      const card = canvas.cards.find(card => card.id === cardId);
      if (!card) return { ok: false, message: "DEMO 卡片不属于当前画布。" };
      card.pinned = pinned; canvas.version += 1; publish();
      return { ok: true, message: `DEMO 已${pinned ? "固定" : "取消固定"}内存卡片。` };
    },
  };
}

/** Real relay and connector, deliberately DEMO host; formal production bridge is pending approval. */
export function ComputerPrototype() {
  const [relayUrl, setRelayUrl] = useState(defaultRelayUrl);
  const [admissionKey, setAdmissionKey] = useState("");
  const [connector, setConnector] = useState<ReturnType<typeof createComputerConnector> | null>(null);
  const [host, setHost] = useState<ComputerHostAdapter>(() => createDemoComputerHost());
  const [localMessage, setLocalMessage] = useState<string | null>(null);
  const [clock, setClock] = useState(Date.now);
  const state = useSyncExternalStore(connector?.subscribe ?? subscribeToNothing, connector?.getSnapshot ?? getStoppedState);
  const canvas = useSyncExternalStore(host.subscribe, host.getSnapshot);
  const connected = state.status === "connected";
  const running = connector && !["stopped", "expired", "error"].includes(state.status);
  const remaining = Math.max(0, Math.ceil(((state.pairExpiresAt ?? 0) - clock) / 1000));
  const activeCanvas = canvas.canvases.find(item => item.id === canvas.activeCanvasId);
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => () => connector?.stop(), [connector]);
  const start = (event: FormEvent) => {
    event.preventDefault();
    const secret = admissionKey; setAdmissionKey(""); setLocalMessage(null);
    connector?.stop();
    try {
      const nextHost = createDemoComputerHost();
      const next = createComputerConnector({ transport: createWebSocketTransport(relayUrl.trim()), host: nextHost,
        deviceId: crypto.randomUUID(), deviceName: "DEMO · 电脑连接原型", accessKey: secret });
      setHost(nextHost); setConnector(next); next.start();
    } catch { setConnector(null); setLocalMessage("无法连接。请检查中继地址与专用接入凭据。正式环境必须使用 WSS。"); }
  };
  const stop = () => { connector?.stop(); setConnector(null); setLocalMessage("本页 connector 已停止，内存画布不会保存。若中继未收到撤销，旧设备仍因本页退出而无法执行；重新启动会建立新会话。"); };

  return <main className="mobile-console dark" data-mobile-theme="dark">
    <AtmosphereBackground theme="dark" palette="midnight" className="mobile-atmosphere" />
    <div className="mobile-shell">
      <header className="mobile-header"><div className="mobile-wordmark">vivic<span>电脑连接原型 · DEMO</span></div><Laptop aria-hidden="true" size={23} /></header>
      <div className="mobile-content">
        <p className="mobile-prototype-note">真实中继与 connector · 演示内存画布 · 正式 owner 接线待核定</p>
        <section className={`mobile-connection ${connected ? "is-online" : ""}`} aria-label="电脑中继状态" aria-live="polite"><span className="mobile-status-dot" /><span>{statusLabels[state.status]}</span></section>
        {(localMessage || state.error) && <p role="status" className="mobile-alert">{localMessage ?? state.error}</p>}
        <section className="mobile-panel mobile-settings">
          <div className="mobile-section-label">DEMO · 可运行的配对入口</div>
          <h1>在手机与这页之间，<br />走一次真实中继。</h1>
          <p className="mobile-hint">本页只演示配对、文字便笺、画布切换与卡片固定。它没有接入电脑 Vivic 正式 owner、保存或 Display，不调用模型。</p>
          {!running ? <form onSubmit={start}>
            <label htmlFor="computer-relay-url">与手机相同的中继地址</label>
            <Input id="computer-relay-url" type="url" value={relayUrl} onChange={event => setRelayUrl(event.target.value)} required spellCheck={false} autoCapitalize="none" />
            <label htmlFor="computer-admission-key">中继专用接入凭据</label>
            <Input id="computer-admission-key" type="password" value={admissionKey} onChange={event => setAdmissionKey(event.target.value)} minLength={32} maxLength={256} required autoComplete="off" spellCheck={false} autoCapitalize="none" />
            <p className="mobile-hint">使用本次中继启动时的专用凭据。不要输入模型 Key 或 Vivic 本地 API token；凭据仅留内存，连接后清空输入。</p>
            <Button type="submit" className="mobile-primary" disabled={admissionKey.length < 32}><Link2 size={18} />启动 DEMO 电脑连接</Button>
          </form> : <div className="mobile-session-actions"><Button variant="outline" onClick={stop}><Square size={15} />停止并结束本次连接</Button></div>}
          {connected && <div className="computer-pairing" aria-live="polite">
            <div className="mobile-section-label">手机输入的一次性配对码</div>
            <output data-computer-pair-code className="computer-pair-code">{state.pairCode && remaining > 0 ? state.pairCode : "已使用或已过期"}</output>
            <p className="mobile-hint">{state.pairCode && remaining > 0 ? `${remaining} 秒后过期，仅限一次使用。` : "需要连接另一部手机时，请生成新码。"}</p>
            <Button variant="outline" onClick={() => connector?.rotatePairing()}><RefreshCw size={15} />生成新配对码</Button>
          </div>}
        </section>

        <section className="mobile-panel mobile-cards computer-demo-section" aria-labelledby="computer-devices-title">
          <div className="mobile-section-label" id="computer-devices-title">已授权手机 · {state.controllers.length}</div>
          {!state.controllers.length ? <p className="mobile-hint">尚无手机连接。打开手机控制台，输入上方配对码。</p> : <ul>{state.controllers.map(id => <li key={id}><div><Smartphone size={17} /><strong>{id}</strong></div><Button variant="outline" onClick={() => connector?.revoke(id)}>撤销此手机</Button></li>)}</ul>}
        </section>

        <section className="mobile-panel mobile-cards computer-demo-section" aria-labelledby="computer-memory-title">
          <div className="mobile-section-label" id="computer-memory-title">DEMO 内存画布 · 仅本页</div>
          <h2 className="computer-demo-canvas-title">{activeCanvas?.title}</h2>
          <p className="mobile-hint">版本 {canvas.version} · 手机文字指令只在这里新增 DEMO 便笺</p>
          {!canvas.cards.length ? <p className="mobile-hint">当前内存画布为空。</p> : <ul>{canvas.cards.map(card => <li key={card.id}><div><strong>{card.title}</strong><span>{card.type} · {card.pinned ? "已固定" : "未固定"}</span></div>{card.pinned && <Pin aria-label="已固定" size={17} />}</li>)}</ul>}
        </section>
        <div className="mobile-security-note"><ShieldCheck size={20} /><p>配对码仅显示于本页，不写入日志或浏览器存储。刷新、停止或会话过期后需新建连接。双方都通过中继通信，同局域网仍需互联网；本页不是正式双设备验收证据。</p></div>
        <p className="mobile-footnote"><a href="./index.html">打开手机控制台</a></p>
      </div>
      <div className="mobile-safe-bottom" />
    </div>
  </main>;
}
