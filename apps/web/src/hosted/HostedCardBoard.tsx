import { lazy, Suspense, useRef, useState, type PointerEvent } from "react";
import { CardRecordSchema, cardTitle, type CardRecord, type HostedSpaceCommand } from "@vivic/contracts";
import { HarkIcon, HarkSurface } from "@/components/hark/HarkPrimitives";
import { CardActionsContext, CardModeContext } from "@/cards/scene/cardContext";
import { SubcardEditorContext, SubcardThemeContext } from "@/cards/SubcardEditorContext";
import { NoteCardView } from "@/cards/NoteCardView";
import { TodoCardView } from "@/cards/TodoCardView";
import { CountdownCardView } from "@/cards/CountdownCardView";
import { ReminderListView } from "@/cards/ReminderListView";
import { isDateCountdown } from "@vivic/contracts";
import { GripHorizontal } from "lucide-react";
import { useHostedAssets } from "@/hostedAssets/HostedAssets";
import { fileFormatLabel } from "@/files/filePresentation";
import { HostedDialog } from "./HostedDialog";
import { hostedCardGeometry } from "./cardGeometry";

// The registry, charts and file readers are not in the authentication/composer entry chunk.
const VivicCard = lazy(() => import("@/cards/VivicCard").then(module => ({ default: module.VivicCard })));
const subcardReader = { editable: false, dispatch: () => false };
type HostedCardCommand = (command: HostedSpaceCommand, optimistic?: CardRecord, expectedVersionOverride?: number) => Promise<boolean>;
export function HostedCardBoard({ cards, version, theme, busy, focusedId, notice = "", onCommand, onFocus }: { cards: CardRecord[]; version: number; theme: "light" | "dark"; busy: boolean; focusedId: string | null; notice?: string;
  onCommand: HostedCardCommand; onFocus(id: string | null): void;
}) {
  const assets = useHostedAssets(), [editing, setEditing] = useState<{ card: CardRecord; expectedVersion: number } | null>(null);
  const update = (cardId: string, patch: { displayProps?: Record<string, unknown>; sourceData?: Record<string, unknown> }) => {
    const card = cards.find(item => item.id === cardId); if (!card || busy) return false;
    const merged = CardRecordSchema.safeParse({ ...card, displayProps: { ...card.displayProps, ...patch.displayProps }, sourceData: { ...card.sourceData, ...patch.sourceData } });
    if (!merged.success) return false; void onCommand({ type: "card.update", cardId, ...patch }, merged.data, version); return true;
  };
  const maxX = Math.max(0, ...cards.map(card => Math.max(0, card.layout.x) + card.layout.width));
  const maxY = Math.max(0, ...cards.map(card => Math.max(0, card.layout.y) + hostedCardGeometry(card).height));
  return <SubcardThemeContext value={theme}><SubcardEditorContext value={subcardReader}><CardModeContext value="control"><CardActionsContext value={{ editable: !busy, update, remove: cardId => { if (busy) return false; void onCommand({ type: "card.delete", cardId }, undefined, version); return true; }, addPhotos: assets.addPhotos }}>
    <div className="hosted-board" aria-label="Space 卡片" data-hosted-board><div className="hosted-board-plane" style={{ minWidth: Math.max(640, maxX + 48), minHeight: Math.max(400, maxY + 80) }}>
      {cards.map(card => <HostedCard key={card.id} card={card} version={version} busy={busy} focused={focusedId === card.id} onFocus={() => onFocus(card.id)} onCommand={onCommand} onEdit={() => setEditing({ card, expectedVersion: version })} onOpenFile={() => assets.openFile(card)} />)}
      {!cards.length && <div className="hosted-space-empty"><h2>留一点空间给想法</h2><p>新建便笺、待办或提醒，也可以告诉 Vivic 你想做什么。</p></div>}
    </div></div>
    {editing && <NoteEditor card={editing.card} busy={busy} notice={notice} onClose={() => setEditing(null)} onSave={async text => { const card = editing.card, command: HostedSpaceCommand = card.type === "NoteCard" ? { type: "card.update", cardId: card.id, displayProps: { text } } : { type: "card.update", cardId: card.id, sourceData: { reminderText: text } }; return onCommand(command, undefined, editing.expectedVersion); }} />}
  </CardActionsContext></CardModeContext></SubcardEditorContext></SubcardThemeContext>;
}
function HostedCard({ card, version, busy, focused, onFocus, onCommand, onEdit, onOpenFile }: { card: CardRecord; version: number; busy: boolean; focused: boolean; onFocus(): void; onCommand: HostedCardCommand; onEdit(): void; onOpenFile(): void }) {
  const ref = useRef<HTMLElement | null>(null), drag = useRef<{ clientX: number; clientY: number; x: number; y: number; pointerId: number; expectedVersion: number; placed: { x: number; y: number } } | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const title = cardTitle(card), editableText = card.type === "NoteCard" || (card.type === "CountdownCard" && Boolean(card.sourceData.reminderText));
  const geometry = hostedCardGeometry(card);
  const place = (next: { x: number; y: number }, expectedVersion: number) => {
    setPosition(next);
    const optimistic = { ...card, layout: { ...card.layout, x: next.x, y: next.y, pinned: false } };
    void onCommand({ type: "card.move", cardId: card.id, x: next.x, y: next.y }, optimistic, expectedVersion).finally(() => setPosition(current => current?.x === next.x && current.y === next.y ? null : current));
  };
  const endDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const start = drag.current;
    if (!start || event.pointerId !== start.pointerId) return;
    const moved = Math.abs(start.placed.x - start.x) > 2 || Math.abs(start.placed.y - start.y) > 2;
    if (moved) ref.current?.setAttribute("data-dragged", "");
    drag.current = null;
    ref.current?.removeAttribute("data-dragging");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (moved) place(start.placed, version); else setPosition(null);
  };
  return <HarkSurface as="article" ref={node => { ref.current = node; }} id={`hosted-card-${card.id}`} tabIndex={-1} className="hosted-card vivic-card" data-focused={focused || undefined} data-card-id={card.id} style={{ left: position?.x ?? Math.max(0, card.layout.x), top: position?.y ?? Math.max(0, card.layout.y), width: card.layout.width, height: geometry.height, boxSizing: "border-box" }} onFocus={onFocus}>
    <div className="hosted-card-tools"><button type="button" className="hosted-move hark-icon-button" aria-label={`移动：${title}`} disabled={busy} onPointerDown={event => { if (event.button !== 0 || window.matchMedia("(max-width: 760px)").matches || busy) return; event.currentTarget.focus({ preventScroll: true }); onFocus(); const origin = { clientX: event.clientX, clientY: event.clientY, x: position?.x ?? card.layout.x, y: position?.y ?? card.layout.y, pointerId: event.pointerId, expectedVersion: version, placed: { x: position?.x ?? card.layout.x, y: position?.y ?? card.layout.y } }; drag.current = origin; ref.current?.setAttribute("data-dragging", ""); event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { const start = drag.current; if (!start || event.pointerId !== start.pointerId) return; const placed = { x: Math.max(0, Math.round(start.x + event.clientX - start.clientX)), y: Math.max(0, Math.round(start.y + event.clientY - start.clientY)) }; start.placed = placed; setPosition(placed); }} onPointerUp={endDrag} onPointerCancel={endDrag} onKeyDown={event => { const delta: Record<string, [number, number]> = { ArrowLeft: [-24, 0], ArrowRight: [24, 0], ArrowUp: [0, -24], ArrowDown: [0, 24] }; const offset = delta[event.key]; if (offset && !busy) { event.preventDefault(); place({ x: Math.max(0, card.layout.x + offset[0]), y: Math.max(0, card.layout.y + offset[1]) }, version); } }}><GripHorizontal size={16} aria-hidden /></button>
      <span className="hosted-card-tool-spacer" />{editableText && <button className="hark-icon-button" aria-label={`编辑：${title}`} disabled={busy} onClick={onEdit}><HarkIcon name="edit" /></button>}
      <button className="hark-icon-button" aria-label={`删除：${title}`} disabled={busy} onClick={() => void onCommand({ type: "card.delete", cardId: card.id }, undefined, version)}><HarkIcon name="trash" /></button></div>
    <div className="hosted-card-content" role="region" aria-label={`卡片内容：${title}`} tabIndex={0} style={{ height: geometry.contentHeight, overflowY: "auto", overflowX: "hidden" }}>{card.type === "FileCard" ? <button className="hosted-file-card" aria-label={`打开文件：${card.displayProps.name}`} onClick={onOpenFile}><span className="hosted-file-mark" aria-hidden="true"><HarkIcon name="file" size={32} /><span>{fileFormatLabel(card.displayProps.mediaType)}</span></span><strong>{card.displayProps.name}</strong></button>
      : card.type === "NoteCard" ? <NoteCardView card={card} /> : card.type === "TodoCard" ? <TodoCardView card={card} />
        : card.type === "CountdownCard" && !isDateCountdown(card) ? card.sourceData.reminderText ? <ReminderListView cards={[card]} /> : <CountdownCardView card={card} />
          : <Suspense fallback={<p role="status" className="hosted-muted">正在载入卡片…</p>}>{card.type === "BookCard" ? <CardActionsContext value={null}><VivicCard record={card} /></CardActionsContext> : <VivicCard record={card} />}</Suspense>}</div>
    {card.variant !== "expanded" && card.type !== "FileCard" && <button className="hosted-card-expand hark-icon-button" aria-label={`展开：${title}`} disabled={busy} onClick={() => void onCommand({ type: "card.update", cardId: card.id, variant: "expanded" }, undefined, version)}><HarkIcon name="expand" /></button>}
  </HarkSurface>;
}
function NoteEditor({ card, busy, notice, onClose, onSave }: { card: CardRecord; busy: boolean; notice: string; onClose(): void; onSave(text: string): Promise<boolean> }) {
  const [text, setText] = useState(card.type === "NoteCard" ? card.displayProps.text ?? card.displayProps.bullets?.join("\n") ?? "" : card.type === "CountdownCard" ? card.sourceData.reminderText ?? "" : "");
  const revision = useRef(0);
  return <HostedDialog title="编辑卡片" onClose={onClose}><form className="hosted-form" onSubmit={event => { event.preventDefault(); const started = revision.current; if (text.trim() && !busy) void onSave(text.trim()).then(ok => { if (ok && started === revision.current) onClose(); }); }}><label>内容<textarea aria-label="编辑卡片内容" value={text} onChange={event => { revision.current++; setText(event.target.value); }} maxLength={card.type === "NoteCard" ? 500 : 160} rows={7} /></label>{notice && <p role="status" className="hosted-muted">{notice}</p>}<button className="hosted-primary" disabled={busy || !text.trim()}>保存</button></form></HostedDialog>;
}
