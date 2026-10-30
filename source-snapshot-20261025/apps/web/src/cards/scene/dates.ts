/**
 * Calendar-date helpers for scene cards. Dates are plain YYYY-MM-DD strings;
 * arithmetic happens in UTC so DST never shifts a day. "Today" is read in the
 * card's time zone when it has one, otherwise in this browser's zone.
 */
export const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"] as const;

const pad = (n: number) => String(n).padStart(2, "0");

export function todayIn(timeZone?: string, now: number = Date.now()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
    const get = (type: string) => parts.find(part => part.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    const date = new Date(now);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }
}

export function parseIsoDate(iso: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? { year, month, day } : null;
}

const utc = (iso: string): number => {
  const parsed = parseIsoDate(iso);
  return parsed ? Date.UTC(parsed.year, parsed.month - 1, parsed.day) : Number.NaN;
};

export const isoFromUtc = (time: number): string => {
  const date = new Date(time);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
};

export const addDays = (iso: string, days: number): string => isoFromUtc(utc(iso) + days * 86_400_000);

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export const daysBetween = (from: string, to: string): number => Math.round((utc(to) - utc(from)) / 86_400_000);

/** ISO weekday: Monday = 1 … Sunday = 7. */
export const weekdayOf = (iso: string): number => {
  const day = new Date(utc(iso)).getUTCDay();
  return day === 0 ? 7 : day;
};

export const mondayOf = (iso: string): string => addDays(iso, 1 - weekdayOf(iso));

export const weekdayLabel = (iso: string): string => `周${WEEKDAY_LABELS[weekdayOf(iso) - 1]}`;

export function formatMonthDay(iso: string): string {
  const parsed = parseIsoDate(iso);
  return parsed ? `${parsed.month}月${parsed.day}日` : iso;
}

export function formatFullDate(iso: string, withWeekday = true): string {
  const parsed = parseIsoDate(iso);
  if (!parsed) return iso;
  return `${parsed.year}年${parsed.month}月${parsed.day}日${withWeekday ? ` ${weekdayLabel(iso)}` : ""}`;
}

/** "2019" → 2019年, "2019-03" → 2019年3月, "2019-03-08" → 2019年3月8日. */
export function formatPartialDate(value: string): string {
  const [year, month, day] = value.split("-");
  if (!year) return value;
  return `${year}年${month ? `${Number(month)}月` : ""}${day ? `${Number(day)}日` : ""}`;
}

/** Sort key that keeps less precise dates before more precise ones in the same period. */
export const partialDateKey = (value: string): string => value.padEnd(10, value.length === 4 ? "-00-00" : "-00").slice(0, 10);

export function relativeTimeLabel(iso: string, now: number = Date.now()): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  const diff = now - time;
  if (diff < 0) {
    const ahead = -diff;
    if (ahead < 3_600_000) return `${Math.max(1, Math.round(ahead / 60_000))} 分钟后`;
    if (ahead < 86_400_000) return `${Math.round(ahead / 3_600_000)} 小时后`;
  } else {
    if (diff < 60_000) return "刚刚";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  }
  const date = new Date(time);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return `${sameYear ? "" : `${date.getFullYear()}年`}${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Calendar grid of a YYYY-MM month: leading/trailing days complete Monday-first weeks. */
export function monthGrid(month: string): Array<{ date: string; inMonth: boolean }> {
  const first = `${month}-01`;
  const start = mondayOf(first);
  const parsed = parseIsoDate(first);
  if (!parsed) return [];
  const nextMonth = parsed.month === 12 ? `${parsed.year + 1}-01-01` : `${parsed.year}-${pad(parsed.month + 1)}-01`;
  const end = addDays(mondayOf(addDays(nextMonth, -1)), 6);
  const days: Array<{ date: string; inMonth: boolean }> = [];
  for (let date = start; daysBetween(date, end) >= 0; date = addDays(date, 1)) days.push({ date, inMonth: date.startsWith(month) });
  return days;
}

export function shiftMonth(month: string, delta: number): string {
  const [year, value] = month.split("-").map(Number) as [number, number];
  const index = year * 12 + (value - 1) + delta;
  return `${Math.floor(index / 12)}-${pad(index % 12 + 1)}`;
}
