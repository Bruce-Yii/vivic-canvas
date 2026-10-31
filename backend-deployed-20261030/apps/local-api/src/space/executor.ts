import { randomUUID } from "node:crypto";
import {
  ActionEnvelopeSchema, CardRecordSchema, cardFieldPolicyIssue, hostedCardHeight,
  type ActionEnvelope, type CardRecord, type HostedSpaceCommand,
} from "@vivic/contracts";
import { SpaceError, invalid } from "./errors.js";
export { hostedCardHeight } from "@vivic/contracts";

/** Unknown recovery fields survive every command and undo. Migration owns their interpretation. */
export interface SpaceDocument { cards: CardRecord[]; [key: string]: unknown }
export interface SpaceContent { title: string; document: SpaceDocument }
/** Only the existing renderer image slots are asset references; a note containing "media:..." stays ordinary text. */
export function hostedImageSources(card: CardRecord): string[] {
  switch (card.type) {
    case "GalleryCard": return card.displayProps.images.map(image => image.src);
    case "PhotoCoverCard": return card.displayProps.image ? [card.displayProps.image.src] : [];
    case "NewsCard": case "LinkPreviewCard": return card.displayProps.image ? [card.displayProps.image] : [];
    case "BookCard": return card.displayProps.cover ? [card.displayProps.cover] : [];
    case "StoryCarouselCard": return card.displayProps.slides.flatMap(slide => slide.image ? [slide.image] : []);
    default: return [];
  }
}
const copy = <T>(value: T): T => structuredClone(value);
const fail = (code: string, message: string): never => { throw new SpaceError(409, code, message); };
const safeObject = (value: unknown): boolean => {
  if (!value || typeof value !== "object") return true;
  return Object.entries(value).every(([key, child]) => !["__proto__", "constructor", "prototype"].includes(key) && safeObject(child));
};
export function parseCard(value: unknown): CardRecord {
  if (!safeObject(value)) invalid("卡片包含不支持的字段。");
  const result = CardRecordSchema.safeParse(value);
  if (!result.success) invalid("卡片未通过字段校验。");
  const card = result.data;
  if (![card.layout.x, card.layout.y, card.layout.width, card.layout.height].every(Number.isFinite)
    || Math.abs(card.layout.x) > 100000 || Math.abs(card.layout.y) > 100000
    || card.layout.width > 100000 || card.layout.height > 100000) invalid("卡片布局超出范围。");
  // userPos and all other original recovery metadata are intentionally retained.
  return { ...card, layout: { ...card.layout, surface: "display" } };
}

function overlaps(a: CardRecord["layout"], b: CardRecord["layout"], gap = 12) {
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
}
/** Fixed cards remain exact obstacles. Failure never silently persists an overlapping fallback. */
export function arrangeHostedCards(cards: CardRecord[], preserved: ReadonlySet<string> = new Set()): CardRecord[] {
  const fixed = (card: CardRecord) => card.layout.pinned || preserved.has(card.id);
  const automatic = cards.filter(card => !fixed(card));
  const cellWidth = Math.max(260, ...automatic.map(card => card.layout.width));
  const cellHeight = Math.max(140, ...automatic.map(hostedCardHeight));
  const occupied = cards.filter(fixed).map(card => ({ ...card.layout, height: hostedCardHeight(card) }));
  let cursor = 0;
  return cards.map(card => {
    if (fixed(card)) return card;
    const height = hostedCardHeight(card);
    for (let attempt = 0; attempt < 20000; attempt++, cursor++) {
      const x = (cursor % 3) * (cellWidth + 48), y = Math.floor(cursor / 3) * (cellHeight + 40);
      const layout = { ...card.layout, x, y, height, surface: "display" as const };
      if (Math.abs(x) > 100000 || Math.abs(y) > 100000) break;
      if (!occupied.some(rect => overlaps(layout, rect))) { occupied.push(layout); cursor++; return { ...card, layout }; }
    }
    return fail("layout-full", "空间内没有足够的无重叠位置，请先调整固定卡片。");
  });
}
export function updateHostedCard(card: CardRecord, patch: { variant?: CardRecord["variant"]; displayProps?: Record<string, unknown>; sourceData?: Record<string, unknown> }, stamp: string, authority: "user" | "provider" = "user"): CardRecord {
  if (!safeObject(patch)) invalid("卡片包含不支持的字段。");
  if (authority === "user") {
    if (patch.sourceData && Object.keys(patch.sourceData).length) {
      const writable = ["targetAt", "startedAt", "pausedAt", "reminderText", "schedule", "condition", "timeZone"];
      if (card.type !== "CountdownCard" || Object.keys(patch.sourceData).some(key => !writable.includes(key))) invalid("服务事实与提醒投递标记不可直接修改。");
    }
    if (patch.displayProps && Object.keys(patch.displayProps).length) {
      const writable = card.type === "NoteCard" ? ["text", "bullets"] : card.type === "TodoCard" ? ["title", "items"]
        : card.type === "GalleryCard" ? ["title", "images"] : card.type === "PhotoCoverCard" ? ["title", "date", "caption", "image"]
        : card.type === "TravelOffersCard" ? ["selectedIds", "notes"] : card.type === "ExtensionCard" ? ["state"] : [];
      if (Object.keys(patch.displayProps).some(key => !writable.includes(key))) invalid("服务结果不可直接修改。");
    }
  }
  const result = parseCard({ ...card, variant: patch.variant ?? card.variant,
    displayProps: { ...card.displayProps, ...patch.displayProps }, sourceData: { ...card.sourceData, ...patch.sourceData },
    metadata: { ...card.metadata, updatedAt: stamp } });
  const issue = cardFieldPolicyIssue(card, result, authority);
  if (issue) invalid(issue);
  return result;
}
const findCard = (cards: CardRecord[], id: string): CardRecord => cards.find(card => card.id === id) ?? fail("card-not-found", "卡片不存在或已删除。");
export function executeHostedCommand(current: SpaceContent, command: HostedSpaceCommand, stamp: string): SpaceContent {
  let cards = copy(current.document.cards), title = current.title;
  const base = () => ({ id: `card_${randomUUID()}`, variant: "expanded" as const, sources: [],
    layout: { x: 0, y: 0, width: 320, height: 120, pinned: false, surface: "display" as const },
    metadata: { createdAt: stamp, updatedAt: stamp } });
  const add = (value: unknown) => {
    if (cards.length >= 1000) fail("space-card-limit", "每个空间最多保存1000张卡片。");
    const card = parseCard(value);
    cards = arrangeHostedCards([...cards, card], new Set(cards.map(item => item.id)));
  };
  switch (command.type) {
    case "note.create": add({ ...base(), type: "NoteCard", displayProps: { text: command.text }, sourceData: command.title ? { title: command.title } : {} }); break;
    case "todo.create": add({ ...base(), type: "TodoCard", displayProps: { ...(command.title ? { title: command.title } : {}),
      items: command.items.map(text => ({ id: `item_${randomUUID()}`, text, done: false })) }, sourceData: {} }); break;
    case "reminder.create": add({ ...base(), type: "CountdownCard", variant: "minimal", displayProps: {},
      sourceData: { targetAt: new Date(Date.parse(stamp) + command.seconds * 1000).toISOString(), startedAt: stamp, reminderText: command.text } }); break;
    case "card.update": {
      const card = findCard(cards, command.cardId), updated = updateHostedCard(card, command, stamp);
      cards = cards.map(item => item.id === card.id ? updated : item);
      cards = arrangeHostedCards(cards); break;
    }
    case "card.delete": findCard(cards, command.cardId); cards = cards.filter(card => card.id !== command.cardId); break;
    case "card.pin": {
      const card = findCard(cards, command.cardId);
      cards = cards.map(item => item.id === card.id ? { ...item, layout: { ...item.layout, pinned: command.pinned }, metadata: { ...item.metadata, updatedAt: stamp } } : item); break;
    }
    case "card.move": {
      const card = findCard(cards, command.cardId);
      const layout = { ...card.layout, x: command.x, y: command.y, height: hostedCardHeight(card), pinned: false };
      cards = cards.map(item => item.id === card.id ? { ...item, layout, metadata: { ...item.metadata, updatedAt: stamp } } : item); break;
    }
    case "canvas.arrange": {
      const fixed = cards.filter(card => card.layout.pinned);
      if (fixed.some((card, index) => fixed.slice(index + 1).some(other => overlaps(
        { ...card.layout, height: hostedCardHeight(card) }, { ...other.layout, height: hostedCardHeight(other) }, 0)))) {
        fail("pinned-overlap", "固定卡片彼此重叠，请先取消固定并调整位置，再整理空间。");
      }
      cards = arrangeHostedCards(cards); break;
    }
    case "canvas.rename": title = command.title; break;
    case "history.undo": case "history.redo": invalid("历史操作需要通过持久化执行器处理。");
  }
  return { title, document: { ...current.document, cards } };
}

/** Internal-only capability. HTTP accepts HostedSpaceCommand, never arbitrary envelopes. */
export function executeHostedEnvelope(current: SpaceContent, raw: ActionEnvelope, stamp: string): SpaceContent {
  const parsed = ActionEnvelopeSchema.safeParse(raw);
  if (!parsed.success) invalid("执行计划未通过校验。");
  let cards = copy(current.document.cards);
  for (const action of parsed.data.actions) {
    switch (action.type) {
      case "card.create": {
        const created = parseCard(action.card), previous = cards.find(card => card.id === created.id);
        if (!previous && cards.length >= 1000) fail("space-card-limit", "每个空间最多保存1000张卡片。");
        // A provider may refresh its result but cannot change the stable card identity/type.
        if (previous && previous.type !== created.type) invalid("不能修改卡片类型。");
        const value = previous?.layout.pinned ? { ...created, layout: { ...previous.layout, surface: "display" as const } } : created;
        cards = previous ? cards.map(card => card.id === value.id ? value : card) : [...cards, value]; break;
      }
      case "card.update": {
        const card = findCard(cards, action.targetId), updated = updateHostedCard(card, action, stamp, "provider");
        cards = cards.map(item => item.id === card.id ? updated : item); break;
      }
      case "card.delete": findCard(cards, action.targetId); cards = cards.filter(card => card.id !== action.targetId); break;
      case "cards.delete": action.targetIds.forEach(id => findCard(cards, id)); cards = cards.filter(card => !action.targetIds.includes(card.id)); break;
      case "card.subcard.set": {
        const card = findCard(cards, action.targetId), subcards = [...(card.metadata.subcards ?? []).filter(item => item.id !== action.subcard.id), action.subcard];
        const updated = parseCard({ ...card, metadata: { ...card.metadata, subcards, updatedAt: stamp } });
        cards = cards.map(item => item.id === card.id ? updated : item); break;
      }
      case "card.subcard.delete": {
        const card = findCard(cards, action.targetId), updated = parseCard({ ...card, metadata: { ...card.metadata,
          subcards: (card.metadata.subcards ?? []).filter(item => item.id !== action.subcardId), updatedAt: stamp } });
        cards = cards.map(item => item.id === card.id ? updated : item); break;
      }
      case "stage.awaken": case "stage.sleep": case "card.focus": case "card.highlight": case "canvas.fit": case "canvas.restore":
      case "subtitle.show": case "subtitle.hide": break; // presentation effects do not mutate authoritative cards
      case "canvas.create": case "canvas.switch": case "ambient.setPreset": invalid("执行计划不能切换目标空间或修改设备偏好。");
    }
  }
  return { title: current.title, document: { ...current.document, cards: arrangeHostedCards(cards) } };
}
