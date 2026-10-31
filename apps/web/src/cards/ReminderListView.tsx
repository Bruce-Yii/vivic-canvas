import { useEffect, useState } from "react";
import type { CountdownCard } from "@/contracts";
import { formatRemaining } from "./CountdownCardView";
import { renderVivicSpec } from "./vivicGUILibrary";
import { SubcardAnchor } from "./SubcardAnchor";
import { TargetBadge } from "./TargetBadge";
import { CalendarClock, Repeat2 } from "lucide-react";
export function ReminderListView({ cards, focusedId, highlightedId }: { cards: CountdownCard[]; focusedId?: string; highlightedId?: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(timer); }, []);
  return <div className="vivic-reminder-list" data-vivic-reminder-list>
    {cards.map(card => <div key={card.id} className="vivic-reminder-row" data-vivic-reminder-row={card.id}
      data-vivic-highlighted={highlightedId === card.id || undefined} data-reminder-focused={focusedId === card.id || undefined}>
      <TargetBadge cardId={card.id} />
      <div className="min-w-0">
        {(card.sourceData.schedule || card.sourceData.timeZone || card.sourceData.condition) && <span className="mb-1 flex items-center gap-1 text-xs opacity-65" data-vivic-plan-label>
          {card.sourceData.schedule ? <Repeat2 size={12} aria-hidden /> : <CalendarClock size={12} aria-hidden />}
          {card.sourceData.schedule ? "重复提醒" : card.sourceData.condition ? "条件提醒" : "定时提醒"}
        </span>}
        <SubcardAnchor card={card}>{renderVivicSpec({ _type: "Text", value: card.sourceData.reminderText ?? "倒计时", size: "base", weight: "medium" })}</SubcardAnchor>
      </div>
      <div className="vivic-reminder-time">{renderVivicSpec({ _type: "Text", value: card.sourceData.condition && !card.sourceData.conditionMetAt ? "等待" : formatRemaining(card.sourceData.targetAt, card.sourceData.pausedAt ? Date.parse(card.sourceData.pausedAt) : now), weight: "semibold", size: "xl" })}
        {card.sourceData.pausedAt && <span className="text-xs opacity-60">已暂停</span>}
      </div>
    </div>)}
  </div>;
}
