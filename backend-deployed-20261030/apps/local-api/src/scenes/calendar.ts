/** Minimal calendar-date math in UTC (no DST shifts) for scene grounding and building. */
export interface Ymd { year: number; month: number; day: number }

const pad = (n: number) => String(n).padStart(2, "0");
const toUtc = (d: Ymd) => Date.UTC(d.year, d.month - 1, d.day);
const fromUtc = (time: number): Ymd => {
  const date = new Date(time);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
};

export const isoOf = (d: Ymd) => `${d.year}-${pad(d.month)}-${pad(d.day)}`;
export const monthOf = (d: Ymd) => `${d.year}-${pad(d.month)}`;
export const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

export function validDate(year: number, month: number, day: number): Ymd | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1) return null;
  return day <= daysInMonth(year, month) ? { year, month, day } : null;
}

export function parseIso(value: string): Ymd | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? validDate(+match[1]!, +match[2]!, +match[3]!) : null;
}

export const addDays = (d: Ymd, days: number): Ymd => fromUtc(toUtc(d) + days * 86_400_000);
export function addMonths(d: Ymd, months: number): Ymd {
  const index = d.year * 12 + (d.month - 1) + months;
  const year = Math.floor(index / 12), month = index % 12 + 1;
  return { year, month, day: Math.min(d.day, daysInMonth(year, month)) };
}
/** ISO weekday: Monday = 1 … Sunday = 7. */
export const dayOfWeek = (d: Ymd) => { const day = new Date(toUtc(d)).getUTCDay(); return day === 0 ? 7 : day; };
export const mondayOf = (d: Ymd) => addDays(d, 1 - dayOfWeek(d));
export const daysBetween = (from: Ymd, to: Ymd) => Math.round((toUtc(to) - toUtc(from)) / 86_400_000);

export function todayIn(timeZone: string | undefined, now: number = Date.now()): Ymd {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
    const get = (type: string) => Number(parts.find(part => part.type === type)?.value);
    const date = validDate(get("year"), get("month"), get("day"));
    if (date) return date;
  } catch { /* fall through to UTC */ }
  return fromUtc(now);
}
