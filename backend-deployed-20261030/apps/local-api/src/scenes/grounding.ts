import { addDays, addMonths, dayOfWeek, daysInMonth, isoOf, mondayOf, todayIn, validDate, type Ymd } from "./calendar.js";

/**
 * Anti-fabrication checks for scene cards. Facts the model may NOT invent —
 * numbers, calendar dates, years, clock times, weekdays, links, DOIs, author
 * and venue names — must be traceable to the evidence: the user's words, the
 * clarification turn, a page the user linked (fetched by the verified reader)
 * or data already on the canvas. Free prose (summaries, phrasing) is not
 * checked here; it is labelled as AI-written where it is shown.
 */
export interface Corpus {
  text: string;
  normalized: string;
  numbers: number[];
  urls: Set<string>;
  dois: Set<string>;
  dates: Set<string>;
  months: Set<string>;
  years: Set<number>;
  monthDays: Set<string>;
  times: Set<string>;
  weekdays: Set<number>;
  today: string;
}

const DIGIT: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const UNIT: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };

/** 二十五 → 25, 一百零八 → 108, 三千五百 → 3500, 两万 → 20000. */
export function parseChineseNumber(raw: string): number | null {
  if (!raw || !/^[零〇一二两三四五六七八九十百千万]+$/.test(raw)) return null;
  let total = 0, section = 0, digit = -1;
  for (const char of raw) {
    if (char in DIGIT) { digit = DIGIT[char]!; continue; }
    if (char in UNIT) { section += (digit < 0 ? 1 : digit) * UNIT[char]!; digit = -1; continue; }
    if (char === "万") { total += (section + Math.max(0, digit)) * 10000; section = 0; digit = -1; }
  }
  const value = total + section + Math.max(0, digit);
  return Number.isFinite(value) ? value : null;
}

const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[\s　·•・,，、.。:：;；"'“”‘’《》〈〉「」『』()（）[\]【】!！?？\-—_]+/g, "");

const NUMBER_PATTERN = /(\d+(?:,\d{3})*(?:\.\d+)?|[零〇一二两三四五六七八九十百千]+)\s*(万|千|百)?\s*(%|％)?/g;

function extractNumbers(text: string): number[] {
  const out: number[] = [];
  for (const match of text.matchAll(NUMBER_PATTERN)) {
    const base = /\d/.test(match[1]!) ? Number(match[1]!.replace(/,/g, "")) : parseChineseNumber(match[1]!);
    if (base === null || !Number.isFinite(base)) continue;
    out.push(base);
    const scale = match[2] === "万" ? 10000 : match[2] === "千" ? 1000 : match[2] === "百" ? 100 : 1;
    if (scale !== 1) out.push(base * scale);
    if (match[3]) out.push(base / 100);
    // "3个半小时" / "1.5" style halves.
    if (/^\s*个?半/.test(text.slice((match.index ?? 0) + match[0].length))) out.push(base + 0.5);
  }
  if (/半/.test(text)) out.push(0.5);
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");
const monthKey = (d: Ymd) => `${d.year}-${pad(d.month)}`;
const firstOfMonth = (d: Ymd, offset: number): Ymd => addMonths({ ...d, day: 1 }, offset);
const WEEKDAY_WORD: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7, 末: 6 };
const numberToken = (token: string): number | null => /^\d+$/.test(token) ? Number(token) : parseChineseNumber(token);

/** Every calendar fact the text mentions, resolved against "today" in the user's zone. */
function extractCalendar(text: string, today: Ymd, corpus: Corpus) {
  const addDate = (date: Ymd | null) => {
    if (!date) return;
    corpus.dates.add(isoOf(date));
    corpus.weekdays.add(dayOfWeek(date));
  };
  const N = "(\\d{1,4}|[零〇一二两三四五六七八九十]+)";
  for (const m of text.matchAll(/(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*[日号]?/g)) addDate(validDate(+m[1]!, +m[2]!, +m[3]!));
  for (const m of text.matchAll(/(\d{4})\s*年/g)) corpus.years.add(+m[1]!);
  for (const m of text.matchAll(/(?<![\d.])((?:19|20)\d{2})(?![\d.])/g)) corpus.years.add(+m[1]!);
  for (const m of text.matchAll(/(\d{4})\s*[-/.年]\s*(\d{1,2})(?!\d)/g)) {
    const month = +m[2]!;
    if (month >= 1 && month <= 12) corpus.months.add(`${m[1]}-${pad(month)}`);
  }
  for (const m of text.matchAll(new RegExp(`${N}\\s*月\\s*(?:${N}\\s*[日号])?`, "g"))) {
    const month = numberToken(m[1]!), day = m[2] ? numberToken(m[2]) : null;
    if (!month || month < 1 || month > 12) continue;
    for (const year of [today.year - 1, today.year, today.year + 1]) {
      corpus.months.add(`${year}-${pad(month)}`);
      if (day) addDate(validDate(year, month, day));
    }
    if (day) corpus.monthDays.add(`${pad(month)}-${pad(day)}`);
  }
  for (const m of text.matchAll(new RegExp(`(?<![月\\d])${N}\\s*[号日](?!子|期|常|本|记)`, "g"))) {
    const day = numberToken(m[1]!);
    if (!day || day > 31) continue;
    for (const offset of [-1, 0, 1, 2]) {
      const month = firstOfMonth(today, offset);
      addDate(validDate(month.year, month.month, day));
    }
  }
  const relative: Array<[RegExp, number]> = [[/大前天/, -3], [/(?<!大)前天/, -2], [/昨天|昨日/, -1], [/今天|今日|今晚|今早|今夜|当天/, 0],
    [/明天|明日|明早|明晚/, 1], [/大后天/, 3], [/(?<!大)后天/, 2]];
  for (const [pattern, offset] of relative) if (pattern.test(text)) addDate(addDays(today, offset));
  const span = new RegExp(`${N}\\s*(天|日|周|个?星期|个?礼拜|个?月|年)\\s*(?:后|以后|之后)|(?:还有|再过|过|还剩)\\s*${N}\\s*(天|日|周|个?星期|个?月|年)`, "g");
  for (const m of text.matchAll(span)) {
    const amount = numberToken(m[1] ?? m[3]!), unit = m[2] ?? m[4]!;
    if (amount === null || amount > 5000) continue;
    const date = /天|日/.test(unit) ? addDays(today, amount) : /周|星期|礼拜/.test(unit) ? addDays(today, amount * 7)
      : /月/.test(unit) ? addMonths(today, amount) : addMonths(today, amount * 12);
    addDate(date);
    // "还有 25 天" is sometimes counted inclusively; allow the neighbouring days.
    if (/天|日/.test(unit)) { addDate(addDays(date, 1)); addDate(addDays(date, -1)); }
  }
  for (const m of text.matchAll(/(上上|上|这|本|下下|下)?\s*(?:个)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天末])/g)) {
    const weekday = WEEKDAY_WORD[m[2]!]!;
    corpus.weekdays.add(weekday);
    if (m[2] === "末") corpus.weekdays.add(7);
    const shift = m[1] === "上上" ? -2 : m[1] === "上" ? -1 : m[1] === "下" ? 1 : m[1] === "下下" ? 2 : 0;
    const monday = addDays(mondayOf(today), shift * 7);
    addDate(addDays(monday, weekday - 1));
    if (m[2] === "末") addDate(addDays(monday, 6));
    // A bare "周三" may mean this week's or the coming one.
    if (!m[1]) addDate(addDays(monday, weekday + 6));
  }
  if (/每天|每日|天天|日常|每晚|每早/.test(text)) for (let day = 1; day <= 7; day++) corpus.weekdays.add(day);
  if (/工作日/.test(text)) for (let day = 1; day <= 5; day++) corpus.weekdays.add(day);
  if (/周末/.test(text)) { corpus.weekdays.add(6); corpus.weekdays.add(7); }
  for (const m of text.matchAll(/(?:周|星期|礼拜)\s*([一二三四五六日天])\s*(?:到|至|-|—|~)\s*(?:周|星期|礼拜)?\s*([一二三四五六日天])/g)) {
    const from = WEEKDAY_WORD[m[1]!]!, to = WEEKDAY_WORD[m[2]!]!;
    for (let day = from; day <= to; day++) corpus.weekdays.add(day);
  }
  const yearWords: Array<[RegExp, number]> = [[/(?<!大)前年/, -2], [/去年/, -1], [/今年|本年/, 0], [/明年/, 1], [/(?<!大)后年/, 2]];
  for (const [pattern, offset] of yearWords) if (pattern.test(text)) {
    corpus.years.add(today.year + offset);
    // "今年的目标" ends with the year: its deadline is 12-31, not a guess.
    if (offset >= 0) addDate(validDate(today.year + offset, 12, 31));
  }
  const monthWords: Array<[RegExp, number]> = [[/上个?月/, -1], [/这个月|本月|这月/, 0], [/下个?月/, 1]];
  for (const [pattern, offset] of monthWords) if (pattern.test(text)) corpus.months.add(monthKey(firstOfMonth(today, offset)));
  const festivals: Array<[RegExp, number, number]> = [[/元旦|新年/, 1, 1], [/情人节/, 2, 14], [/劳动节|五一/, 5, 1], [/儿童节|六一/, 6, 1],
    [/国庆/, 10, 1], [/圣诞/, 12, 25], [/跨年|年底|年末/, 12, 31]];
  for (const [pattern, month, day] of festivals) if (pattern.test(text)) {
    for (const year of [today.year, today.year + 1]) addDate(validDate(year, month, day));
  }
  if (/月底|月末/.test(text)) for (const offset of [0, 1]) {
    const month = firstOfMonth(today, offset);
    addDate(validDate(month.year, month.month, daysInMonth(month.year, month.month)));
  }
}

function extractTimes(text: string, times: Set<string>) {
  const N = "(\\d{1,2}|[零〇一二两三四五六七八九十]+)";
  for (const m of text.matchAll(/(\d{1,2})\s*[:：]\s*(\d{2})/g)) {
    const hour = +m[1]!, minute = +m[2]!;
    if (hour > 23 || minute > 59) continue;
    times.add(`${pad(hour)}:${pad(minute)}`);
    if (hour < 12) times.add(`${pad(hour + 12)}:${pad(minute)}`);
  }
  for (const m of text.matchAll(new RegExp(`(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|晚间|今晚|明晚)?\\s*${N}\\s*点\\s*(半|一刻|三刻|${N}\\s*分?)?`, "g"))) {
    let hour = numberToken(m[2]!);
    if (hour === null || hour > 24) continue;
    const tail = m[3] ?? "";
    const minute = tail === "半" ? 30 : tail === "一刻" ? 15 : tail === "三刻" ? 45 : m[4] ? numberToken(m[4]) ?? 0 : 0;
    if (minute > 59) continue;
    const period = m[1] ?? "";
    if (/下午|傍晚|晚上|晚间|今晚|明晚/.test(period) && hour < 12) hour += 12;
    if (hour === 24) hour = 0;
    times.add(`${pad(hour)}:${pad(minute)}`);
    if (!period && hour < 12) times.add(`${pad(hour + 12)}:${pad(minute)}`);
  }
  if (/中午/.test(text)) times.add("12:00");
}

const URL_PATTERN = /https?:\/\/[^\s<>"'，。、；！？）)\]】]+/g;
export const normalizeUrl = (value: string) => value.replace(/[.,;:!?。，]+$/, "").replace(/\/+$/, "").toLowerCase();

export function buildCorpus(parts: string[], options: { now?: number; timeZone?: string } = {}): Corpus {
  const text = parts.filter(Boolean).join("\n");
  const today = todayIn(options.timeZone ?? "Asia/Shanghai", options.now ?? Date.now());
  const corpus: Corpus = {
    text, normalized: normalize(text), numbers: extractNumbers(text), urls: new Set(), dois: new Set(),
    dates: new Set(), months: new Set(), years: new Set(), monthDays: new Set(), times: new Set(), weekdays: new Set(), today: isoOf(today),
  };
  for (const m of text.matchAll(URL_PATTERN)) corpus.urls.add(normalizeUrl(m[0]));
  for (const m of text.matchAll(/\b10\.\d{4,9}\/[^\s"'<>，。]+/g)) corpus.dois.add(m[0].replace(/[.,;:)\]】]+$/, "").toLowerCase());
  extractCalendar(text, today, corpus);
  extractTimes(text, corpus.times);
  return corpus;
}

// --------------------------------------------------------------------------- checks

export const groundedNumber = (corpus: Corpus, value: number): boolean =>
  corpus.numbers.some(candidate => Math.abs(candidate - value) <= Math.max(1e-9, Math.abs(value) * 1e-9));

export const groundedUrl = (corpus: Corpus, value: string): boolean => corpus.urls.has(normalizeUrl(value));

export const groundedDoi = (corpus: Corpus, value: string): boolean => {
  const doi = value.toLowerCase();
  return corpus.dois.has(doi) || [...corpus.urls].some(url => url.includes(doi));
};

/** Names and titles must appear in the evidence (ignoring spacing/punctuation/case). */
export const groundedPhrase = (corpus: Corpus, value: string): boolean => {
  const needle = normalize(value);
  return needle.length > 0 && corpus.normalized.includes(needle);
};

export const groundedDate = (corpus: Corpus, value: string): boolean => {
  if (corpus.dates.has(value)) return true;
  const [year, month, day] = value.split("-");
  // An explicitly written month-day ("11月11日") may carry any year the text also names.
  return Boolean(year && month && day && corpus.monthDays.has(`${month}-${day}`) && corpus.years.has(Number(year)));
};

/** YYYY, YYYY-MM or YYYY-MM-DD at the precision the model claims. */
export const groundedPartialDate = (corpus: Corpus, value: string): boolean => {
  const [year, month, day] = value.split("-");
  if (day) return groundedDate(corpus, value);
  if (month) return corpus.months.has(`${year}-${month}`) || [...corpus.dates].some(date => date.startsWith(`${year}-${month}`));
  return corpus.years.has(Number(year)) || [...corpus.dates].some(date => date.startsWith(`${year}-`));
};

export const groundedTime = (corpus: Corpus, value: string): boolean => corpus.times.has(value);

export const groundedWeekday = (corpus: Corpus, day: number): boolean => corpus.weekdays.has(day);

/** Share of the claim's words/characters found in the evidence (for summaries of a supplied text). */
export function overlapRatio(corpus: Corpus, value: string): number {
  const cjk = [...value.replace(/[^\p{Script=Han}]/gu, "")];
  const bigrams = cjk.slice(0, -1).map((char, i) => char + cjk[i + 1]);
  const words = value.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  const units = [...bigrams, ...words];
  if (!units.length) return 1;
  const haystack = corpus.text.toLowerCase();
  return units.filter(unit => haystack.includes(unit)).length / units.length;
}
