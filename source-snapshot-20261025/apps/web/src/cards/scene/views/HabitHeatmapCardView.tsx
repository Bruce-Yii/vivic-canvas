import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Check, Flame } from "lucide-react";
import { SceneCardShell } from "../SceneCardShell";
import { useCardEditor } from "../cardContext";
import { addDays, daysBetween, formatMonthDay, mondayOf, parseIsoDate, todayIn } from "../dates";
import type { CardViewProps } from "../types";
import "./HabitHeatmapCardView.css";

const MAX_CHECKINS = 800;
const GAP = 3;
const LABEL_WIDTH = 16;
const MONTH_ROW = 14;
const MAX_WEEKS = 17;
const ROW_LABELS = ["一", "", "三", "", "五", "", ""];
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function useNow(intervalMs = 60_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Content-box size of the heatmap area; null until the browser has laid it out. */
function useBoxSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const read = () => {
      const width = element.clientWidth, height = element.clientHeight;
      if (width > 0) setSize(prev => prev && prev.width === width && prev.height === height ? prev : { width, height });
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

export function habitStats(checked: ReadonlySet<string>, today: string) {
  const yesterday = addDays(today, -1);
  let current = 0;
  for (let day = checked.has(today) ? today : checked.has(yesterday) ? yesterday : null; day && checked.has(day) && current <= MAX_CHECKINS; day = addDays(day, -1)) current += 1;
  const sorted = [...checked].sort();
  let longest = 0, run = 0, prev = "";
  for (const day of sorted) {
    run = prev && daysBetween(prev, day) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = day;
  }
  const monday = mondayOf(today);
  return { current, longest, total: checked.size, week: sorted.filter(day => day >= monday && day <= today).length };
}

/** Cell size follows the available height on Display and the width on the user page. */
function gridMetrics(size: { width: number; height: number } | null, fixed: boolean) {
  if (!size) return { cell: 12, weeks: 15 };
  const columnsWidth = size.width - LABEL_WIDTH + GAP;
  const byWidth = Math.max(9, Math.floor(columnsWidth / MAX_WEEKS) - GAP);
  const byHeight = fixed ? Math.floor((size.height - MONTH_ROW - 6 * GAP) / 7) : 16;
  const cell = clamp(Math.min(byWidth, byHeight, fixed ? 14 : 16), 6, 16);
  return { cell, weeks: clamp(Math.floor(columnsWidth / (cell + GAP)), 4, MAX_WEEKS) };
}

export function HabitHeatmapCardView({ card, height }: CardViewProps<"HabitHeatmapCard">) {
  const { habit, checkins, weeklyGoal, startDate } = card.displayProps;
  const editor = useCardEditor(card);
  const now = useNow();
  const today = todayIn(undefined, now);
  const checked = useMemo(() => new Set(checkins.filter(day => parseIsoDate(day) !== null)), [checkins]);
  const stats = useMemo(() => habitStats(checked, today), [checked, today]);
  const fixed = height !== undefined;
  const [areaRef, size] = useBoxSize<HTMLDivElement>();
  const { cell, weeks } = gridMetrics(size, fixed);
  const firstMonday = addDays(mondayOf(today), -7 * (weeks - 1));
  const columns = Array.from({ length: weeks }, (_, week) => Array.from({ length: 7 }, (_, day) => addDays(firstMonday, week * 7 + day)));
  const months = columns.map(column => { const first = column.find(day => day.endsWith("-01")); return first ? `${Number(first.slice(5, 7))}月` : ""; });
  if (!months.slice(0, 3).some(Boolean)) months[0] = `${Number(firstMonday.slice(5, 7))}月`;
  const start = startDate && parseIsoDate(startDate) ? startDate : null;
  const doneToday = checked.has(today);
  const toggle = (day: string) => {
    if (!editor.editable || day > today) return;
    const next = new Set(checked);
    if (!next.delete(day)) next.add(day);
    editor.patch({ checkins: [...next].sort().slice(-MAX_CHECKINS) });
  };
  const weekGoalMet = weeklyGoal !== undefined && stats.week >= weeklyGoal;
  return <SceneCardShell card={card} height={height} title={habit}
    badge={`连续 ${stats.current} 天`} badgeTone={stats.current > 0 ? "positive" : "neutral"}
    footer={editor.editable ? <>
      <button type="button" className="vivic-scene-action vivic-heat-today nodrag nopan" data-variant={doneToday ? undefined : "primary"} data-habit-today
        aria-pressed={doneToday} onClick={() => toggle(today)}>
        {doneToday ? <Check size={15} aria-hidden /> : <Flame size={15} aria-hidden />}{doneToday ? "取消今天打卡" : "今天打卡"}
      </button>
      <span className="vivic-heat-legend" aria-hidden>未打卡<i /><i data-on />已打卡</span>
    </> : undefined}>
    {checked.size === 0
      ? <p className="vivic-heat-hint" data-habit-empty>还没有打卡记录{editor.editable ? "，点按下方按钮或格子开始打卡" : ""}</p>
      : <dl className="vivic-heat-stats">
        <div><dt>当前连续</dt><dd>{stats.current}<small>天</small></dd></div>
        <div><dt>最长连续</dt><dd>{stats.longest}<small>天</small></dd></div>
        <div><dt>累计打卡</dt><dd>{stats.total}<small>天</small></dd></div>
        <div data-met={weekGoalMet || undefined}><dt>本周</dt><dd>{weeklyGoal !== undefined ? <>{stats.week}<small>/{weeklyGoal}</small></> : <>{stats.week}<small>天</small></>}</dd></div>
      </dl>}
    <div ref={areaRef} className="vivic-heat-area">
      <div className="vivic-heat" style={{ "--heat-cell": `${cell}px`, "--heat-gap": `${GAP}px`, "--heat-weeks": weeks } as CSSProperties}
        role={editor.editable ? "group" : "img"} aria-label={`最近 ${weeks} 周的打卡记录，其中 ${columns.flat().filter(day => checked.has(day)).length} 天已打卡`}>
        <div className="vivic-heat-months" aria-hidden>
          {months.map((label, index) => <span key={index}>{label}</span>)}
        </div>
        <div className="vivic-heat-rows" aria-hidden>{ROW_LABELS.map((label, index) => <span key={index}>{label}</span>)}</div>
        <div className="vivic-heat-grid">
          {columns.flat().map(day => {
            const on = checked.has(day);
            const future = day > today;
            const state = { "data-on": on || undefined, "data-today": day === today || undefined, "data-future": future || undefined,
              "data-before": (start !== null && day < start) || undefined, "data-day": day };
            const label = `${formatMonthDay(day)} ${on ? "已打卡" : "未打卡"}`;
            return editor.editable && !future
              ? <button key={day} type="button" className="vivic-heat-cell nodrag nopan" {...state} title={label} aria-label={label} aria-pressed={on} onClick={() => toggle(day)} />
              : <span key={day} className="vivic-heat-cell" {...state} title={future ? undefined : label} />;
          })}
        </div>
      </div>
    </div>
  </SceneCardShell>;
}
