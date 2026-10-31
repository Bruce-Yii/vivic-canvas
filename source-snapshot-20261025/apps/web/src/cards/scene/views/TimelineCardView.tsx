import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import type { TimelineCard } from "@/contracts";
import { SceneCardShell, SceneEmpty } from "../SceneCardShell";
import { useCardEditor } from "../cardContext";
import { formatPartialDate, partialDateKey } from "../dates";
import type { CardViewProps } from "../types";
import "./TimelineCardView.css";

type TimelineEvent = TimelineCard["displayProps"]["events"][number];

const MAX_EVENTS = 40;
const PARTIAL_DATE = /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/;

/** Display: whether the scroll region still hides content below, to draw a soft bottom fade. */
function useMoreBelow(enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const check = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const next = element.scrollHeight - element.scrollTop - element.clientHeight > 2;
    setMore(prev => prev === next ? prev : next);
  }, []);
  useLayoutEffect(() => { if (enabled) check(); });
  useEffect(() => {
    const element = ref.current;
    if (!enabled || !element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => check());
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled, check]);
  return { ref, more: enabled && more, check };
}

export function TimelineCardView({ card, height }: CardViewProps<"TimelineCard">) {
  const { title, order, events } = card.displayProps;
  const editor = useCardEditor(card);
  const fixed = height !== undefined;
  const scroll = useMoreBelow(fixed);
  const chronological = useMemo(() => events.map((event, index) => ({ event, index, key: partialDateKey(event.date) }))
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index).map(entry => entry.event), [events]);
  const shown = order === "desc" ? [...chronological].reverse() : chronological;
  const latestId = chronological.at(-1)?.id;
  const years = events.map(event => Number(event.date.slice(0, 4))).filter(Number.isFinite);
  const first = years.length ? Math.min(...years) : null, last = years.length ? Math.max(...years) : null;
  const list = <ol className="vivic-timeline" data-order={order ?? "asc"}>
    {shown.map(event => <li key={event.id} className="vivic-timeline-item" data-latest={event.id === latestId || undefined} data-timeline-event={event.id}>
      <span className="vivic-timeline-dot" aria-hidden />
      <div className="vivic-timeline-text">
        <time className="vivic-timeline-date" dateTime={PARTIAL_DATE.test(event.date) ? event.date : undefined}>{formatPartialDate(event.date)}</time>
        <strong className="vivic-timeline-title vivic-scene-clamp-2">{event.title}</strong>
        {event.description && <p className={`vivic-timeline-desc${editor.editable ? "" : " vivic-scene-clamp-2"}`}>{event.description}</p>}
      </div>
      {editor.editable && events.length > 1 && <button type="button" className="vivic-scene-icon-button vivic-timeline-delete nodrag nopan"
        aria-label={`删除：${event.title.slice(0, 40)}`} onClick={() => editor.patch({ events: events.filter(row => row.id !== event.id) })}><X size={13} /></button>}
    </li>)}
  </ol>;
  return <SceneCardShell card={card} height={height} title={title}
    badge={first !== null && last !== null && first !== last ? `${first} – ${last}` : `${events.length} 个节点`}
    footer={editor.editable ? <div className="vivic-timeline-order" role="group" aria-label="排列顺序">
      {(["asc", "desc"] as const).map(value => <button key={value} type="button" className="vivic-scene-chip nodrag nopan" aria-pressed={(order ?? "asc") === value}
        data-timeline-order={value} onClick={() => { if ((order ?? "asc") !== value) editor.patch({ order: value }); }}>{value === "asc" ? "正序" : "倒序"}</button>)}
    </div> : undefined}>
    {events.length === 0 ? <SceneEmpty>还没有时间节点</SceneEmpty>
      : fixed
        ? <div ref={scroll.ref} className="vivic-timeline-scroll vivic-scene-scroll nowheel" data-more={scroll.more || undefined} onScroll={scroll.check}>{list}</div>
        : list}
    {editor.editable && <AddEventForm events={events} onAdd={next => editor.patch({ events: next })} />}
  </SceneCardShell>;
}

function AddEventForm({ events, onAdd }: { events: TimelineEvent[]; onAdd: (next: TimelineEvent[]) => boolean }) {
  const [date, setDate] = useState("");
  const [text, setText] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const full = events.length >= MAX_EVENTS;
  return <form className="vivic-timeline-form nodrag nopan" data-timeline-add onSubmit={submit => {
    submit.preventDefault();
    const day = date.trim(), titleText = text.trim().slice(0, 100), note = description.trim().slice(0, 300);
    if (full || !titleText) return;
    if (!PARTIAL_DATE.test(day)) { setError("日期请写成 2024、2024-05 或 2024-05-20"); return; }
    const used = new Set(events.map(event => event.id));
    let n = events.length + 1;
    while (used.has(`ev-${n}`)) n += 1;
    const event: TimelineEvent = { id: `ev-${n}`, date: day, title: titleText, ...(note ? { description: note } : {}) };
    if (onAdd([...events, event])) { setDate(""); setText(""); setDescription(""); setError(null); } else setError("没有保存，请检查后重试。");
  }}>
    <div className="vivic-timeline-form-row">
      <input className="vivic-scene-input vivic-timeline-form-date nodrag nopan" value={date} maxLength={10} inputMode="numeric" placeholder="2024-05-20"
        aria-label="日期（年、年-月或年-月-日）" disabled={full} onChange={change => { setDate(change.target.value); setError(null); }} />
      <input className="vivic-scene-input vivic-timeline-form-title nodrag nopan" value={text} maxLength={100}
        placeholder={full ? `最多 ${MAX_EVENTS} 个节点` : "添加一个时间节点"} aria-label="节点标题" disabled={full} onChange={change => setText(change.target.value)} />
    </div>
    <div className="vivic-timeline-form-row">
      <input className="vivic-scene-input vivic-timeline-form-title nodrag nopan" value={description} maxLength={300} placeholder="补充说明（可选）"
        aria-label="补充说明（可选）" disabled={full} onChange={change => setDescription(change.target.value)} />
      <button type="submit" className="vivic-scene-action nodrag nopan" disabled={full || !text.trim() || !date.trim()}><Plus size={14} aria-hidden />添加</button>
    </div>
    {error && <span role="alert" className="text-xs text-[var(--vivic-danger)]">{error}</span>}
  </form>;
}
