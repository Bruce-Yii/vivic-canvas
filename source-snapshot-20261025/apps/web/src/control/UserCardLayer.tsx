import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type RefObject } from "react";
import { GripHorizontal } from "lucide-react";
import { HarkIcon, HarkSurface } from "@/components/hark/HarkPrimitives";
import { cardTitle, onUserSurface, type CardRecord } from "@/contracts";
import { canvasStore, useVivicState } from "@/state/canvasStore";
import { VivicCard } from "@/cards/VivicCard";
import { SubcardThemeContext } from "@/cards/SubcardEditorContext";
import { CardActionsContext, CardModeContext, type CardActions } from "@/cards/scene/cardContext";
import { storePhotos } from "@/cards/scene/photos";
import { carriesCard, readCardDrag, startCardDrag } from "@/cards/surfaceDrag";
import { newId } from "@/lib/id";
import type { ControlHost } from "@/sync/controlHost";
import "@/cards/scene/sceneCards.css";
import "./userCardLayer.css";
import { FileScopeContext } from "@/files/FileScopeContext";

const MAX_PHOTOS = 36;
const EDGE = 8;

/**
 * The user page is otherwise empty: cards the user drags in from the Display
 * float where they were dropped, can be dragged around the page, and dragged
 * back to the Display window. They render in control mode — tick todos,
 * adjust progress, add photos — and every edit goes through the owner's
 * validated card.update. Nothing here is a list or a history.
 */
export function useUserPageDrop(host: ControlHost) {
  const layerRef = useRef<HTMLDivElement>(null);
  const depth = useRef(0);
  const [receiving, setReceiving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const accepts = (event: DragEvent) => carriesCard(event, "display") || carriesCard(event, "user");
  const place = (event: DragEvent, grabX = 24, grabY = 16) => {
    const box = layerRef.current?.getBoundingClientRect();
    const scroll = layerRef.current ? { x: layerRef.current.scrollLeft, y: layerRef.current.scrollTop } : { x: 0, y: 0 };
    return { x: event.clientX - (box?.left ?? 0) + scroll.x - grabX, y: event.clientY - (box?.top ?? 0) + scroll.y - grabY };
  };
  const handlers = {
    onDragEnter: (event: DragEvent) => {
      if (!carriesCard(event, "display")) return;
      depth.current += 1; setReceiving(true);
    },
    onDragOver: (event: DragEvent) => {
      if (!accepts(event) || host.getSnapshot().ownerMode !== "owner") return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    },
    onDragLeave: (event: DragEvent) => {
      if (!carriesCard(event, "display")) return;
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setReceiving(false);
    },
    onDrop: (event: DragEvent) => {
      depth.current = 0; setReceiving(false);
      const payload = readCardDrag(event, "display") ?? readCardDrag(event, "user");
      if (!payload) return;
      event.preventDefault();
      if (payload.canvasId !== host.getSnapshot().activeCanvasId) { setNotice("这张卡片属于另一张画布，请先在设置页切换画布。"); return; }
      const card = canvasStore.getState().cards.find(entry => entry.record.id === payload.cardId)?.record;
      const result = host.setCardSurface(payload.cardId, "user", place(event, payload.grabX, payload.grabY));
      if (!result.ok) setNotice("暂时无法移动这张卡片，请检查控制权。");
      else if (payload.from === "display") setNotice(`「${card ? cardTitle(card).slice(0, 24) : "卡片"}」已放到这里`);
    },
  };
  return { layerRef, receiving, handlers, notice, setNotice };
}

export function UserCardLayer({ host, theme, layerRef, receiving, notice, onNotice }: {
  host: ControlHost;
  theme: "light" | "dark";
  layerRef: RefObject<HTMLDivElement | null>;
  receiving: boolean;
  notice: string | null;
  onNotice: (text: string | null) => void;
}) {
  const snapshot = useSyncExternalStore(host.subscribe, host.getSnapshot);
  const cards = useVivicState(state => state.cards);
  const docked = cards.filter(entry => !entry.exitingRequestId && onUserSurface(entry.record)).map(entry => entry.record)
    .sort((a, b) => a.metadata.updatedAt.localeCompare(b.metadata.updatedAt));
  const editable = snapshot.ready && snapshot.ownerMode === "owner";
  const [size, setSize] = useState({ width: 1200, height: 800 });

  useEffect(() => {
    const element = layerRef.current;
    if (!element) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [layerRef]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => onNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice, onNotice]);

  const actions = useMemo<CardActions>(() => ({
    editable,
    update: (cardId, patch) => {
      const current = host.getSnapshot();
      if (!editable || current.ownerMode !== "owner" || !current.activeCanvasId) return false;
      const before = canvasStore.getState().cards.find(entry => entry.record.id === cardId)?.record;
      const result = host.dispatch({ schemaVersion: "0.6", requestId: newId("edit"), canvasId: current.activeCanvasId,
        actions: [{ type: "card.update", targetId: cardId, ...patch }] });
      const after = canvasStore.getState().cards.find(entry => entry.record.id === cardId)?.record;
      // The reducer drops a merge that fails the card schema; say so instead of pretending.
      const applied = result.ok && Boolean(after) && after !== before;
      if (!applied) onNotice("这次修改没有通过校验，卡片保持原样。");
      return applied;
    },
    remove: cardId => {
      const current = host.getSnapshot();
      if (!editable || !current.activeCanvasId) return false;
      const ok = host.dispatch({ schemaVersion: "0.6", requestId: newId("remove"), canvasId: current.activeCanvasId,
        actions: [{ type: "card.delete", targetId: cardId }] }).ok;
      if (ok) onNotice("已删除，可输入「撤销」恢复。");
      return ok;
    },
    refresh: async cardId => {
      const result = await host.refreshTravelCard(cardId);
      onNotice(result.ok ? "已刷新旅游结果。" : result.error);
      return result.ok;
    },
    addPhotos: async files => {
      const { images, errors } = await storePhotos(files, MAX_PHOTOS);
      onNotice(errors[0] ?? (images.length ? `已在本机保存 ${images.length} 张照片` : null));
      return images;
    },
  }), [host, editable, onNotice]);

  const sendToDisplay = (card: CardRecord) => {
    const result = host.setCardSurface(card.id, "display");
    onNotice(result.ok ? `「${cardTitle(card).slice(0, 24)}」已放回副屏` : "暂时无法放回副屏，请检查控制权。");
  };

  return <div ref={layerRef} className={`vivic-user-layer${theme === "dark" ? " dark" : ""}`} data-vivic-user-layer data-receiving={receiving || undefined}>
    {receiving && <div className="vivic-user-layer-drop" data-vivic-drop-overlay="user">松开，把卡片放在这里</div>}
    <FileScopeContext value={snapshot.activeCanvasId}><SubcardThemeContext.Provider value={theme}>
      <CardModeContext.Provider value="control">
        <CardActionsContext.Provider value={actions}>
          {docked.map((card, index) => {
            const width = Math.min(card.layout.width, Math.max(240, size.width - 2 * EDGE));
            const fallback = { x: 24 + (index % 6) * 28, y: 72 + (index % 6) * 28 };
            const wanted = card.layout.userPos ?? fallback;
            const left = Math.round(Math.min(Math.max(EDGE, wanted.x), Math.max(EDGE, size.width - width - EDGE)));
            const top = Math.round(Math.max(EDGE, Math.min(wanted.y, Math.max(EDGE, size.height - 96))));
            return <HarkSurface as="article" key={card.id} className="vivic-user-card" style={{ left, top, width }} data-vivic-user-card={card.id} data-scene-type={card.type}>
              <span className="vivic-move-handle" draggable role="button" tabIndex={-1} title="拖动位置，或拖回副屏"
                aria-label={`拖动「${cardTitle(card).slice(0, 40)}」：在本页换位置，或拖回副屏`} data-vivic-user-handle={card.id}
                onDragStart={event => {
                  const canvasId = host.getSnapshot().activeCanvasId;
                  if (!canvasId || !editable) { event.preventDefault(); return; }
                  const box = event.currentTarget.closest(".vivic-user-card");
                  const rect = box?.getBoundingClientRect();
                  startCardDrag(event, { v: 1, canvasId, cardId: card.id, from: "user",
                    grabX: rect ? event.clientX - rect.left : undefined, grabY: rect ? event.clientY - rect.top : undefined }, cardTitle(card), box);
                }}><GripHorizontal size={14} aria-hidden /></span>
              <div className="vivic-user-card-tools">
                <button type="button" className="vivic-scene-icon-button" disabled={!editable} onClick={() => sendToDisplay(card)}
                  aria-label={`把「${cardTitle(card).slice(0, 40)}」放回副屏`} title="传送到展示页" data-vivic-send-display={card.id}><HarkIcon name="share" size={15} /><span className="text-xs">传送到展示页</span></button>
                <button type="button" className="vivic-scene-icon-button" disabled={!editable} onClick={() => actions.remove?.(card.id)}
                  aria-label={`删除「${cardTitle(card).slice(0, 40)}」（可撤销）`} title="删除（可撤销）"><HarkIcon name="trash" size={15} /></button>
              </div>
              <VivicCard record={card} />
            </HarkSurface>;
          })}
        </CardActionsContext.Provider>
      </CardModeContext.Provider>
    </SubcardThemeContext.Provider></FileScopeContext>
    {notice && <p role="status" className="vivic-user-layer-notice" data-vivic-user-notice>{notice}</p>}
  </div>;
}
