import PinyinMatch from "pinyin-match";
import { CARD_TYPE_LABELS as TYPE_NAMES, cardTitle, sceneOfCard, type CardRecord } from "@/contracts";

export const CARD_TYPE_LABELS: Record<CardRecord["type"], string> = {
  ...TYPE_NAMES, CountdownCard: "提醒 / 计时", SearchResultCard: "搜索 / 文章",
};

/** Readable strings inside a scene card's data; links and local photo refs are skipped. */
const sceneStrings = (value: unknown, out: string[] = []): string[] => {
  if (typeof value === "string") { if (!/^(?:https?:|media:)/.test(value)) out.push(value); }
  else if (Array.isArray(value)) value.forEach(item => sceneStrings(item, out));
  else if (value && typeof value === "object") Object.values(value).forEach(item => sceneStrings(item, out));
  return out;
};

export const cardSearchText = (card: CardRecord): string[] => [cardTitle(card), ...(card.metadata.aliases ?? []),
  ...(card.type === "NoteCard" ? [card.displayProps.text ?? "", ...(card.displayProps.bullets ?? [])]
    : card.type === "TodoCard" ? card.displayProps.items.map(item => item.text)
    : card.type === "CountdownCard" ? [card.sourceData.reminderText ?? "", card.sourceData.event?.title ?? "", card.sourceData.event?.note ?? ""]
    : card.type === "SearchResultCard" ? [card.displayProps.title, card.displayProps.summary]
    : sceneOfCard(card) ? sceneStrings(card.displayProps) : [])];

export function cardMatches(card: CardRecord, query: string): boolean {
  const normalized = query.trim().normalize("NFKC").toLocaleLowerCase();
  if (!normalized) return true;
  return cardSearchText(card).some(text => {
    const value = text.normalize("NFKC").toLocaleLowerCase();
    return value.includes(normalized) || Boolean(PinyinMatch.match(value, normalized));
  });
}

export const cardSearchSummary = (card: CardRecord): string => (card.type === "SearchResultCard" ? card.displayProps.summary
  : card.type === "TodoCard" ? card.displayProps.items.map(item => item.text).join(" · ")
  : card.type === "NoteCard" ? [card.displayProps.text, ...(card.displayProps.bullets ?? [])].filter(Boolean).join(" · ")
  : card.type === "CountdownCard" ? card.sourceData.event ? `${card.sourceData.event.title} · ${card.sourceData.event.date}` : card.sourceData.reminderText ?? "纯数字计时器"
  : sceneOfCard(card) ? sceneStrings(card.displayProps).slice(1, 4).join(" · ") || CARD_TYPE_LABELS[card.type]
  : CARD_TYPE_LABELS[card.type]);

/** A scan-friendly label only; matching and stored originals remain intact. */
export const searchPreview = (text: string, maxLength = 100): string => text
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
  .replace(/^\s{0,3}#{1,6}\s+/gm, "")
  .replace(/[`*_~]/g, "")
  .replace(/\s+/g, " ").trim().slice(0, maxLength);
