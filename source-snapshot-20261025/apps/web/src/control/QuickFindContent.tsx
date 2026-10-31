import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { cardTitle } from "@/contracts";
import { canvasStore, useVivicState } from "@/state/canvasStore";
import { completedCountdown } from "@/canvas/reminderPresentation";
import { Command, CommandInput, CommandList, CommandEmpty, CommandItem } from "@/components/ui/command";
import type { ControlHost } from "@/sync/controlHost";
import { newId } from "@/lib/id";
import type { FindImeController } from "./QuickFind";
import { CARD_TYPE_LABELS, cardMatches, cardSearchSummary, searchPreview } from "./cardSearch";

export default function QuickFindContent({ host, canvasId, onClose, ime }: {
  host: ControlHost; canvasId: string | null; onClose: () => void; ime: FindImeController;
}) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus({ preventScroll: true }); }, []);
  const snapshot = useSyncExternalStore(host.subscribe, host.getSnapshot);
  const cards = useVivicState(state => state.cards);
  const readonly = !snapshot.ready || snapshot.ownerMode !== "owner";
  const visible = cards.filter(entry => !entry.exitingRequestId && !completedCountdown(entry) && cardMatches(entry.record, query));
  // Filtering may remove the highlighted item. Keep cmdk's controlled value
  // valid in this same render so a quick Enter cannot target the old list.
  const selected = visible.some(entry => entry.record.id === selectedId) ? selectedId : visible[0]?.record.id ?? "";
  return <>
    <Command label="当前画布的卡片" shouldFilter={false} value={selected} onValueChange={setSelectedId} loop onKeyDownCapture={event => {
      if ((ime.get().composing || event.nativeEvent.isComposing || event.keyCode === 229 || (event.key === "Enter" && Date.now() - ime.get().endedAt < 50))
        && ["Enter", "Escape", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) event.stopPropagation();
    }}>
      <CommandInput ref={inputRef} placeholder="输入卡片内容或拼音…" value={query} onValueChange={setQuery}
        onCompositionStart={ime.start} onCompositionEnd={ime.end} />
      <CommandList className="vivic-find-list">
        <CommandEmpty>当前画布没有匹配的卡片</CommandEmpty>
        {visible.map(({ record }) => <CommandItem key={record.id} value={record.id} disabled={readonly}
          data-vivic-find-result={record.id} onSelect={() => {
            if (ime.get().composing || Date.now() - ime.get().endedAt < 50) return;
            const current = host.getSnapshot();
            const entry = canvasStore.getState().cards.find(item => item.record.id === record.id && !item.exitingRequestId && !completedCountdown(item));
            if (!entry || current.activeCanvasId !== canvasId || current.ownerMode !== "owner" || !current.ready) { setError("目标或控制权已变更，请重新找卡。"); return; }
            const result = host.dispatch({ schemaVersion: "0.6", requestId: newId("find-card"), canvasId: current.activeCanvasId,
              actions: [{ type: "card.focus", targetId: entry.record.id }] });
            if (result.ok) onClose(); else setError("尚未聚焦，请检查控制权。");
          }}>
          <div className="min-w-0 flex-1 py-2">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1"><span className="vivic-reading-caption">{CARD_TYPE_LABELS[record.type]}</span>
              <span className="vivic-find-id" title={record.id}>ID: {record.id}</span></div>
            <p className="mt-1 line-clamp-2 break-words font-medium">{searchPreview(cardTitle(record), 140)}</p>
            <p className="vivic-reading-caption mt-1 line-clamp-2 break-words">{searchPreview(cardSearchSummary(record))}</p>
          </div>
        </CommandItem>)}
      </CommandList>
    </Command>
    <footer className="vivic-find-footer" role="status">{readonly ? "当前窗口只读；可搜索，聚焦需在主控窗口操作。" : "↑ ↓ 选择 · Enter 聚焦 · Esc 关闭"}{error && <p role="alert">{error}</p>}</footer>
  </>;
}
