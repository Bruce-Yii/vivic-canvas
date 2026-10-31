import type { IntentRouteId } from "@vivic/contracts";
import type { CanvasContext } from "../schemas.js";
import { cardLabel, cardTitle, selectedCards, type IntentRouter } from "./router.js";

/** Which mechanism decided the target. Optional so older callers and stored
 * traces stay valid; card text and titles never enter this field. */
export type TargetSource = "title" | "alias" | "focus" | "ordinal" | "type" | "spatial" | "classifier" | "frozen" | "user_pick" | "missing" | "ambiguous";
export type TargetResult = { targetId: string; source?: TargetSource } | { ambiguous: Array<{ id: string; label: string }>; source?: TargetSource } | { missing: true; source?: TargetSource };
const targeted = new Set<IntentRouteId>(["focus", "highlight", "edit", "arrange", "delete"]);
const types: Array<[RegExp, RegExp]> = [[/待办|任务清单/, /TodoCard/], [/便签|便笺|笔记/, /NoteCard/],
  [/倒计时|计时器|提醒/, /CountdownCard/], [/天气/, /WeatherCard/], [/新闻|回答/, /NewsCard/],
  [/表格/, /TableCard/], [/图表/, /ChartCard/]];
export async function resolveTarget(text: string, context: CanvasContext, route: IntentRouteId,
  router?: Pick<IntentRouter, "chooseTarget">, signal?: AbortSignal): Promise<TargetResult | undefined> {
  if (!targeted.has(route)) return undefined;
  const cards = selectedCards(context);
  const labels = (values: typeof cards) => values.map(card => ({ id: card.id, label: cardTitle(card).slice(0, 120) }));
  if (!cards.length) return { missing: true, source: "missing" };
  const names = cards.filter(card => [cardTitle(card), ...(card.aliases ?? [])]
    .some(name => name.length >= 2 && text.toLocaleLowerCase().includes(name.toLocaleLowerCase())));
  if (names.length === 1) {
    const title = cardTitle(names[0]!);
    return { targetId: names[0]!.id, source: title.length >= 2 && text.toLocaleLowerCase().includes(title.toLocaleLowerCase()) ? "title" : "alias" };
  }
  const ordinal = ["highlight", "edit"].includes(route) && /第[一二三四五六七八九十百\d]+[条项点行]/.test(text);
  const hasEntries = (card: typeof cards[number]) => [card.displayProps.items, card.displayProps.bullets,
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
  const spatial = /左边|左侧|最左/.test(text) ? { axis: "x" as const, sign: 1 }
    : /右边|右侧|最右/.test(text) ? { axis: "x" as const, sign: -1 }
      : /上面|上方|最上/.test(text) ? { axis: "y" as const, sign: 1 }
        : /下面|下方|最下/.test(text) ? { axis: "y" as const, sign: -1 } : null;
  if (spatial) {
    const sorted = [...pool].sort((a, b) => spatial.sign * (a.layout[spatial.axis] - b.layout[spatial.axis]));
    if (sorted.length === 1 || sorted[0]!.layout[spatial.axis] !== sorted[1]!.layout[spatial.axis]) {
      return { targetId: sorted[0]!.id, source: "spatial" };
    }
    return { ambiguous: labels(sorted.filter(card => card.layout[spatial.axis] === sorted[0]!.layout[spatial.axis])), source: "ambiguous" };
  }
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

/** ``X卡``/``X卡片`` names a card; demonstratives and collectives ("这张卡", "所有卡片") do not. */
const explicitCardReference = (text: string): boolean => {
  const name = /([\u4e00-\u9fa5A-Za-z0-9]{2,8})卡(?:片)?/u.exec(text)?.[1];
  return name !== undefined && !/(?:所有|全部|这些|那些|整个|任何|每张|几张|哪张|这张|那张|这个|那个|哪个|几个|一些|一张)$/u.test(name);
};
