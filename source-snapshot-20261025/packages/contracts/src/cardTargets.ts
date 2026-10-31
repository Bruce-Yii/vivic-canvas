import type { CardRecord, Subcard } from "./cardRecord";

export interface CardTarget { itemId?: string; anchor?: string; label: string }

// Positional rows have no intrinsic ID. Bind to BOTH original position and
// content; an edit/reorder invalidates the link instead of attaching to a stranger.
const fingerprint = (value: unknown): string => {
  const text = JSON.stringify(value);
  let a = 2166136261, b = 5381;
  for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ text.charCodeAt(i); }
  return `${(a >>> 0).toString(36)}-${(b >>> 0).toString(36)}`;
};

/** Short Chinese name of every registered card type (Control lists, search, references). */
export const CARD_TYPE_LABELS: Record<CardRecord["type"], string> = {
  FileCard: "文件",
  TravelOffersCard: "旅游结果", ExtensionCard: "扩展卡片",
  CountdownCard: "倒计时", TodoCard: "待办", NoteCard: "便笺", SearchResultCard: "搜索结果", WeatherCard: "天气", TableCard: "表格", ChartCard: "图表",
  PaperCard: "文献", GalleryCard: "照片墙", WeeklyScheduleCard: "周计划", RoadmapCard: "路线图", NewsCard: "资讯", TimelineCard: "时间线",
  QuoteCard: "金句", StoryCarouselCard: "照片故事", ActivityFeedCard: "动态", ProgressRingCard: "目标进度", HabitHeatmapCard: "习惯打卡",
  BookCard: "书籍", MonthCalendarCard: "月历", ComparisonCard: "方案对比", LinkPreviewCard: "链接收藏", PhotoCoverCard: "照片纪念", NotificationCard: "通知",
};

const hostname = (url: string): string | undefined => url.match(/^https?:\/\/([^/?#:@]+)/i)?.[1]?.toLowerCase();

/** The headline field of each scene card, if it has one. */
const sceneTitle = (card: CardRecord): string | undefined => {
  switch (card.type) {
    case "FileCard": return card.displayProps.name;
    case "TravelOffersCard": return `${card.displayProps.query.destination}旅游结果`;
    case "PaperCard": case "GalleryCard": case "WeeklyScheduleCard": case "RoadmapCard": case "TimelineCard": case "StoryCarouselCard":
    case "ActivityFeedCard": case "ProgressRingCard": case "BookCard": case "ComparisonCard": case "PhotoCoverCard": case "NotificationCard":
      return card.displayProps.title;
    case "NewsCard": return card.displayProps.headline;
    case "QuoteCard": return card.displayProps.text;
    case "HabitHeatmapCard": return card.displayProps.habit;
    case "MonthCalendarCard": return card.displayProps.title ?? card.displayProps.month;
    case "LinkPreviewCard": return card.displayProps.title ?? hostname(card.displayProps.url);
    case "TodoCard": case "ChartCard": return card.displayProps.title;
    default: return undefined;
  }
};

export const cardTitle = (card: CardRecord): string => card.metadata.aliases?.[0]
  || (card.type === "CountdownCard" ? card.sourceData.event?.title ?? card.sourceData.reminderText : undefined)
  || (card.type === "NoteCard" ? card.displayProps.text || card.displayProps.bullets?.[0] : undefined)
  || sceneTitle(card)
  || (card.type === "TodoCard" ? card.displayProps.items[0]?.text : undefined)
  || (card.type === "SearchResultCard" ? card.displayProps.title : undefined)
  || CARD_TYPE_LABELS[card.type];

export const cardTargets = (card: CardRecord): CardTarget[] => {
  const rows: CardTarget[] = [];
  if (card.type === "TodoCard") rows.push(...card.displayProps.items.map(item => ({ itemId: item.id, label: item.text })));
  if (card.type === "TableCard") rows.push(...card.displayProps.rows.map((row, i) => ({ itemId: `row:${i + 1}`, anchor: fingerprint(row), label: row.map(value => value ?? "—").join(" · ") })));
  if (card.type === "NoteCard") {
    if (card.displayProps.text) rows.push(...card.displayProps.text.split("\n").map((line, i) => ({ itemId: `line:${i + 1}`, anchor: fingerprint(line), label: line || "空行" })));
    rows.push(...(card.displayProps.bullets ?? []).map((line, i) => ({ itemId: `bullet:${i + 1}`, anchor: fingerprint(line), label: line })));
  }
  return [{ label: cardTitle(card) }, ...rows];
};

export const sameCardTarget = (a: Pick<Subcard, "itemId" | "anchor">, b: Pick<Subcard, "itemId" | "anchor">): boolean => a.itemId === b.itemId && a.anchor === b.anchor;
export const validCardTarget = (card: CardRecord, target: Pick<Subcard, "itemId" | "anchor">): boolean => cardTargets(card).some(item => sameCardTarget(item, target));
