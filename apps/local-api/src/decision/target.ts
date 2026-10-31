import type { IntentRouteId } from "@vivic/contracts";
import type { CanvasContext } from "../schemas.js";
import { cardLabel, cardTitle, selectedCards, type IntentRouter } from "./router.js";

/** Which mechanism decided the target. Optional so older callers and stored
 * traces stay valid; card text and titles never enter this field. */
export type TargetSource = "title" | "alias" | "focus" | "ordinal" | "type" | "spatial" | "classifier" | "frozen" | "user_pick" | "missing" | "ambiguous";
export type TargetResult = { targetId: string; source?: TargetSource } | { ambiguous: Array<{ id: string; label: string }>; source?: TargetSource } | { missing: true; source?: TargetSource };
type ContextCard = CanvasContext["cards"][number];
const targeted = new Set<IntentRouteId>(["focus", "highlight", "edit", "arrange", "delete"]);
const types: Array<[RegExp, RegExp]> = [[/待办|任务清单/, /TodoCard/], [/便签|便笺|笔记/, /NoteCard/],
  [/倒计时|计时器|提醒/, /CountdownCard/], [/天气/, /WeatherCard/], [/新闻|回答/, /NewsCard/],
  [/表格/, /TableCard/], [/图表/, /ChartCard/]];

/** A spatial word names a direction, not a card. Bare 左/右 are deliberately not
 * matched, and a direction after a movement verb is a destination ("move it to
 * the left"), not a reference to the card already sitting there. */
type Spatial = { axis: "x" | "y"; pick: "min" | "max" | "middle" };
const spatialPattern = /最左|左边|左侧|左面|最右|右边|右侧|右面|最上|上面|上方|上边|顶部|最下|下面|下方|下边|底部|中间|正中|中央/u;
const spatialLexeme = (word: string): Spatial =>
  /最左|左边|左侧|左面/u.test(word) ? { axis: "x", pick: "min" }
    : /最右|右边|右侧|右面/u.test(word) ? { axis: "x", pick: "max" }
      : /最上|上面|上方|上边|顶部/u.test(word) ? { axis: "y", pick: "min" }
        : /最下|下面|下方|下边|底部/u.test(word) ? { axis: "y", pick: "max" }
          : { axis: "x", pick: "middle" };
/** "移到左边"/"往右"/"放在中间" place a card; they do not name one. A short
 * object may sit between the verb and the direction ("移到画布左边"). */
const destination = (text: string, index: number): boolean =>
  /(?:移到|移动到|挪到|搬到|放到|拖到|移至|移向|推向|放在|移去|挪去)[^，,。；;！!？?\n]{0,6}$/u.test(
    text.slice(Math.max(0, index - 14), index))
  || /[向往][^，,。；;！!？?\n]{0,6}$/u.test(text.slice(Math.max(0, index - 8), index));
/** The first direction word that refers to a card, skipping move destinations. */
const spatialOf = (text: string): Spatial | undefined => {
  for (const match of text.matchAll(new RegExp(spatialPattern.source, "gu"))) {
    if (!destination(text, match.index ?? 0)) return spatialLexeme(match[0]);
  }
  return undefined;
};
const position = (card: ContextCard, axis: "x" | "y") => card.layout[axis];
const extent = (card: ContextCard, axis: "x" | "y") => (axis === "x" ? card.layout.width : card.layout.height) ?? 0;
/** Cards whose anchors are closer than a fraction of their own size read as one
 * stack; "the left one" cannot be answered from coordinates alone then. */
const stacked = (a: ContextCard, b: ContextCard, axis: "x" | "y") =>
  Math.abs(position(a, axis) - position(b, axis)) < Math.max(16, Math.min(extent(a, axis), extent(b, axis)) * .15);

/** Titles, type names and layout only. Internal ids never reach the question,
 * the chip or the payload's visible label; the payload itself keeps the id. */
const typeNames: Record<string, string> = { TodoCard: "待办", NoteCard: "便签", CountdownCard: "倒计时",
  WeatherCard: "天气", NewsCard: "新闻", AnswerCard: "回答", TableCard: "表格", ChartCard: "图表",
  FileCard: "文件", ImageCard: "图片" };
const internalIdLike = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
  || /^[0-9a-f]{16,}$/iu.test(value) || /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)+$/iu.test(value);
const displayTitle = (card: ContextCard): string | undefined => {
  const title = cardTitle(card).trim();
  return title && title !== card.id && !internalIdLike(title) ? title.slice(0, 120) : undefined;
};
/** The card face itself: a todo's first entry or the card's own first line. */
const excerptOf = (card: ContextCard): string | undefined => {
  const props = card.displayProps, source = card.sourceDataSummary;
  const first = Array.isArray(props.items) ? props.items.find(item => item && typeof item === "object"
    && typeof (item as { text?: unknown }).text === "string") : undefined;
  const text = (first as { text?: string } | undefined)?.text ?? props.text ?? props.body
    ?? source.text ?? source.body ?? source.reminderText;
  const trimmed = typeof text === "string" ? text.trim().replace(/\s+/gu, " ") : "";
  return trimmed && trimmed !== card.id && !internalIdLike(trimmed) ? trimmed.slice(0, 18) : undefined;
};
const sideOf = (card: ContextCard, pool: ContextCard[]): "左" | "右" | "中" => {
  const xs = pool.map(item => item.layout.x), min = Math.min(...xs), max = Math.max(...xs);
  if (min === max) return "中";
  return card.layout.x <= min ? "左" : card.layout.x >= max ? "右" : "中";
};
/** Type + card face + position, with a stable ordinal only when two labels would
 * otherwise be identical. */
const candidateLabel = (card: ContextCard, pool: ContextCard[]): string => {
  const title = displayTitle(card);
  if (title) return title;
  const head = typeNames[card.type] ?? (card.type.replace(/Card$/u, "") || "卡片");
  const excerpt = excerptOf(card);
  const where = `${sideOf(card, pool)}（x=${Math.round(card.layout.x)}, y=${Math.round(card.layout.y)}）`;
  return [excerpt ? `${head}「${excerpt}」` : head, where].join(" · ").slice(0, 120);
};

export async function resolveTarget(text: string, context: CanvasContext, route: IntentRouteId,
  router?: Pick<IntentRouter, "chooseTarget">, signal?: AbortSignal): Promise<TargetResult | undefined> {
  if (!targeted.has(route)) return undefined;
  const cards = selectedCards(context);
  const labels = (values: ContextCard[]) => {
    const titles = values.map(card => displayTitle(card));
    const base = values.map((card, index) => titles[index] ?? candidateLabel(card, values));
    const counts = new Map<string, number>();
    for (const label of base) counts.set(label, (counts.get(label) ?? 0) + 1);
    const seen = new Map<string, number>();
    // Two cards that would read the same still have to be told apart by the user,
    // so a repeated title gains the same kind of position hint.
    return values.map((card, index) => {
      let label = base[index]!;
      if ((counts.get(label) ?? 0) > 1 && titles[index] !== undefined) {
        label = `${label}（${sideOf(card, values)} x=${Math.round(card.layout.x)}, y=${Math.round(card.layout.y)}）`;
      }
      const count = (seen.get(label) ?? 0) + 1;
      seen.set(label, count);
      return { id: card.id, label: (count > 1 ? `${label} #${count}` : label).slice(0, 120) };
    });
  };
  if (!cards.length) return { missing: true, source: "missing" };
  const names = cards.filter(card => [cardTitle(card), ...(card.aliases ?? [])]
    .some(name => name.length >= 2 && text.toLocaleLowerCase().includes(name.toLocaleLowerCase())));
  if (names.length === 1) {
    const title = cardTitle(names[0]!);
    return { targetId: names[0]!.id, source: title.length >= 2 && text.toLocaleLowerCase().includes(title.toLocaleLowerCase()) ? "title" : "alias" };
  }
  const ordinal = ["highlight", "edit"].includes(route) && /第[一二三四五六七八九十百\d]+[条项点行]/.test(text);
  const hasEntries = (card: ContextCard) => [card.displayProps.items, card.displayProps.bullets,
    card.displayProps.keyPoints, card.displayProps.rows, card.sourceDataSummary.items, card.sourceDataSummary.bullets,
    card.sourceDataSummary.keyPoints].some(value => Array.isArray(value) && value.length > 0);
  if (/这张|它|刚才那张/.test(text) || ordinal) {
    const focus = context.focusHistory.at(-1);
    const focused = cards.find(card => card.id === focus);
    if (focused && (/这张|它|刚才那张/.test(text) || hasEntries(focused))) {
      return { targetId: focused.id, source: /这张|它|刚才那张/.test(text) ? "focus" : "ordinal" };
    }
    if (ordinal) { const lists = cards.filter(hasEntries); return { ambiguous: labels(lists.length ? lists : cards), source: "ambiguous" }; }
  }
  const type = types.find(([pattern]) => pattern.test(text))?.[1];
  const pool = type ? cards.filter(card => type.test(card.type)) : cards;
  if (!pool.length) return { missing: true, source: "missing" };
  // A direction is answerable from the layout alone: pick the separated card,
  // and only ask among cards that visually sit on top of each other.
  const spatial = spatialOf(text);
  if (spatial) return spatialTarget(pool, spatial, labels);
  if (type && pool.length === 1) return { targetId: pool[0]!.id, source: "type" };
  if (cards.some(card => ["ambiguous", "missing"].includes(card.id))) return { ambiguous: labels(pool), source: "ambiguous" };
  const criteria = Object.fromEntries(pool.map(card => [card.id, cardLabel(card)]));
  Object.assign(criteria, { ambiguous: "用户指的卡片不唯一，需要追问", missing: "画布上没有用户说的卡片" });
  const result = await router?.chooseTarget(text, context, criteria, signal);
  if (result?.choice === "missing" && result.probability >= .8) return { missing: true, source: "missing" };
  if (result?.choice && result.probability >= .8 && pool.some(card => card.id === result.choice)) {
    return { targetId: result.choice, source: "classifier" };
  }
  // An unresolved classifier over the whole canvas has not found the card the
  // user explicitly named ("日程卡"). Listing every unrelated card as a candidate
  // induces a wrong pick, so report the card as absent instead.
  if ((!result || result.choice === "ambiguous") && !type && !names.length && pool.length === cards.length
    && explicitCardReference(text)) return { missing: true, source: "missing" };
  return { ambiguous: labels(names.length ? names : pool), source: "ambiguous" };
}

/** Layout-only spatial resolution: pick when the coordinates separate the cards,
 * clarify among the stack when they do not. */
function spatialTarget(pool: ContextCard[], spatial: Spatial,
  labels: (values: ContextCard[]) => Array<{ id: string; label: string }>): TargetResult {
  // 中间 has no fixed axis: use whichever direction actually separates the cards.
  const spread = (axis: "x" | "y") => {
    const values = pool.map(card => position(card, axis));
    return Math.max(...values) - Math.min(...values);
  };
  const axis = spatial.pick === "middle" && spread("y") > spread("x") ? "y" : spatial.axis;
  const sorted = [...pool].sort((a, b) => position(a, axis) - position(b, axis) || a.layout.y - b.layout.y);
  if (sorted.length === 1) return { targetId: sorted[0]!.id, source: "spatial" };
  if (spatial.pick === "middle") {
    const index = Math.floor(sorted.length / 2);
    // An even count has no middle card; an odd one must read clearly as the middle.
    if (sorted.length % 2 === 0) return { ambiguous: labels([sorted[index - 1]!, sorted[index]!]), source: "ambiguous" };
    const middle = sorted[index]!;
    const near = [sorted[index - 1], sorted[index + 1]].filter((card): card is ContextCard => card !== undefined)
      .filter(card => stacked(card, middle, axis));
    return near.length ? { ambiguous: labels([...near, middle].sort((a, b) => position(a, axis) - position(b, axis))), source: "ambiguous" }
      : { targetId: middle.id, source: "spatial" };
  }
  const extreme = spatial.pick === "min" ? sorted[0]! : sorted.at(-1)!;
  const next = spatial.pick === "min" ? sorted[1] : sorted.at(-2);
  if (!next || !stacked(extreme, next, axis)) return { targetId: extreme.id, source: "spatial" };
  return { ambiguous: labels(sorted.filter(card => stacked(card, extreme, axis))), source: "ambiguous" };
}

/** ``X卡``/``X卡片`` names a card; demonstratives and collectives ("这张卡", "所有卡片") do not. */
const explicitCardReference = (text: string): boolean => {
  const name = /([\u4e00-\u9fa5A-Za-z0-9]{2,8})卡(?:片)?/u.exec(text)?.[1];
  return name !== undefined && !/(?:所有|全部|这些|那些|整个|任何|每张|几张|哪张|这张|那张|这个|那个|哪个|几个|一些|一张)$/u.test(name);
};
