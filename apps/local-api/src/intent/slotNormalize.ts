import { isoOf, parseIso, validDate } from "../scenes/calendar.js";
import { DURATION, parseDuration } from "./reminders.js";

/**
 * Host-side slot normalization and guards.
 *
 * Only values the host can decide from the user's own words are changed:
 * a duration written as text, an optional field the model left empty, a
 * boolean/index the model sent as a string, and a year the user already fixed
 * with "今年 / 明年 / 后年". Anything the host cannot decide becomes a
 * clarification — never a guess, a truncation or an invented date.
 */
export interface SlotNormalizeOptions {
  /** The clause text this plan answers; used only for deterministic checks. */
  text: string;
  /** Today in the user's zone as "YYYY-MM-DD". */
  today: string;
}
export type NormalizedSlots<T extends Record<string, unknown>> = { slots: T } | { clarify: string };

const MAX_SECONDS = 86_400;

/** "300" / "300.0" → 300; "5分钟" → 300; anything else → undefined. */
function secondsOf(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) && Number.isInteger(value) ? value : undefined;
  }
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (/^\d+(?:\.0+)?$/.test(text)) return Number(text);
  if (new RegExp(`^${DURATION}$`).test(text)) return parseDuration(text) ?? undefined;
  return undefined;
}

/** The only calendar strings this module rewrites: YYYY-MM-DD and YYYY-MM. */
function inYear(value: string, year: number): string | null | undefined {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (day) {
    if (Number(day[1]) === year) return undefined;
    const date = validDate(year, Number(day[2]), Number(day[3]));
    return date ? isoOf(date) : null;
  }
  const month = /^(\d{4})-(\d{2})$/.exec(value);
  if (month) {
    if (Number(month[1]) === year) return undefined;
    const index = Number(month[2]);
    return index >= 1 && index <= 12 ? `${year}-${month[2]}` : null;
  }
  return undefined;
}

const DATE_KEYS = new Set(["date", "targetDate", "deadline", "startDate", "endDate", "weekStart",
  "due", "publishedAt", "checkins", "month"]);

/** Years a relative word fixes, mirroring scenes/grounding.ts. Explicit
 * four-digit years always win: they are the user's words, not a relative one. */
const YEAR_WORDS: Array<[RegExp, number]> = [[/(?<!大)前年/, -2], [/去年/, -1], [/今年|本年/, 0], [/明年/, 1], [/(?<!大)后年/, 2]];

/** The single year the utterance fixes, or undefined when it fixes none or several. */
export function relativeYear(text: string, today: string): number | undefined {
  const now = parseIso(today);
  if (!now) return undefined;
  if (/(?:19|20)\d{2}\s*(?:年|[-/.])/.test(text)) return undefined;
  const hits = YEAR_WORDS.filter(([pattern]) => pattern.test(text));
  return hits.length === 1 ? now.year + hits[0]![1] : undefined;
}

function rewriteYears(value: unknown, key: string | undefined, year: number, impossible: { hit: boolean }): unknown {
  if (typeof value === "string") {
    if (!key || !DATE_KEYS.has(key)) return value;
    const fixed = inYear(value, year);
    if (fixed === null) { impossible.hit = true; return value; }
    return fixed ?? value;
  }
  if (Array.isArray(value)) return value.map(item => rewriteYears(item, key, year, impossible));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) =>
      [childKey, rewriteYears(child, childKey, year, impossible)]));
  }
  return value;
}

const isoDay = (value: unknown): string | undefined =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && parseIso(value) ? value : undefined;

/** Countdowns may not invent a duration, exceed their own contract or point at
 * a day that has already passed. */
function normalizeCountdown(slots: Record<string, unknown>, text: string): NormalizedSlots<Record<string, unknown>> {
  if (!Object.hasOwn(slots, "seconds")) return { slots };
  const seconds = secondsOf(slots.seconds);
  if (seconds === undefined) return { clarify: "倒计时需要具体时长，例如「5 分钟」或「300 秒」。" };
  if (seconds < 1) return { clarify: "倒计时时长要大于 0，请说明具体时长。" };
  if (seconds > MAX_SECONDS) return { clarify: "倒计时最长 24 小时；要倒数到某一天请告诉我目标日期。" };
  // A duration the user never gave cannot come from the model: ask instead of
  // building the invented reminder.
  const durations = [...text.matchAll(new RegExp(DURATION, "g"))];
  if (!durations.length) return { clarify: "倒计时需要多久？请告诉我时长，例如「5 分钟」。" };
  const next = { ...slots, seconds };
  // One explicit duration in the clause fixes the value: keep the user's number.
  if (durations.length === 1) {
    const exact = parseDuration(durations[0]![0]);
    if (exact !== null) next.seconds = exact;
  }
  return { slots: next };
}

const TRUE_WORDS = new Set(["true", "1", "yes", "y", "是", "对", "完成", "已完成", "弄完了", "done"]);
const FALSE_WORDS = new Set(["false", "0", "no", "n", "否", "不", "未完成", "没完成", "未", "undone"]);

/** Model text is coerced only where the value itself is unambiguous. */
function normalizeEdit(slots: Record<string, unknown>): Record<string, unknown> {
  const next = { ...slots };
  if (typeof next.itemIndex === "string") {
    const value = next.itemIndex.trim();
    if (/^\d+$/.test(value)) next.itemIndex = Number(value);
    else if (/^\d+(?:\.0+)?$/.test(value)) next.itemIndex = Math.trunc(Number(value));
  }
  if (typeof next.done === "string") {
    const value = next.done.trim().toLowerCase();
    if (TRUE_WORDS.has(value)) next.done = true;
    else if (FALSE_WORDS.has(value)) next.done = false;
  }
  return next;
}

/** An empty optional field means "not provided"; it is dropped, not filled. */
function dropEmptyUrl(slots: Record<string, unknown>): Record<string, unknown> {
  const next = { ...slots };
  if (next.url === null || (typeof next.url === "string" && !next.url.trim())) delete next.url;
  return next;
}

/** Scene payloads: correct a year the user already fixed and refuse a past day
 * for a countdown that is meant to look forward. */
function normalizeScene(slots: Record<string, unknown>, options: SlotNormalizeOptions): NormalizedSlots<Record<string, unknown>> {
  const data = slots.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return { slots };
  let nextData: unknown = data;
  const year = relativeYear(options.text, options.today);
  if (year !== undefined) {
    const impossible = { hit: false };
    nextData = rewriteYears(data, undefined, year, impossible);
    if (impossible.hit) return { clarify: "这个日期在对应的年份里不存在，请确认具体日期。" };
  }
  if (slots.scene_id === "countdown") {
    const date = isoDay((nextData as Record<string, unknown>).targetDate);
    if (date && date < options.today) return { clarify: "这个日期已经过去了，请说明要倒数到未来的哪一天。" };
  }
  return { slots: { ...slots, data: nextData } };
}

/** Normalize one planner plan's slots; `clarify` is a terminal answer. */
export function normalizePlanSlots<T extends Record<string, unknown>>(contract: string, slots: T, options: SlotNormalizeOptions): NormalizedSlots<T> {
  if (contract === "countdown") return normalizeCountdown(slots, options.text) as NormalizedSlots<T>;
  if (contract === "answer") return { slots: dropEmptyUrl(slots) as T };
  if (contract === "edit") return { slots: normalizeEdit(slots) as T };
  if (contract === "generate") return normalizeScene(slots, options) as NormalizedSlots<T>;
  return { slots };
}
