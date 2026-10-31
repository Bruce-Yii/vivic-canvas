import { useEffect, useState } from "react";
import { Pencil } from "lucide-react";
import { absoluteReminderTime, type CountdownCard, type CountdownEvent } from "@/contracts";
import { SceneCardShell } from "../SceneCardShell";
import { useCardActions, useCardEditor } from "../cardContext";
import { daysBetween, formatFullDate, formatMonthDay, todayIn, weekdayLabel } from "../dates";
import type { CardViewProps } from "../types";

const two = (n: number) => String(n).padStart(2, "0");

/** Calendar-day countdown; hours appear only on the final day of a timed event. */
export function describeCountdown(event: CountdownEvent, targetAt: string, timeZone: string | undefined, now: number) {
  const today = todayIn(timeZone, now);
  const days = daysBetween(today, event.date);
  if (days > 0) return { kind: "future" as const, value: String(days), unit: "天", caption: `距离${event.title}还有` };
  if (days < 0) return { kind: "past" as const, value: String(-days), unit: "天", caption: `${event.title}已经过去` };
  const left = Date.parse(targetAt) - now;
  if (event.time && left > 0) {
    const minutes = Math.ceil(left / 60_000);
    return { kind: "today" as const, value: `${Math.floor(minutes / 60)}:${two(minutes % 60)}`, unit: "", caption: `今天 ${event.time} · ${event.title}` };
  }
  return { kind: "today" as const, value: "今天", unit: "", caption: `就是今天 · ${event.title}` };
}

export function CountdownDateView({ card, height }: CardViewProps<"CountdownCard">) {
  const event = card.sourceData.event!;
  const { timeZone, targetAt, startedAt } = card.sourceData;
  const [now, setNow] = useState(() => Date.now());
  const finalDay = daysBetween(todayIn(timeZone, now), event.date) === 0;
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), finalDay && event.time ? 1000 : 30_000);
    return () => clearInterval(timer);
  }, [finalDay, event.time]);
  const view = describeCountdown(event, targetAt, timeZone, now);
  const start = startedAt ? Date.parse(startedAt) : Date.parse(card.metadata.createdAt);
  const total = Date.parse(targetAt) - start;
  const progress = total > 0 ? Math.min(1, Math.max(0, (now - start) / total)) : 1;
  const editor = useCardEditor(card);
  const [editing, setEditing] = useState(false);
  return <SceneCardShell card={card} height={height}
    badge={`${formatMonthDay(event.date)} ${weekdayLabel(event.date)}${event.time ? ` ${event.time}` : ""}`}
    badgeTone={view.kind === "past" ? "neutral" : "accent"}
    footer={editor.editable ? <button type="button" className="vivic-scene-action nodrag" onClick={() => setEditing(value => !value)} data-scene-edit>
      <Pencil size={13} aria-hidden />{editing ? "收起编辑" : "修改日期"}</button> : undefined}>
    <p className="vivic-scene-muted m-0 text-[13px]" data-countdown-caption>{view.caption}</p>
    <div className="flex items-end gap-2" data-countdown-kind={view.kind}>
      <span className="vivic-scene-number text-[52px]" data-countdown-value>{view.value}</span>
      {view.unit && <span className="pb-1.5 text-base font-medium">{view.unit}</span>}
    </div>
    {view.kind === "future" && <div className="vivic-scene-bar" role="progressbar" aria-label="等待进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
      <i style={{ width: `${Math.max(2, progress * 100)}%` }} />
    </div>}
    <p className="vivic-scene-muted vivic-scene-clamp-2 m-0 text-[12.5px]">{event.note ?? formatFullDate(event.date)}</p>
    {editing && editor.editable && <CountdownEditor card={card} onDone={() => setEditing(false)} />}
  </SceneCardShell>;
}

function CountdownEditor({ card, onDone }: { card: CountdownCard; onDone: () => void }) {
  const actions = useCardActions();
  const event = card.sourceData.event!;
  const [title, setTitle] = useState(event.title);
  const [date, setDate] = useState(event.date);
  const [time, setTime] = useState(event.time ?? "");
  const [error, setError] = useState<string | null>(null);
  return <form className="grid gap-2 nodrag" onSubmit={submit => {
    submit.preventDefault();
    const timeZone = card.sourceData.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    let targetAt: string;
    try { targetAt = absoluteReminderTime(date, time || "00:00", timeZone); } catch { setError("这个日期或时间无效，请重新选择。"); return; }
    const next: CountdownEvent = { ...event, title: title.trim() || event.title, date, ...(time ? { time } : { time: undefined }) };
    if (!time) delete next.time;
    if (actions?.update(card.id, { sourceData: { event: next, targetAt, timeZone } })) onDone(); else setError("没有保存，请检查控制权后重试。");
  }}>
    <input className="vivic-scene-input" value={title} maxLength={60} onChange={change => setTitle(change.target.value)} aria-label="倒计时事项" />
    <div className="flex gap-2">
      <input className="vivic-scene-input flex-1" type="date" value={date} required onChange={change => setDate(change.target.value)} aria-label="目标日期" />
      <input className="vivic-scene-input w-28" type="time" value={time} onChange={change => setTime(change.target.value)} aria-label="时间（可选）" />
    </div>
    <div className="flex items-center justify-end gap-2">
      {error && <span role="alert" className="mr-auto text-xs text-[var(--vivic-danger)]">{error}</span>}
      <button type="submit" className="vivic-scene-action" data-variant="primary">保存</button>
    </div>
  </form>;
}
