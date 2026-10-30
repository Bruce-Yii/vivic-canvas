import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Dialog } from "radix-ui";
import { BookOpen } from "lucide-react";
import { cardTitle, type CardRecord } from "@/contracts";
import { useVivicState } from "@/state/canvasStore";
import { renderVivicSpec } from "@/cards/vivicGUILibrary";
import { Button } from "@/components/ui/button";
import { ControlDialogContent } from "./ControlDialogContent";

const hasReadingDetails = (card: CardRecord) => card.type === "NoteCard" || card.type === "SearchResultCard";
const DetailsContext = createContext<((id: string, trigger: HTMLElement) => void) | null>(null);

/** Mounted per canvas/owner scope. Only a stable ID is retained, never card data. */
export function CardDetailsReader({ children }: { children: ReactNode }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const card = useVivicState(state => state.cards.find(entry => entry.record.id === selectedId && !entry.exitingRequestId)?.record);
  useEffect(() => {
    // Clear the selected ID as well as closing its surface: an undo must not
    // reopen a previously deleted target. This syncs transient UI with store.
    // oxlint-disable-next-line react/set-state-in-effect
    if (selectedId && (!card || !hasReadingDetails(card))) setSelectedId(null);
  }, [selectedId, card]);
  const openDetails = useCallback((id: string, trigger: HTMLElement) => {
    // Safari pointer clicks need not focus a button. Restore to the actual
    // trigger, never an unrelated active element or document.body.
    returnFocus.current = trigger;
    setSelectedId(id);
  }, []);
  const article = card?.type === "SearchResultCard" && typeof card.sourceData.articleText === "string" ? card.sourceData.articleText : null;
  const connected = card?.type === "NoteCard" && card.sourceData.connectedSource && typeof card.sourceData.connectedSource === "object"
    ? card.sourceData.connectedSource as Record<string, unknown> : null;
  const connectedText = connected && typeof connected.text === "string" ? connected.text.slice(0, 24000) : null;
  const kind = card?.type === "NoteCard" ? "便笺原文" : article !== null ? (card?.type === "SearchResultCard" && card.sourceData.truncated ? "网页正文 · 已截取" : "网页正文") : "搜索摘要";
  return <>
    <DetailsContext.Provider value={openDetails}>{children}</DetailsContext.Provider>
    <Dialog.Root open={Boolean(card && selectedId)} onOpenChange={open => { if (!open) setSelectedId(null); }}>
      <ControlDialogContent title={card ? cardTitle(card).split("\n")[0]!.slice(0, 140) : "阅读详情"}
        description={kind} className="vivic-details-dialog" data-vivic-card-details={selectedId ?? undefined}
        onCloseAutoFocus={event => { event.preventDefault();
          const fallback = document.querySelector<HTMLElement>("[data-vivic-find-cards]");
          (returnFocus.current?.isConnected ? returnFocus.current : fallback)?.focus({ preventScroll: true });
        }}>
        <div className="vivic-details-scroll" tabIndex={0} aria-label="详情正文" data-vivic-details-scroll>
          <article className="vivic-reading-body select-text">
            {card?.type === "NoteCard" && <>
              {renderVivicSpec({ _type: "Markdown", value: card.displayProps.text ?? "" })}
              {!!card.displayProps.bullets?.length && renderVivicSpec({ _type: "Markdown", value: card.displayProps.bullets.map(text => `- ${text}`).join("\n") })}
              {connectedText && <details open className="mt-5 border-t border-border pt-3"><summary className="text-xs opacity-60">服务查询原文{connected?.truncated === true ? " · 已截取" : ""}</summary>
                {renderVivicSpec({ _type: "Markdown", value: connectedText })}</details>}
            </>}
            {card?.type === "SearchResultCard" && renderVivicSpec({ _type: "Markdown", value: article ?? card.displayProps.summary })}
          </article>
          {!!card?.sources.length && <footer className="vivic-reading-sources">
            <h3 className="text-sm font-medium">来源</h3>
            {card.sources.map((source, i) => <a key={`${i}:${source.url}`} href={source.url} target="_blank" rel="noopener noreferrer" className="block break-words underline underline-offset-4">
              {source.title || source.url}
            </a>)}
          </footer>}
        </div>
      </ControlDialogContent>
    </Dialog.Root>
  </>;
}

export function ReadDetailsButton({ card }: { card: CardRecord }) {
  const onOpen = useContext(DetailsContext);
  return hasReadingDetails(card) && onOpen ? <Button variant="ghost" size="sm" onClick={event => onOpen(card.id, event.currentTarget)}
    data-vivic-read-details={card.id} aria-label={`阅读详情：${cardTitle(card).slice(0, 70)}`}><BookOpen size={15} aria-hidden />阅读详情</Button> : null;
}
