import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { MapPin, Plus, X } from "lucide-react";
import type { WeeklyScheduleCard } from "@/contracts";
import { SceneCardShell } from "../SceneCardShell";
import { useCardEditor } from "../cardContext";
import { WEEKDAY_LABELS, addDays, daysBetween, formatMonthDay, parseIsoDate, todayIn } from "../dates";
import type { CardViewProps } from "../types";
import "./WeeklyScheduleCardView.css";

type ScheduleEvent = WeeklyScheduleCard["displayProps"]["events"][number];

const MAX_EVENTS = 60;
const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
/** Height reserved for the "+N" line at the bottom of a clipped day column. */
const MORE_ROW = 18;
const pad = (n: number) => String(n).padStart(2, "0");
const dayName = (day: number) => `周${WEEKDAY_LABELS[day - 1] ?? ""}`;
const timeLabel = (event: ScheduleEvent) => event.start ? `${event.start}${event.end ? `–${event.end}` : ""}` : "";
/** Untimed (all-day style) entries first, then by start time; ties keep the given order. */
const byTime = (a: ScheduleEvent, b: ScheduleEvent) => (a.start ? 1 : 0) - (b.start ? 1 : 0) || (a.start ?? "").localeCompare(b.start ?? "");

function useNow(intervalMs = 60_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * Display: rows that would be cut off by their fixed-height list are hidden
 * with visibility (layout is kept, so re-measuring is stable) and counted per
 * list, so the view can show "+N" instead of a half-visible chip.
 */
function useClippedRows(enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState<Record<string, number>>({});
  const measure = useCallback(() => {
    const root = ref.current;
    if (!root) return;
    const next: Record<string, number> = {};
    root.querySelectorAll<HTMLElement>("[data-clip-list]").forEach(list => {
      const limit = list.clientHeight;
      const rows = Array.from(list.children).filter((row): row is HTMLElement => row instanceof HTMLElement && row.hasAttribute("data-clip-row"));
      if (!limit || !rows.length) return;
      const fit = (reserve: number) => rows.filter(row => row.offsetTop + row.offsetHeight <= limit - reserve + 1).length;
      let shown = fit(0);
      if (shown < rows.length) shown = fit(MORE_ROW);
      if (shown < rows.length) next[list.dataset.clipList ?? ""] = rows.length - shown;
    });
    setHidden(prev => {
      const keys = Object.keys(next);
      return keys.length === Object.keys(prev).length && keys.every(key => prev[key] === next[key]) ? prev : next;
    });
  }, []);
  useLayoutEffect(() => { if (enabled) measure(); });
  useEffect(() => {
    const root = ref.current;
    if (!enabled || !root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(root);
    return () => observer.disconnect();
  }, [enabled, measure]);
  return { ref, hidden: enabled ? hidden : {} };
}

/** The footer line: what comes next this week, or the first entry of another week. */
function nextUp(events: ScheduleEvent[], todayIndex: number | null, weekOffset: number, clock: string): string {
  const sorted = events.filter(event => event.day >= 1 && event.day <= 7).sort((a, b) => a.day - b.day || byTime(a, b));
  if (!sorted.length) return "本周没有安排";
  const describe = (prefix: string, event: ScheduleEvent) =>
    `${prefix} · ${event.day === todayIndex ? "今天" : dayName(event.day)}${event.start ? ` ${event.start}` : ""} ${event.title}`;
  if (todayIndex === null) return describe(weekOffset > 7 ? "首个安排" : "接下来", sorted[0]!);
  const next = sorted.find(event => !event.done && (event.day > todayIndex
    || (event.day === todayIndex && (!event.start || (event.end ?? event.start) > clock))));
  if (!next) return "本周接下来没有安排";
  const ongoing = next.day === todayIndex && next.start !== undefined && next.start <= clock;
  return describe(ongoing ? "进行中" : "接下来", next);
}

export function WeeklyScheduleCardView({ card, height }: CardViewProps<"WeeklyScheduleCard">) {
  const { title, weekStart, events } = card.displayProps;
  const editor = useCardEditor(card);
  const now = useNow();
  const valid = parseIsoDate(weekStart) !== null;
  const today = todayIn(undefined, now);
  const weekOffset = valid ? daysBetween(weekStart, today) + 1 : Number.NaN;
  const todayIndex = weekOffset >= 1 && weekOffset <= 7 ? weekOffset : null;
  const clock = `${pad(new Date(now).getHours())}:${pad(new Date(now).getMinutes())}`;
  const fixed = height !== undefined;
  const { ref, hidden } = useClippedRows(editor.mode === "display" && fixed);
  const setEvents = (next: ScheduleEvent[]) => editor.patch({ events: next });
  const days = WEEKDAY_LABELS.map((_, index) => {
    const day = index + 1;
    const date = valid ? parseIsoDate(addDays(weekStart, index)) : null;
    return { day, date: date?.day, events: events.filter(event => event.day === day).sort(byTime) };
  });
  return <SceneCardShell card={card} height={height} title={title}
    badge={valid ? `${formatMonthDay(weekStart)} – ${formatMonthDay(addDays(weekStart, 6))}` : undefined}
    badgeTone={todayIndex === null ? "neutral" : "accent"}
    footer={<>
      <span className="min-w-0 truncate" data-week-next>{nextUp(events, todayIndex, weekOffset, clock)}</span>
      {events.length > 0 && <span className="shrink-0 tabular-nums">{events.length} 项</span>}
    </>}>
    <div ref={ref} className={`vivic-week${fixed ? " vivic-scene-scroll nowheel" : ""}`}>
      <div className="vivic-week-days">
        {days.map(day => {
          const clipped = hidden[String(day.day)] ?? 0;
          return <section key={day.day} className="vivic-week-day" data-week-day={day.day} data-today={day.day === todayIndex || undefined}
            aria-label={`${dayName(day.day)}${day.date ? ` ${day.date}日` : ""}，${day.events.length} 项安排`}>
            <header className="vivic-week-day-head">
              <span>{day.day === todayIndex ? "今天" : dayName(day.day)}</span>
              {day.date !== undefined && <strong>{day.date}</strong>}
            </header>
            <div className="vivic-week-list" data-clip-list={day.day}>
              {day.events.map((event, index) => <div key={event.id} className="vivic-week-item" data-clip-row
                data-clipped={index >= day.events.length - clipped || undefined} aria-hidden={index >= day.events.length - clipped || undefined}>
                <EventChip event={event} editable={editor.editable}
                  onToggle={() => setEvents(events.map(row => row.id === event.id ? { ...row, done: !row.done } : row))} />
                {editor.editable && <button type="button" className="vivic-scene-icon-button vivic-week-delete nodrag nopan"
                  aria-label={`删除：${event.title.slice(0, 40)}`} onClick={() => setEvents(events.filter(row => row.id !== event.id))}><X size={12} /></button>}
              </div>)}
              {!day.events.length && <span className="vivic-week-none">无安排</span>}
              {clipped > 0 && <span className="vivic-week-more" data-week-more={clipped}>+{clipped}</span>}
            </div>
          </section>;
        })}
      </div>
    </div>
    {editor.editable && <AddEventForm events={events} defaultDay={todayIndex ?? 1} onAdd={next => setEvents(next)} />}
  </SceneCardShell>;
}

function EventChip({ event, editable, onToggle }: { event: ScheduleEvent; editable: boolean; onToggle: () => void }) {
  const time = timeLabel(event);
  const content = <>
    {event.start && <span className="vivic-week-time">{event.start}{event.end && <>–<wbr />{event.end}</>}</span>}
    <span className="vivic-week-title vivic-scene-clamp-2">{event.title}</span>
    {event.location && <span className="vivic-week-place"><MapPin size={10} aria-hidden /><span className="truncate">{event.location}</span></span>}
  </>;
  const label = `${time ? `${time} ` : ""}${event.title}${event.location ? ` · ${event.location}` : ""}`;
  return editable
    ? <button type="button" role="checkbox" aria-checked={Boolean(event.done)} data-untimed={!event.start || undefined} aria-label={`${label}（点按标记${event.done ? "未完成" : "完成"}）`}
      className="vivic-week-event nodrag nopan" data-done={event.done || undefined} data-week-event={event.id} onClick={onToggle}>{content}</button>
    : <div className="vivic-week-event" data-untimed={!event.start || undefined} data-done={event.done || undefined} data-week-event={event.id} title={label}>{content}</div>;
}

function AddEventForm({ events, defaultDay, onAdd }: { events: ScheduleEvent[]; defaultDay: number; onAdd: (next: ScheduleEvent[]) => boolean }) {
  const [day, setDay] = useState(defaultDay);
  const [time, setTime] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const full = events.length >= MAX_EVENTS;
  return <form className="vivic-week-form nodrag nopan" data-week-add onSubmit={submit => {
    submit.preventDefault();
    const titleText = text.trim().slice(0, 80);
    if (!titleText || full) return;
    const start = time.slice(0, 5);
    const used = new Set(events.map(event => event.id));
    let n = events.length + 1;
    while (used.has(`ev-${n}`)) n += 1;
    const event: ScheduleEvent = { id: `ev-${n}`, day, title: titleText, ...(CLOCK.test(start) ? { start } : {}) };
    if (onAdd([...events, event])) { setText(""); setTime(""); setError(null); } else setError("没有保存，请检查后重试。");
  }}>
    <select className="vivic-scene-input nodrag nopan" value={day} aria-label="星期" onChange={change => setDay(Number(change.target.value))}>
      {WEEKDAY_LABELS.map((label, index) => <option key={label} value={index + 1}>周{label}</option>)}
    </select>
    <input className="vivic-scene-input vivic-week-form-time nodrag nopan" type="time" value={time} aria-label="开始时间（可选）" onChange={change => setTime(change.target.value)} />
    <input className="vivic-scene-input vivic-week-form-title nodrag nopan" value={text} maxLength={80} placeholder={full ? `最多 ${MAX_EVENTS} 项安排` : "添加安排"}
      aria-label="安排内容" disabled={full} onChange={change => setText(change.target.value)} />
    <button type="submit" className="vivic-scene-action nodrag nopan" disabled={full || !text.trim()}><Plus size={14} aria-hidden />添加</button>
    {error && <span role="alert" className="w-full text-xs text-[var(--vivic-danger)]">{error}</span>}
  </form>;
}
