import type { CardRecord } from "@/contracts";
import type { VivicState } from "@/state/canvasStore";
import { zhToNumber } from "./zhNumber";
import { completedCountdown } from "@/canvas/reminderPresentation";
import { CARD_TYPE_LABELS, cardTitle } from "@/contracts";

/**
 * Natural-language reference resolution (CARD_CONTRACT §4). Chinese-first
 * discriminators: type keywords, position (左/右/上/下/中间), ordinal
 * (第一个/第2个/first…), recency (刚才/最近/那个). Returns ranked candidates;
 * destructive actions on >1 candidate MUST go through clarification.
 */

const TYPE_KEYWORDS: Array<[RegExp, CardRecord["type"]]> = [
  [/倒计时|计时|提醒/, "CountdownCard"],
  [/待办|任务|todo/i, "TodoCard"],
  [/天气/, "WeatherCard"],
  [/便笺|便签|笔记|note/i, "NoteCard"],
  [/搜索|资料|结果|search/i, "SearchResultCard"],
  [/表格|table/i, "TableCard"],
  [/图表|chart/i, "ChartCard"],
  // Scene cards: only names of the card itself, so a reference never guesses a scene.
  [/论文|文献/, "PaperCard"],
  [/照片墙|相册/, "GalleryCard"],
  [/照片故事|故事轮播|轮播/, "StoryCarouselCard"],
  [/照片封面|纪念卡|照片卡/, "PhotoCoverCard"],
  [/周计划|日程|本周安排/, "WeeklyScheduleCard"],
  [/月历|日历/, "MonthCalendarCard"],
  [/路线图|里程碑|规划/, "RoadmapCard"],
  [/新闻|资讯/, "NewsCard"],
  [/时间线|时间轴/, "TimelineCard"],
  [/金句|语录|名言|灵感/, "QuoteCard"],
  [/动态/, "ActivityFeedCard"],
  [/进度环|目标进度|目标/, "ProgressRingCard"],
  [/打卡|习惯|热力图/, "HabitHeatmapCard"],
  [/书籍|读书|这本书/, "BookCard"],
  [/对比|比较|方案/, "ComparisonCard"],
  [/链接|网页收藏|书签|收藏/, "LinkPreviewCard"],
  [/通知/, "NotificationCard"],
];

const TYPE_LABEL: Record<CardRecord["type"], string> = {
  ...CARD_TYPE_LABELS,
  CountdownCard: "倒计时",
  TodoCard: "待办",
  WeatherCard: "天气",
  NoteCard: "便签",
  SearchResultCard: "资料卡",
  TableCard: "表格",
  ChartCard: "图表",
};

const ORDINALS: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

export interface ResolvedCard {
  card: CardRecord;
  label: string;
}

export type Resolution =
  | { kind: "unique"; card: CardRecord; label: string }
  | { kind: "ambiguous"; candidates: ResolvedCard[] }
  | { kind: "none"; reason?: string };

const liveCards = (state: VivicState): CardRecord[] =>
  state.cards.filter((c) => !c.exitingRequestId && !completedCountdown(c)).map((c) => c.record);

const positionOf = (
  card: CardRecord,
  others: CardRecord[],
): "left" | "right" | "center" => {
  if (others.length <= 1) return "center";
  const xs = others.map((c) => c.layout.x);
  const min = Math.min(...xs);
  const max = Math.max(...xs);
  if (max - min < 24) return "center";
  const mid = (min + max) / 2;
  return card.layout.x < mid - 12
    ? "left"
    : card.layout.x > mid + 12
      ? "right"
      : "center";
};

const labelFor = (card: CardRecord, others: CardRecord[]): string => {
  const typeLabel = TYPE_LABEL[card.type];
  const alias = cardTitle(card).slice(0, 50);
  const pos = positionOf(card, others);
  const posLabel =
    others.length > 1
      ? pos === "left"
        ? "左边的"
        : pos === "right"
          ? "右边的"
          : "中间的"
      : "";
  return alias ? `${posLabel}${typeLabel}「${alias}」` : `${posLabel}${typeLabel}卡`;
};

const parseOrdinal = (ref: string): number | null => {
  const zh = ref.match(/第\s*([一二两三四五六七八九十]|\d+)\s*(?:个|张|条|项)/);
  if (zh) {
    const token = zh[1]!;
    return ORDINALS[token] ?? (Number.isNaN(Number(token)) ? null : Number(token));
  }
  const en = ref.match(/(\d+)(?:st|nd|rd|th)/i);
  if (en) return Number(en[1]);
  return null;
};

export interface ReferenceContext {
  state: VivicState;
  now?: () => number;
}

/**
 * Resolve a free-form reference like 左边的待办 / 第二个 / 刚才那个 / 天气.
 * `ref` is the matched remainder of the user command (may be empty/vague).
 */
const parseDurationMinutes = (text: string): number | null => {
  const m = text.match(/(\d+(?:\.\d+)?|[零一二两三四五六七八九十半]+)\s*分(?:钟)?/);
  if (!m) return null;
  const v = zhToNumber(m[1]!);
  return v === null || v < 0 ? null : v;
};

const remainingMinutes = (card: CardRecord, now: number): number | null => {
  if (card.type !== "CountdownCard") return null;
  const target = Date.parse(card.sourceData.targetAt);
  if (Number.isNaN(target)) return null;
  return Math.round((target - now) / 60_000);
};

/** Original programmed length (targetAt - startedAt) in whole minutes. */
const originalMinutes = (card: CardRecord): number | null => {
  if (card.type !== "CountdownCard" || !card.sourceData.startedAt) return null;
  const target = Date.parse(card.sourceData.targetAt);
  const started = Date.parse(card.sourceData.startedAt);
  if (Number.isNaN(target) || Number.isNaN(started)) return null;
  return Math.round((target - started) / 60_000);
};

/** 左右/大约/约/大概 widens tolerance: ±2 min under 30, ±3 at/above 30. */
const approxTolerance = (approx: boolean, minutes: number): number =>
  approx ? (minutes < 30 ? 2 : 3) : 1;

const withinTolerance = (value: number | null, target: number, tol: number): boolean =>
  value !== null && Math.abs(value - target) <= tol;

export const resolveReference = (
  ref: string,
  { state, now }: ReferenceContext,
): Resolution => {
  const cards = liveCards(state);
  if (cards.length === 0) return { kind: "none" };
  const text = ref.trim();

  let pool = cards;

  // Exact task/title matching only. A fuzzy name must never trigger deletion.
  const name = text.replace(/(?:的)?(?:提醒|倒计时|卡片|便笺|便签|待办)(?:卡片|卡)?$/, "").replace(/[「」“”]/g, "");
  const named = cards.filter(card => card.metadata.aliases?.includes(text) || card.metadata.aliases?.includes(name)
    || (card.type === "CountdownCard" && card.sourceData.reminderText === name));
  if (named.length) return named.length === 1
    ? { kind: "unique", card: named[0]!, label: labelFor(named[0]!, cards) }
    : { kind: "ambiguous", candidates: named.map(card => ({ card, label: labelFor(card, cards) })) };
  if (/(?:提醒|倒计时)$/.test(text) && name && !/^(?:这|那|这个|那个|刚才|刚才那个|最近|左边|右边|中间|中央|第[一二两三四五六七八九十\d]+(?:个|张|条)?)(?:的)?$/.test(name)
    && !/分(?:钟)?|秒/.test(name)) return { kind: "none", reason: `没有找到「${name}」提醒` };

  const typeHit = TYPE_KEYWORDS.find(([re]) => re.test(text));
  if (typeHit) pool = pool.filter((c) => c.type === typeHit[1]);

  if (/左(?!右)/.test(text)) {
    pool = pool.filter((c) => positionOf(c, cards) === "left");
  } else if (/右/.test(text) && !/左右/.test(text)) {
    pool = pool.filter((c) => positionOf(c, cards) === "right");
  } else if (/中间|中央/.test(text)) {
    pool = pool.filter((c) => positionOf(c, cards) === "center");
  }

  // Temporal discriminator: 13分钟的倒计时 / 倒计时十分钟 / 还有13分钟的那个 /
  // 8分钟左右的倒计时. Matches CountdownCard by remaining minutes of
  // sourceData.targetAt (preferred) OR by its original programmed length —
  // ±1 min exact, ±2 (under 30) / ±3 (30+) for 大约/约/大概/左右. Any union
  // multi-hit => clarify; zero hits => honest no-match.
  const duration = parseDurationMinutes(text);
  if (duration !== null) {
    const countdowns = pool.filter((c) => c.type === "CountdownCard");
    if (countdowns.length > 0) {
      const nowMs = now?.() ?? Date.now();
      const tol = approxTolerance(/大约|约|大概|左右/.test(text), duration);
      const hits = countdowns.filter(
        (c) =>
          withinTolerance(remainingMinutes(c, nowMs), duration, tol) ||
          withinTolerance(originalMinutes(c), duration, tol),
      );
      if (hits.length === 1) {
        const only = hits[0]!;
        const remaining = remainingMinutes(only, nowMs);
        return {
          kind: "unique",
          card: only,
          label: `${labelFor(only, cards)}（约${remaining}分钟）`,
        };
      }
      if (hits.length > 1) {
        return {
          kind: "ambiguous",
          candidates: hits.map((card) => ({
            card,
            label: `${labelFor(card, cards)}（约${remainingMinutes(card, nowMs)}分钟）`,
          })),
        };
      }
      return {
        kind: "none",
        reason: `没有找到约${duration}分钟的倒计时`,
      };
    }
  }

  const ordinal = parseOrdinal(text);
  if (ordinal !== null) {
    const pick = pool[ordinal - 1];
    if (!pick) return { kind: "none" };
    return { kind: "unique", card: pick, label: labelFor(pick, cards) };
  }

  // recency: 刚才/最近/这个/那个 -> last focused, then newest created
  if (/刚才|最近|这个|那个|它|这|那/.test(text) || text === "") {
    const focused = [...state.focusHistory]
      .reverse()
      .map((id) => pool.find((c) => c.id === id))
      .find((c): c is CardRecord => Boolean(c));
    if (focused && (pool.length === 1 || /刚才|最近/.test(text))) {
      return { kind: "unique", card: focused, label: labelFor(focused, cards) };
    }
    if (pool.length === 1) {
      const only = pool[0]!;
      return { kind: "unique", card: only, label: labelFor(only, cards) };
    }
    if (cards.length === 1 && !typeHit) {
      const only = cards[0]!;
      return { kind: "unique", card: only, label: labelFor(only, cards) };
    }
    return {
      kind: "ambiguous",
      candidates: pool.map((card) => ({ card, label: labelFor(card, cards) })),
    };
  }

  // Reference matched by type/position only.
  if (pool.length === 1) {
    const only = pool[0]!;
    return { kind: "unique", card: only, label: labelFor(only, cards) };
  }
  if (pool.length === 0) return { kind: "none" };
  return {
    kind: "ambiguous",
    candidates: pool.map((card) => ({ card, label: labelFor(card, cards) })),
  };
};
