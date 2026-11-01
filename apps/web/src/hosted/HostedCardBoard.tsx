import { lazy, Suspense, useRef, useState, type FormEvent, type PointerEvent } from "react";
import { CardRecordSchema, cardTitle, NoteSectionsSchema, type CardRecord, type HostedSpaceCommand, type NoteSection } from "@vivic/contracts";
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
    {editing && <NoteEditor card={editing.card} busy={busy} notice={notice} onClose={() => setEditing(null)} onSave={async value => {
      const card = editing.card;
      const command: HostedSpaceCommand = card.type === "NoteCard"
        ? { type: "card.update", cardId: card.id, displayProps: "sections" in value ? { sections: value.sections } : { text: value.text } }
        : { type: "card.update", cardId: card.id, sourceData: { reminderText: "text" in value ? value.text : "" } };
      // A rejected command must reach the editor as a visible failure, never
      // close the dialog as if the note had been saved.
      return onCommand(command, undefined, editing.expectedVersion).catch(() => false);
    }} />}
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
type NoteEditorValue = { text: string } | { sections: NoteSection[] };
const NOTE_SAVE_FAILED = "保存未成功，内容仍保留在此处，请重试。";

/**
 * One note shape at a time: text cards keep text, section cards edit their
 * headings and lines in place. Validation happens before dispatch, and a
 * rejected save keeps the dialog and the draft visible instead of closing as
 * if nothing happened.
 */
function NoteEditor({ card, busy, notice, onClose, onSave }: { card: CardRecord; busy: boolean; notice: string; onClose(): void; onSave(value: NoteEditorValue): Promise<boolean> }) {
  const sectionsMode = card.type === "NoteCard" && Boolean(card.displayProps.sections?.length);
  const [text, setText] = useState(card.type === "NoteCard" ? card.displayProps.text ?? card.displayProps.bullets?.join("\n") ?? "" : card.type === "CountdownCard" ? card.sourceData.reminderText ?? "" : "");
  const [sections, setSections] = useState<NoteSection[]>(() => sectionsMode && card.type === "NoteCard"
    ? (card.displayProps.sections ?? []).map(section => ({ title: section.title, items: [...section.items] })) : []);
  const [failure, setFailure] = useState("");
  const revision = useRef(0);
  const edit = (change: () => void) => { revision.current += 1; setFailure(""); change(); };
  const editSection = (index: number, change: (section: NoteSection) => NoteSection) => edit(() =>
    setSections(current => current.map((section, position) => position === index ? change(section) : section)));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const started = revision.current;
    const settle = (saved: boolean) => {
      if (!saved) { setFailure(NOTE_SAVE_FAILED); return; }
      if (started === revision.current) onClose();
    };
    if (sectionsMode) {
      const candidate = sections
        .map(section => ({ title: section.title.trim(), items: section.items.map(item => item.trim()).filter(Boolean) }))
        .filter(section => section.title || section.items.length);
      const parsed = NoteSectionsSchema.safeParse(candidate);
      if (!parsed.success) { setFailure("请填写 1–4 个分区，每个分区标题必填、至少 1 条内容，每区最多 6 条。"); return; }
      void onSave({ sections: parsed.data }).then(settle).catch(() => setFailure(NOTE_SAVE_FAILED));
    } else {
      if (!text.trim()) { setFailure("内容不能为空。"); return; }
      void onSave({ text: text.trim() }).then(settle).catch(() => setFailure(NOTE_SAVE_FAILED));
    }
  };
  return <HostedDialog title="编辑卡片" onClose={onClose}><form className="hosted-form" data-hosted-note-editor={sectionsMode ? "sections" : "text"} onSubmit={submit}>
    {sectionsMode ? <div className="flex min-w-0 flex-col gap-3">
      {sections.map((section, sectionIndex) => <fieldset key={sectionIndex} className="m-0 flex min-w-0 flex-col gap-2 rounded-2xl border border-[var(--hark-stroke)] p-3"
        data-hosted-note-section={sectionIndex + 1}>
        <legend className="px-1 text-[13px] leading-5 text-[var(--hark-secondary)]">分区 {sectionIndex + 1}</legend>
        <input aria-label={`分区 ${sectionIndex + 1} 标题`} value={section.title} maxLength={40} placeholder="分区标题"
          onChange={event => { const value = event.target.value; editSection(sectionIndex, current => ({ ...current, title: value })); }} />
        {section.items.map((item, itemIndex) => <div key={itemIndex} className="flex min-w-0 items-center gap-1">
          <input aria-label={`分区 ${sectionIndex + 1} 第 ${itemIndex + 1} 条`} value={item} maxLength={180} placeholder="条目" className="min-w-0 flex-1"
            onChange={event => { const value = event.target.value; editSection(sectionIndex, current => ({ ...current, items: current.items.map((entry, position) => position === itemIndex ? value : entry) })); }} />
          <button type="button" className="hark-icon-button shrink-0" aria-label={`删除分区 ${sectionIndex + 1} 第 ${itemIndex + 1} 条`} disabled={busy || section.items.length < 2}
            onClick={() => editSection(sectionIndex, current => ({ ...current, items: current.items.filter((_, position) => position !== itemIndex) }))}><HarkIcon name="trash" /></button>
        </div>)}
        <div className="flex flex-wrap items-center gap-1">
          {section.items.length < 6 && <button type="button" className="hosted-quiet" disabled={busy}
            onClick={() => editSection(sectionIndex, current => ({ ...current, items: [...current.items, ""] }))}>添加条目</button>}
          {sections.length > 1 && <button type="button" className="hosted-quiet" aria-label={`删除分区 ${sectionIndex + 1}`} disabled={busy}
            onClick={() => edit(() => setSections(current => current.filter((_, position) => position !== sectionIndex)))}>删除分区</button>}
        </div>
      </fieldset>)}
      {sections.length < 4 && <button type="button" className="hosted-quiet self-start" disabled={busy}
        onClick={() => edit(() => setSections(current => [...current, { title: "", items: [""] }]))}>添加分区</button>}
    </div> : <label>内容<textarea aria-label="编辑卡片内容" value={text} maxLength={card.type === "NoteCard" ? 500 : 160} rows={7}
      onChange={event => { const value = event.target.value; revision.current += 1; setFailure(""); setText(value); }} /></label>}
    {failure && <p role="alert" className="hosted-error" data-hosted-note-error>{failure}</p>}
    {notice && <p role="status" className="hosted-muted">{notice}</p>}
    <button className="hosted-primary" disabled={busy || (!sectionsMode && !text.trim())}>保存</button>
  </form></HostedDialog>;
}
