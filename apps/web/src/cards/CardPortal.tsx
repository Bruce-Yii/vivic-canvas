import { HarkIcon } from "@/components/hark/HarkPrimitives";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { createPortal } from "react-dom";
import { Dialog } from "radix-ui";
import { cardTitle, onUserSurface, type CardSurface } from "@/contracts";
import { useVivicState } from "@/state/canvasStore";
import { completedCountdown } from "@/canvas/reminderPresentation";
import { Button } from "@/components/ui/button";
import { ControlDialogContent } from "@/control/ControlDialogContent";
import { cardMatches, CARD_TYPE_LABELS } from "@/control/cardSearch";
import { carriesCard, readCardDrag } from "./surfaceDrag";
import "./cardPortal.css";

export interface CardPortalProps {
  compact?: boolean;
  surface: CardSurface;
  canvasId: string;
  disabled: boolean;
  theme: "light" | "dark";
  onTransfer: (cardId: string, surface: CardSurface) => boolean;
  onFocus: (cardId: string) => boolean;
  onFit: () => boolean;
  onRestore: () => boolean;
}

/** The portal works within one tab: drop a card here or choose it from the list. */
export function CardPortal({ surface, canvasId, disabled, theme, onTransfer, onFocus, onFit, onRestore, compact = false }: CardPortalProps) {
  const cards = useVivicState(state => state.cards);
  const focus = useVivicState(state => state.focus);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [dragging, setDragging] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; top: number; origin: "left" | "right" } | null>(null);
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor ?? anchorRef.current;
  const [receiving, setReceiving] = useState(false);
  const [message, setMessage] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const pending = useRef<{ cardId: string; surface: CardSurface; canvasId: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const liveCards = cards.filter(entry => !entry.exitingRequestId && !completedCountdown(entry));

  useEffect(() => {
    const start = (event: globalThis.DragEvent) => {
      const types = event.dataTransfer ? Array.from(event.dataTransfer.types) : [];
      if (!types.some(type => type.startsWith("application/x-vivic-card-from-"))) return;
      const card = event.target instanceof Element ? event.target.closest(".vivic-user-card, .vivic-card") : null;
      if (compact && card instanceof HTMLElement) {
        const rect = card.getBoundingClientRect();
        const size = 44, gap = 14;
        const placeRight = rect.right + gap + size <= window.innerWidth - 8;
        const left = placeRight ? rect.right + gap : Math.max(8, rect.left - gap - size);
        const top = Math.min(Math.max(8, rect.top + rect.height / 2 - size / 2), window.innerHeight - size - 8);
        setAnchor({ left, top, origin: placeRight ? "left" : "right" });
      }
      setDragging(true);
    };
    const end = () => { setDragging(false); setReceiving(false); setAnchor(null); };
    window.addEventListener("dragstart", start);
    window.addEventListener("dragend", end);
    window.addEventListener("drop", end);
    return () => {
      window.removeEventListener("dragstart", start);
      window.removeEventListener("dragend", end);
      window.removeEventListener("drop", end);
    };
  }, [compact]);
  useEffect(() => {
    if (!compact || !message || dragging) return;
    const timer = window.setTimeout(() => setMessage(""), 2400);
    return () => clearTimeout(timer);
  }, [compact, message, dragging]);
  useEffect(() => {
    const request = pending.current;
    if (!request) return;
    const card = cards.find(entry => entry.record.id === request.cardId && !entry.exitingRequestId)?.record;
    if (request.canvasId !== canvasId || disabled || !card) {
      clearTimeout(request.timer); pending.current = null;
      setMessage("画布、卡片或连接已改变，请重新操作。");
    } else if ((onUserSurface(card) ? "user" : "display") === request.surface) {
      clearTimeout(request.timer); pending.current = null;
      setMessage(`已传送到${request.surface === "user" ? "用户页，可在卡片上编辑" : "展示页"}。`);
    }
  }, [cards, canvasId, disabled]);
  useEffect(() => () => { if (pending.current) clearTimeout(pending.current.timer); }, []);

  const transfer = (cardId: string, destination: CardSurface) => {
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = null;
    if (disabled || !onTransfer(cardId, destination)) {
      setMessage("尚未传送，请保持主控用户页打开，并检查当前画布与控制权。");
      return;
    }
    setMessage("正在传送…");
    const request = { cardId, surface: destination, canvasId, timer: setTimeout(() => {
      if (pending.current === request) { pending.current = null; setMessage("尚未收到传送确认，请检查主控用户页后重试。"); }
    }, 2500) };
    pending.current = request;
  };
  const accepts = (event: DragEvent) => carriesCard(event, "display") || carriesCard(event, "user");
  const drop = (event: DragEvent) => {
    if (!accepts(event)) return;
    event.preventDefault(); event.stopPropagation(); setReceiving(false); setDragging(false);
    const payload = readCardDrag(event, "display") ?? readCardDrag(event, "user");
    if (!payload || payload.canvasId !== canvasId) { setMessage("这张卡片属于另一张画布，请切换到对应画布。"); return; }
    const card = cards.find(entry => entry.record.id === payload.cardId && !entry.exitingRequestId)?.record;
    if (!card || (onUserSurface(card) ? "user" : "display") !== payload.from) { setMessage("卡片位置已改变，请重新选择。"); return; }
    transfer(payload.cardId, payload.from === "display" ? "user" : "display");
  };

  if (compact) {
    const spot = anchor ?? anchorRef.current;
    if ((!dragging && !message) || !spot) return null;
    return createPortal(<>
      {dragging && anchor && <div className="vivic-portal-float" style={{ left: anchor.left, top: anchor.top }} data-origin={anchor.origin} data-receiving={receiving || undefined}
        aria-label="拖到这里传送卡片" title="拖到这里传送卡片"
        onDragOver={event => { if (accepts(event)) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = disabled ? "none" : "move"; setReceiving(true); } }}
        onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setReceiving(false); }}
        onDrop={drop}>
        <HarkIcon name="card" size={18} aria-hidden />
      </div>}
      {!dragging && message && <p className="vivic-portal-float-note" style={{ left: spot.left, top: spot.top }} role="status">{message}</p>}
    </>, document.body);
  }

  return <div className={`vivic-card-portal${theme === "dark" ? " dark" : ""}`} data-vivic-portal={surface} data-dragging={dragging || undefined} data-receiving={receiving || undefined}
    onDragOver={event => { if (accepts(event)) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = disabled ? "none" : "move"; setReceiving(true); } }}
    onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setReceiving(false); }} onDrop={drop}>
    <Dialog.Root open={open} onOpenChange={value => { setOpen(value); if (value && !pending.current) setMessage(""); }}>
      <Dialog.Trigger asChild><Button ref={trigger} variant="outline" className={`vivic-portal-trigger${compact ? " vivic-portal-compact" : ""}`} aria-label="卡片传送门" disabled={!canvasId}
        title="拖动卡片到这里，或点开选择卡片；同一浏览器的两个标签页也能传送。">
        <HarkIcon name="card" size={18} aria-hidden />{!compact && <><span>{dragging ? `拖到这里，传送到${surface === "display" ? "用户页" : "展示页"}` : "卡片传送门"}</span>
        <span className="vivic-portal-count">{liveCards.length}</span></>}
      </Button></Dialog.Trigger>
      {open && <ControlDialogContent title="卡片传送门" description="选择卡片即可在用户页和展示页之间传送，无需跨标签页拖拽。" className={`vivic-portal-dialog${theme === "dark" ? " dark" : ""}`} overlayClassName="vivic-portal-overlay"
        onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus({ preventScroll: true }); }}>
        <div className="vivic-portal-summary"><span><HarkIcon name="computer" size={15} aria-hidden /> 展示页 {liveCards.filter(entry => !onUserSurface(entry.record)).length}</span>
          <HarkIcon name="share" size={16} aria-hidden /><span><HarkIcon name="person" size={15} aria-hidden /> 用户页 {liveCards.filter(entry => onUserSurface(entry.record)).length}</span></div>
        <div className="vivic-portal-view-actions"><Button variant="outline" size="sm" disabled={disabled} onClick={() => { if (!onFit()) setMessage("当前不能调整展示视图，请检查主控连接。"); }}><HarkIcon name="expand" size={15} aria-hidden />显示全部</Button>
          <Button variant="ghost" size="sm" disabled={disabled || !focus} onClick={() => { if (!onRestore()) setMessage("当前不能恢复视图，请检查主控连接。"); }}><HarkIcon name="refresh" size={15} aria-hidden />恢复视图</Button></div>
        <label className="vivic-portal-search">查找卡片<input aria-label="传送门查找卡片" value={query} onChange={event => setQuery(event.target.value)} placeholder="输入名称、内容或拼音" /></label>
        <div className="vivic-portal-list">
          {(["display", "user"] as const).map(place => {
            const entries = liveCards.filter(entry => (onUserSurface(entry.record) ? "user" : "display") === place && cardMatches(entry.record, query));
            return <section key={place}><h3>{place === "display" ? "展示页" : "用户页"}{place === surface ? " · 当前页面" : ""}</h3>
              {!entries.length && <p className="vivic-portal-empty">{query ? "没有匹配的卡片" : "暂无卡片"}</p>}
              {entries.map(({ record }) => <div key={record.id} className="vivic-portal-row" data-vivic-portal-card={record.id}>
                <div className="vivic-portal-card-title"><strong>{cardTitle(record)}</strong><small>{CARD_TYPE_LABELS[record.type]}{focus?.cardId === record.id ? " · 正在聚焦" : ""}</small></div>
                <div className="vivic-portal-row-actions">{place === "display" && <Button size="sm" variant="ghost" disabled={disabled} aria-label={`聚焦：${cardTitle(record)}`} onClick={() => { if (onFocus(record.id)) setOpen(false); else setMessage("当前不能聚焦，请检查主控连接。"); }}><HarkIcon name="point" size={15} aria-hidden />聚焦</Button>}
                  <Button size="sm" variant="outline" disabled={disabled || message === "正在传送…"} aria-label={`传送到${place === "display" ? "用户页" : "展示页"}：${cardTitle(record)}`} onClick={() => transfer(record.id, place === "display" ? "user" : "display")}><HarkIcon name="share" size={15} aria-hidden />{place === "display" ? "到用户页编辑" : "到展示页"}</Button></div>
              </div>)}
            </section>;
          })}
        </div>
        <footer className="vivic-portal-footer" role="status">{message || (disabled ? "主控暂未连接。保持用户页打开后，可传送卡片和调整视图。" : "也可把当前页面的卡片拖到传送门；返回展示页后，卡片内容和备注会保留。")}</footer>
      </ControlDialogContent>}
    </Dialog.Root>
    {!open && message && <p className="vivic-portal-message" role="status">{message}</p>}
  </div>;
}
