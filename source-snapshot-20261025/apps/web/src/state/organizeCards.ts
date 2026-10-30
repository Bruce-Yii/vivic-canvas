import { z } from "zod";
import { CARD_TYPE_LABELS, cardTitle, isDateCountdown, type CardRecord } from "@/contracts";
import { cardHeight, relayout, type CardState } from "./canvasStore";

export const OrganizeOptionsSchema = z.strictObject({
  sort: z.enum(["manual", "due", "created", "updated", "priority", "type", "size"]),
  direction: z.enum(["asc", "desc"]),
  group: z.enum(["keep", "none", "type", "priority", "date"]),
});
export type OrganizeOptions = z.infer<typeof OrganizeOptionsSchema>;
export const CardOrganizationSchema = z.strictObject({
  section: z.string().trim().max(60).optional(),
  priority: z.enum(["high", "normal", "low"]).optional(),
  dueDate: z.union([z.iso.date(), z.literal("")]).optional(),
});
export type CardOrganization = z.infer<typeof CardOrganizationSchema>;
export const cardDueDate = (card: CardRecord): string | undefined => {
  if (card.metadata.dueDate) return card.metadata.dueDate;
  if (card.type === "CountdownCard") return isDateCountdown(card) ? card.sourceData.event.date : card.sourceData.targetAt.slice(0, 10);
  return undefined;
};
const priority = (card: CardRecord) => ({ high: 0, normal: 1, low: 2 })[card.metadata.priority ?? "normal"];
export const cardSection = (card: CardRecord) => card.metadata.section ?? "未分区";
export const sortCards = (cards: CardState[], options: OrganizeOptions): CardState[] => {
  const { sort, direction } = options, sign = direction === "asc" ? 1 : -1;
  return cards.map((card, index) => ({ card, index })).sort((a, b) => {
    const x = a.card.record, y = b.card.record;
    if (sort === "manual") return a.index - b.index;
    if (sort === "due") {
      const d1 = cardDueDate(x), d2 = cardDueDate(y);
      if (!d1 || !d2) return d1 ? -1 : d2 ? 1 : a.index - b.index;
      return sign * d1.localeCompare(d2) || a.index - b.index;
    }
    const delta = sort === "priority" ? priority(x) - priority(y) : sort === "size" ? x.layout.width * x.layout.height - y.layout.width * y.layout.height
      : sort === "type" ? CARD_TYPE_LABELS[x.type].localeCompare(CARD_TYPE_LABELS[y.type], "zh-CN")
        : x.metadata[sort === "created" ? "createdAt" : "updatedAt"].localeCompare(y.metadata[sort === "created" ? "createdAt" : "updatedAt"]);
    return sign * delta || a.index - b.index;
  }).map(item => item.card);
};
export function organizedCards(cards: CardState[], options: OrganizeOptions): CardState[] {
  const sorted = sortCards(cards, options);
  const sectionFor = (card: CardRecord) => options.group === "type" ? CARD_TYPE_LABELS[card.type] : options.group === "priority" ? ["重要", "常规", "稍后"][priority(card)]!
    : options.group === "date" ? cardDueDate(card) ?? "未定日期" : options.group === "none" ? undefined : card.metadata.section;
  const grouped = sorted.map(entry => {
    const section = sectionFor(entry.record);
    if (section === entry.record.metadata.section) return entry;
    const metadata = { ...entry.record.metadata }; if (section) metadata.section = section; else delete metadata.section;
    return { ...entry, record: { ...entry.record, metadata } };
  });
  const sections = [...new Set(grouped.filter(c => c.record.layout.surface !== "user").map(c => c.record.metadata.section))];
  if (!sections.some(Boolean)) return relayout(grouped);
  // One row-aligned area per section; pinned cards remain absolute obstacles.
  const fixed = grouped.filter(c => c.record.layout.pinned && c.record.layout.surface !== "user");
  let y = fixed.length ? Math.max(0, ...fixed.map(c => c.record.layout.y + cardHeight(c) + 80)) : 56;
  const positions = new Map<string, CardRecord["layout"]>();
  for (const section of sections) {
    const moving = grouped.filter(c => c.record.metadata.section === section && !c.record.layout.pinned && c.record.layout.surface !== "user");
    const local = relayout(moving);
    for (const entry of local) positions.set(entry.record.id, { ...entry.record.layout, y: entry.record.layout.y + y });
    if (local.length) y += Math.max(...local.map(c => c.record.layout.y + c.record.layout.height)) + 104;
  }
  return grouped.map(entry => positions.has(entry.record.id) ? { ...entry, record: { ...entry.record, layout: positions.get(entry.record.id)! } } : entry);
}

export function organizationPreview(cards: CardState[], options: OrganizeOptions) {
  return organizedCards(cards, options).map(({ record }) => ({ id: record.id, title: cardTitle(record), section: cardSection(record), pinned: record.layout.pinned }));
}
