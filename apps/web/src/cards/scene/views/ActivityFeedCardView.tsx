import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { CalendarClock, CircleCheck, MessageSquare, Plus, RefreshCw, TriangleAlert, X, type LucideIcon } from "lucide-react";
import { CARD_TYPE_LABELS, cardTitle, type ActivityFeedCard } from "@/contracts";
import { useVivicState, type CardState } from "@/state/canvasStore";
import { SceneCardShell, SceneEmpty } from "../SceneCardShell";
import { useCardEditor } from "../cardContext";
import { relativeTimeLabel } from "../dates";
import type { CardViewProps } from "../types";
import "./ActivityFeedCardView.css";

type FeedItem = ActivityFeedCard["displayProps"]["items"][number];
type Kind = FeedItem["kind"];

const MAX_ITEMS = 50;
const LIVE_LIMIT = 20;
const KINDS: Record<Kind, { icon: LucideIcon; label: string }> = {
  done: { icon: CircleCheck, label: "完成" },
  update: { icon: RefreshCw, label: "更新" },
  create: { icon: Plus, label: "新建" },
  comment: { icon: MessageSquare, label: "评论" },
  alert: { icon: TriangleAlert, label: "提醒" },
  event: { icon: CalendarClock, label: "日程" },
};
const KIND_ORDER = Object.keys(KINDS) as Kind[];
const timeOf = (item: Pick<FeedItem, "at">) => item.at ? Date.parse(item.at) : Number.NaN;
const clip = (text: string, max = 24) => {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
};

function useNow(intervalMs = 60_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Live feed: what happened to the other cards on this canvas, newest first. */
export function canvasActivity(cards: readonly CardState[], selfId: string): FeedItem[] {
  const entries: FeedItem[] = [];
  for (const { record, exitingRequestId } of cards) {
    if (exitingRequestId || record.id === selfId) continue;
    const name = `${CARD_TYPE_LABELS[record.type] ?? "卡片"}「${clip(cardTitle(record))}」`;
    const created = Date.parse(record.metadata.createdAt), updated = Date.parse(record.metadata.updatedAt);
    if (Number.isFinite(created)) entries.push({ id: `${record.id}:create`, kind: "create", text: `新建了${name}`, at: record.metadata.createdAt });
    if (Number.isFinite(updated) && (!Number.isFinite(created) || updated - created > 60_000)) {
      entries.push({ id: `${record.id}:update`, kind: "update", text: `更新了${name}`, at: record.metadata.updatedAt });
    }
  }
  return entries.sort((a, b) => timeOf(b) - timeOf(a)).slice(0, LIVE_LIMIT);
}

/** Stored items: newest first when every item is timed, otherwise the order they were given. */
const orderItems = (items: FeedItem[]): FeedItem[] =>
  items.length > 1 && items.every(item => Number.isFinite(timeOf(item))) ? [...items].sort((a, b) => timeOf(b) - timeOf(a)) : items;

export function ActivityFeedCardView({ card, height }: CardViewProps<"ActivityFeedCard">) {
  const { title, live, items } = card.displayProps;
  const editor = useCardEditor(card);
  const now = useNow();
  const cards = useVivicState(state => state.cards);
  const isLive = live === "canvas";
  const entries = useMemo(() => isLive ? canvasActivity(cards, card.id) : orderItems(items), [isLive, cards, card.id, items]);
  const reduced = useReducedMotion();
  // Rows present on first render appear as-is; only rows added later fade in.
  const initialIds = useRef<Set<string> | null>(null);
  if (initialIds.current === null) initialIds.current = new Set(entries.map(entry => entry.id));
  const editable = editor.editable && !isLive;
  return <SceneCardShell card={card} height={height} title={title}
    badge={isLive ? "实时" : `${items.length} 条`} badgeTone={isLive ? "positive" : "accent"}
    footer={isLive && editor.mode === "control" ? <span>根据画布上其他卡片的新建与更新时间自动生成</span> : undefined}>
    {entries.length === 0
      ? <SceneEmpty>{isLive ? "画布上还没有动态" : "还没有动态"}</SceneEmpty>
      : <ul className={`vivic-feed${height !== undefined ? " vivic-scene-scroll nowheel" : ""}`} data-editable={editable || undefined} data-feed-live={isLive || undefined}>
        {entries.map(entry => {
          const kind = KINDS[entry.kind] ?? KINDS.event;
          const Icon = kind.icon;
          const time = (entry.at ? relativeTimeLabel(entry.at, now) : "") || entry.time;
          return <motion.li key={entry.id} className="vivic-feed-item" data-kind={entry.kind} data-feed-item={entry.id}
            initial={initialIds.current?.has(entry.id) || reduced ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: "easeOut" }}>
            <span className="vivic-feed-icon" role="img" aria-label={kind.label}><Icon size={14} strokeWidth={2.2} aria-hidden /></span>
            <span className="vivic-feed-text vivic-scene-clamp-2">{entry.text}</span>
            {time && <time className="vivic-feed-time" dateTime={entry.at}>{time}</time>}
            {editable && <button type="button" className="vivic-scene-icon-button vivic-feed-delete nodrag nopan" aria-label={`删除：${entry.text.slice(0, 40)}`}
              onClick={() => editor.patch({ items: items.filter(item => item.id !== entry.id) })}><X size={13} /></button>}
          </motion.li>;
        })}
      </ul>}
    {editable && <AddEntryForm items={items} onAdd={next => editor.patch({ items: next })} />}
  </SceneCardShell>;
}

function AddEntryForm({ items, onAdd }: { items: FeedItem[]; onAdd: (next: FeedItem[]) => boolean }) {
  const [kind, setKind] = useState<Kind>("update");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  return <form className="vivic-feed-form nodrag nopan" data-feed-add onSubmit={submit => {
    submit.preventDefault();
    const value = text.trim().slice(0, 160);
    if (!value) return;
    const used = new Set(items.map(item => item.id));
    let n = items.length + 1;
    while (used.has(`act-${n}`)) n += 1;
    let next: FeedItem[] = [{ id: `act-${n}`, kind, text: value, at: new Date().toISOString() }, ...items];
    if (next.length > MAX_ITEMS) {
      // Drop the oldest: by time when every entry is timed, otherwise the last one in the given (newest-first) order.
      const oldest = next.every(item => Number.isFinite(timeOf(item))) ? next.reduce((a, b) => timeOf(b) < timeOf(a) ? b : a) : next[next.length - 1];
      next = next.filter(item => item !== oldest);
    }
    if (onAdd(next)) { setText(""); setError(null); } else setError("没有保存，请检查后重试。");
  }}>
    <select className="vivic-scene-input nodrag nopan" value={kind} aria-label="动态类型" onChange={change => setKind(change.target.value as Kind)}>
      {KIND_ORDER.map(value => <option key={value} value={value}>{KINDS[value].label}</option>)}
    </select>
    <input className="vivic-scene-input vivic-feed-form-text nodrag nopan" value={text} maxLength={160} placeholder="记录一条动态" aria-label="动态内容"
      onChange={change => setText(change.target.value)} />
    <button type="submit" className="vivic-scene-action nodrag nopan" disabled={!text.trim()}><Plus size={14} aria-hidden />添加</button>
    {error && <span role="alert" className="w-full text-xs text-[var(--vivic-danger)]">{error}</span>}
  </form>;
}
