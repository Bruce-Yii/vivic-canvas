import type { SearchResultCard } from "@/contracts";
import { renderVivicSpec } from "./vivicGUILibrary";
import { CARD_INNER_HEIGHT } from "./metrics";

/** Minimal search result: title + one-sentence summary + source label. */
export const SearchResultCardView = ({ card }: { card: SearchResultCard }) => {
  const source = card.sources[0];
  return <div className="vivic-search-content flex min-w-0 flex-col" style={{ height: Math.max(80, card.layout.height - CARD_INNER_HEIGHT) }}>
  <div className="min-h-0 flex-1 overflow-hidden">
  {renderVivicSpec({
    _type: "Col",
    gap: 2,
    children: [
      { _type: "Text", value: card.displayProps.title, weight: "semibold" },
      {
        _type: "Text",
        value: card.displayProps.summary,
        color: "secondary",
        size: "md",
      },
    ],
  })}
  </div>
  {source?.url ? <a href={source.url} target="_blank" rel="noopener noreferrer" className="mt-2 block shrink-0 truncate text-xs text-neutral-500 underline-offset-2 hover:underline" data-vivic-source-link>
    {renderVivicSpec({ _type: "Caption", value: card.displayProps.sourceLabel })}
  </a> : renderVivicSpec({ _type: "Caption", value: card.displayProps.sourceLabel })}
  </div>;
};
