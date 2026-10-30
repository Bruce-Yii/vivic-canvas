import { ViewportPortal } from "@xyflow/react";
import { HarkIcon } from "@/components/hark/HarkPrimitives";
import type { CardState } from "@/state/canvasStore";
import { presentCards } from "./reminderPresentation";

export function CanvasSections({ cards, collapsed, onToggle, focusId }: { cards: CardState[]; collapsed: ReadonlySet<string>; onToggle(section: string): void; focusId?: string }) {
  const groups = new Map<string, CardState[]>();
  const shown = new Set(presentCards(cards, { focusId }).flatMap(item => item.memberIds));
  for (const entry of cards.filter(card => shown.has(card.record.id))) {
    if (!entry.record.metadata.section || entry.record.layout.surface === "user" || entry.exitingRequestId) continue;
    const name = entry.record.metadata.section;
    groups.set(name, [...groups.get(name) ?? [], entry]);
  }
  return <ViewportPortal><div style={{ pointerEvents: "none" }} data-vivic-sections>
    {[...groups].map(([name, entries]) => {
      const moving = entries.filter(c => !c.record.layout.pinned), group = moving.length ? moving : entries;
      const x = Math.min(...group.map(c => c.record.layout.x)), y = Math.min(...group.map(c => c.record.layout.y));
      return <button key={name} type="button" className="nodrag nopan flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm backdrop-blur-xl"
        style={{ position: "absolute", left: x, top: y - 46, pointerEvents: "auto", background: "var(--regular-bg)", color: "var(--text-primary)" }}
        aria-label={`${collapsed.has(name) ? "展开" : "收起"}分区：${name}`} aria-expanded={!collapsed.has(name)} onClick={() => onToggle(name)} data-space-section={name}>
        <HarkIcon name={collapsed.has(name) ? "next" : "down"} size={12} />{name}<span className="opacity-50">{entries.length}</span>
      </button>;
    })}
  </div></ViewportPortal>;
}
