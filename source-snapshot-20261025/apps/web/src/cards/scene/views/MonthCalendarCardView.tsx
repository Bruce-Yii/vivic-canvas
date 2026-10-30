import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ChevronLeft, ChevronRight, Plus, X } from "lucide-react";
import type { MonthCalendarCard } from "@/contracts";
import { SceneCardShell } from "../SceneCardShell";
import { useCardEditor } from "../cardContext";
import { WEEKDAY_LABELS, formatFullDate, formatMonthDay, monthGrid, parseIsoDate, shiftMonth, todayIn } from "../dates";
import type { CardViewProps } from "../types";
import "./MonthCalendarCardView.css";

type CalendarEvent = MonthCalendarCard["displayProps"]["events"][number];

const MAX_EVENTS = 80;
const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
/** Display rhythm (px): shell header + title, toolbar, weekday row, the gaps and the smallest agenda. */
const CHROME = 64, TOOLBAR = 32, WEEKDAYS = 16, AGENDA_MIN = 56, ROW_GAP = 2;
const monthLabel = (month: string) => {
  const match = MONTH.exec(month);
  return match ? `${match[1]}年${Number(match[2])}月` : month;
};
const byTime = (a: CalendarEvent, b: CalendarEvent) => (a.time ? 1 : 0) - (b.time ? 1 : 0) || (a.time ?? "").localeCompare(b.time ?? "");

function useNow(intervalMs = 60_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Display: whether the agenda still hides rows below, to draw a soft bottom fade. */
function useMoreBelow(enabled: boolean) {
  const ref = useRef<HTMLUListElement>(null);
  const [more, setMore] = useState(false);
  const check = useCallback(() => {
    const element = ref.current;
    const next = Boolean(element && element.scrollHeight - element.scrollTop - element.clientHeight > 2);
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

export function MonthCalendarCardView({ card, height }: CardViewProps<"MonthCalendarCard">) {
  const { title, month, events } = card.displayProps;
  const editor = useCardEditor(card);
  const today = todayIn(undefined, useNow());
  // View-local navigation; a new month from the owner resets it.
  const [nav, setNav] = useState({ base: month, shown: month });
  const shown = nav.base === month ? nav.shown : month;
  const valid = MONTH.test(shown);
  const go = (next: string) => setNav({ base: month, shown: next });
  const [picked, setPicked] = useState<{ month: string; date: string } | null>(null);
  const grid = useMemo(() => valid ? monthGrid(shown) : [], [shown, valid]);
  const byDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const event of events) map.set(event.date, [...(map.get(event.date) ?? []), event]);
    for (const list of map.values()) list.sort(byTime);
    return map;
  }, [events]);
  const inMonth = events.filter(event => event.date.startsWith(`${shown}-`));
  const fallbackDay = today.startsWith(`${shown}-`) ? today : inMonth.map(event => event.date).sort()[0] ?? `${shown}-01`;
  const selected = picked?.month === shown ? picked.date : fallbackDay;
  const dayEvents = byDate.get(selected) ?? [];
  const select = (date: string) => {
    const target = date.slice(0, 7);
    if (target !== shown) go(target);
    setPicked({ month: target, date });
  };
  const rows = Math.max(4, Math.ceil(grid.length / 7));
  const cellHeight = height === undefined ? 36
    : Math.max(18, Math.min(30, Math.floor((height - CHROME - TOOLBAR - WEEKDAYS - AGENDA_MIN - ROW_GAP * (rows - 1)) / rows)));
  const currentMonth = today.slice(0, 7);
  const agenda = useMoreBelow(height !== undefined);
  return <SceneCardShell card={card} height={height} title={title ?? monthLabel(shown)}
    badge={`${inMonth.length} 项安排`} badgeTone={inMonth.length ? "accent" : "neutral"}>
    <div className="vivic-month" style={{ "--month-cell": `${cellHeight}px` } as CSSProperties}>
      <div className="vivic-month-toolbar">
        {title && <strong className="vivic-month-label" data-month-label>{monthLabel(shown)}</strong>}
        {shown !== month && <button type="button" className="vivic-scene-link vivic-month-reset nodrag nopan" data-month-reset onClick={() => go(month)}>
          {month === currentMonth ? "回到本月" : `回到${MONTH.test(month) ? `${Number(month.slice(5, 7))}月` : "原月份"}`}
        </button>}
        <span className="vivic-month-nav">
          <button type="button" className="vivic-scene-icon-button nodrag nopan" aria-label="上个月" disabled={!valid} onClick={() => go(shiftMonth(shown, -1))}><ChevronLeft size={15} /></button>
          <button type="button" className="vivic-scene-icon-button nodrag nopan" aria-label="下个月" disabled={!valid} onClick={() => go(shiftMonth(shown, 1))}><ChevronRight size={15} /></button>
        </span>
      </div>
      <div className="vivic-month-weekdays" aria-hidden>{WEEKDAY_LABELS.map(label => <span key={label}>{label}</span>)}</div>
      <div className="vivic-month-grid" role="group" aria-label={monthLabel(shown)}>
        {grid.map(({ date, inMonth: inside }) => {
          const count = byDate.get(date)?.length ?? 0;
          return <button key={date} type="button" className="vivic-month-day nodrag nopan" data-date={date}
            data-out={!inside || undefined} data-today={date === today || undefined} data-selected={date === selected || undefined}
            aria-pressed={date === selected} aria-label={`${formatMonthDay(date)}${date === today ? "（今天）" : ""}，${count ? `${count} 项安排` : "没有安排"}`}
            onClick={() => select(date)}>
            <span className="vivic-month-num">{parseIsoDate(date)?.day ?? ""}</span>
            <span className="vivic-month-dots" aria-hidden>{Array.from({ length: Math.min(3, count) }, (_, index) => <i key={index} />)}</span>
          </button>;
        })}
      </div>
      <section className="vivic-month-agenda" aria-label={`${formatFullDate(selected)}的安排`} data-month-agenda={selected}>
        <header className="vivic-month-agenda-head">
          <span>{parseIsoDate(selected) ? formatFullDate(selected) : selected}</span>
          {dayEvents.length > 1 && <span className="tabular-nums">{dayEvents.length} 项</span>}
        </header>
        {dayEvents.length
          ? <ul ref={agenda.ref} className={`vivic-month-list${height !== undefined ? " vivic-scene-scroll nowheel" : ""}`}
            data-more={agenda.more || undefined} onScroll={agenda.check}>
            {dayEvents.map(event => <li key={event.id} data-month-event={event.id}>
              <span className="vivic-month-time">{event.time ?? ""}</span>
              <span className={editor.editable ? "vivic-scene-clamp-2" : "truncate"} title={event.title}>{event.title}</span>
              {editor.editable && <button type="button" className="vivic-scene-icon-button vivic-month-delete nodrag nopan" aria-label={`删除：${event.title.slice(0, 40)}`}
                onClick={() => editor.patch({ events: events.filter(row => row.id !== event.id) })}><X size={13} /></button>}
            </li>)}
          </ul>
          : <p className="vivic-month-none">这天没有安排</p>}
        {editor.editable && parseIsoDate(selected) && <AddEventForm key={selected} date={selected} events={events}
          onAdd={next => editor.patch({ events: next })} />}
      </section>
    </div>
  </SceneCardShell>;
}

function AddEventForm({ date, events, onAdd }: { date: string; events: CalendarEvent[]; onAdd: (next: CalendarEvent[]) => boolean }) {
  const [text, setText] = useState("");
  const [time, setTime] = useState("");
  const [error, setError] = useState<string | null>(null);
  const full = events.length >= MAX_EVENTS;
  return <form className="vivic-month-form nodrag nopan" data-month-add onSubmit={submit => {
    submit.preventDefault();
    const titleText = text.trim().slice(0, 60);
    if (!titleText || full) return;
    const clock = time.slice(0, 5);
    const used = new Set(events.map(event => event.id));
    let n = events.length + 1;
    while (used.has(`ev-${n}`)) n += 1;
    const event: CalendarEvent = { id: `ev-${n}`, date, title: titleText, ...(CLOCK.test(clock) ? { time: clock } : {}) };
    if (onAdd([...events, event])) { setText(""); setTime(""); setError(null); } else setError("没有保存，请检查后重试。");
  }}>
    <input className="vivic-scene-input vivic-month-form-title nodrag nopan" value={text} maxLength={60} disabled={full}
      placeholder={full ? `最多 ${MAX_EVENTS} 项安排` : `在${formatMonthDay(date)}添加安排`} aria-label="安排内容" onChange={change => setText(change.target.value)} />
    <input className="vivic-scene-input vivic-month-form-time nodrag nopan" type="time" value={time} aria-label="时间（可选）" onChange={change => setTime(change.target.value)} />
    <button type="submit" className="vivic-scene-action nodrag nopan" disabled={full || !text.trim()}><Plus size={14} aria-hidden />添加</button>
    {error && <span role="alert" className="w-full text-xs text-[var(--vivic-danger)]">{error}</span>}
  </form>;
}
