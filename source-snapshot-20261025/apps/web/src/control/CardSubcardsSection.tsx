import { useMemo, useSyncExternalStore, useState, useEffect } from "react";
import { Accordion } from "radix-ui";
import { ChevronDown } from "lucide-react";
import { cardTitle, validCardTarget, type Action } from "@/contracts";
import { canvasStore, useVivicState } from "@/state/canvasStore";
import { completedCountdown } from "@/canvas/reminderPresentation";
import { VivicCard } from "@/cards/VivicCard";
import { SubcardAnchor } from "@/cards/SubcardAnchor";
import { SubcardEditorContext } from "@/cards/SubcardEditorContext";
import { TargetBadge } from "@/cards/TargetBadge";
import { Button } from "@/components/ui/button";
import { newId } from "@/lib/id";
import type { ControlHost } from "@/sync/controlHost";
import { CardDetailsReader, ReadDetailsButton } from "./CardDetailsDialog";

export const CardSubcardsSection = ({ host }: { host: ControlHost }) => {
  const snapshot = useSyncExternalStore(host.subscribe, host.getSnapshot);
  const cards = useVivicState(state => state.cards);
  const highlight = useVivicState(state => state.highlight);
  useEffect(() => {
    if (!highlight) return;
    const timer = setTimeout(() => canvasStore.internal({ type: "highlight.clear", id: highlight.id }), highlight.durationMs);
    return () => clearTimeout(timer);
  }, [highlight]);
  const [error, setError] = useState<string | null>(null);
  const editable = snapshot.ready && snapshot.ownerMode === "owner";
  const context = useMemo(() => ({ editable, dispatch: (action: Action) => {
    const current = host.getSnapshot();
    if (!editable || current.ownerMode !== "owner" || current.activeCanvasId !== snapshot.activeCanvasId || !("targetId" in action)) return false;
    const card = canvasStore.getState().cards.find(c => c.record.id === action.targetId && !c.exitingRequestId && !completedCountdown(c))?.record;
    if (!card || (action.type === "card.subcard.set" && (!validCardTarget(card, action.subcard)
      || ((card.metadata.subcards?.length ?? 0) >= 24 && !card.metadata.subcards?.some(item => item.id === action.subcard.id))))) return false;
    return host.dispatch({ schemaVersion: "0.6", requestId: newId("subcard"), canvasId: current.activeCanvasId, actions: [action] }).ok;
  } }), [host, editable, snapshot.activeCanvasId]);
  const visible = cards.filter(c => !c.exitingRequestId && !completedCountdown(c));
  return <CardDetailsReader><section className="rounded-xl border border-neutral-200 bg-white p-4" data-vivic-card-subcards>
    <h2 className="text-sm font-semibold">卡片与子卡片</h2>
    <p className="mt-2 text-xs text-neutral-500">打开卡片，在对应行旁添加扩充；展示端可沿箭头阅读。</p>
    <SubcardEditorContext.Provider value={context} key={`${snapshot.activeCanvasId}:${snapshot.ownerMode}`}>
      <Accordion.Root type="single" collapsible className="mt-3">
        {visible.map(({ record }) => <Accordion.Item key={record.id} value={record.id} className="border-b border-neutral-100 last:border-0" data-vivic-inspect-card={record.id}>
          <div className="flex items-center gap-2"><Accordion.Header className="min-w-0 flex-1"><Accordion.Trigger data-vivic-inspect-toggle className="flex w-full items-center gap-2 py-3 text-left text-sm focus-visible:outline-2">
            <span className="vivic-inspect-number"><TargetBadge cardId={record.id} /></span><span className="min-w-0 flex-1 break-words line-clamp-2">{cardTitle(record)}</span>
            <ChevronDown size={16} className="shrink-0" /></Accordion.Trigger></Accordion.Header>
            <ReadDetailsButton card={record} /></div>
          <Accordion.Content className="pb-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <SubcardAnchor card={record}>整张卡片的扩充</SubcardAnchor>
              <div className="flex gap-1"><Button variant="ghost" size="sm" disabled={!editable} onClick={() => context.dispatch({ type: "card.highlight", targetId: record.id, durationMs: 5000 })}>定位</Button>
                <Button variant="ghost" size="sm" disabled={!editable} onClick={() => {
                  if (!context.dispatch({ type: "card.delete", targetId: record.id })) setError("尚未删除，请检查控制权。");
                }}>删除{record.type === "CountdownCard" ? "这项提醒" : "这张卡片"}</Button></div>
            </div>
            <div className="rounded-xl border border-neutral-200 p-4" style={{ maxWidth: "100%" }}>
              <VivicCard record={record} highlight={highlight} />
              {record.type === "TodoCard" && record.displayProps.items.slice(5).map(item => <div key={item.id} className="mt-2">
                <SubcardAnchor card={record} itemId={item.id}>{item.text}</SubcardAnchor></div>)}
            </div>
            {(record.metadata.subcards ?? []).some(item => !validCardTarget(record, item)) && <div className="mt-2 text-xs text-neutral-500" data-vivic-detached-subcards>
              <p>原行已改变，以下子卡片暂未关联；内容仍保留。</p>
              {(record.metadata.subcards ?? []).filter(item => !validCardTarget(record, item)).map(item => <div key={item.id} className="mt-2 rounded border p-2">
                <p className="whitespace-pre-wrap break-words select-text">{item.text}</p>
                <Button variant="ghost" size="sm" disabled={!editable} onClick={() => context.dispatch({ type: "card.subcard.set", targetId: record.id, subcard: { id: item.id, text: item.text } })}>移到整张卡片</Button>
              </div>)}
            </div>}
          </Accordion.Content>
        </Accordion.Item>)}
      </Accordion.Root>
    </SubcardEditorContext.Provider>
    {!visible.length && <p className="mt-3 text-xs text-neutral-500">当前画布暂无卡片</p>}
    <p className="mt-2 text-xs text-neutral-500">删除提醒或卡片后，输入「撤销」即可恢复。</p>
    {error && <p role="alert" className="mt-2 text-xs text-red-700">{error}</p>}
  </section></CardDetailsReader>;
};
