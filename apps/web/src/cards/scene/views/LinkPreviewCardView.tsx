import { SceneCardShell } from "../SceneCardShell";
import { useCardEditor } from "../cardContext";
import { MediaImage } from "../MediaImage";
import { SCENE_CARD_KICKERS } from "../sceneMeta";
import { CopyButton, SceneLink, hostnameOf, rowsThatFit, useFitHeight } from "../DetailPopover";
import type { CardViewProps } from "../types";
import "./LinkPreviewCardView.css";

// Display line boxes (px), mirrored in LinkPreviewCardView.css.
const DESC_LINE = 19;
const TAG_ROW = 24;
const GAP = 6;
const DISPLAY_TAGS = 4;
// Display heights (px): full tile, a compact strip, or no tile, so the title is never squeezed.
const TILE_FULL = 170;
const TILE_COMPACT = 110;

function Monogram({ name, host }: { name: string; host: string }) {
  const letter = Array.from(name.trim())[0]?.toUpperCase() ?? "#";
  return <div className="vivic-link-mono" aria-hidden data-link-monogram={letter}>
    <div className="vivic-link-mono-row">
      <span className="vivic-link-mono-letter">{letter}</span>
      <span className="vivic-link-mono-host">{host}</span>
    </div>
  </div>;
}

export function LinkPreviewCardView({ card, height }: CardViewProps<"LinkPreviewCard">) {
  const { url, title, siteName, description, image } = card.displayProps;
  const tags = card.displayProps.tags ?? [];
  const editor = useCardEditor(card);
  const fixed = height !== undefined;
  const host = hostnameOf(url);
  const [fitRef, fitHeight] = useFitHeight<HTMLDivElement>(fixed);
  const [descRef, descHeight] = useFitHeight<HTMLParagraphElement>(fixed && Boolean(description));
  const notFetched = (!title && !description) || card.sourceData?.fetched === false;
  const site = siteName && siteName.toLowerCase() !== host.toLowerCase() ? siteName : undefined;
  // The monogram already shows the host, so the meta line only repeats it next to a real image.
  const meta = (image ? [site, host] : [site]).filter(Boolean).join(" · ");

  const descLines = description ? (fixed ? rowsThatFit(fitHeight, DESC_LINE, 3) : undefined) : 0;
  // Tags fit under the description as it is actually laid out (often shorter than its cap).
  const descSpace = descLines ? (descHeight ?? descLines * DESC_LINE) + GAP : 0;
  const showTags = tags.length > 0 && (!fixed || fitHeight === null || fitHeight - descSpace >= TAG_ROW);
  const shownTags = fixed && tags.length > DISPLAY_TAGS ? tags.slice(0, DISPLAY_TAGS - 1) : tags;
  const tile = !fixed || height >= TILE_FULL ? "full" : height >= TILE_COMPACT ? "compact" : "none";
  const Kicker = SCENE_CARD_KICKERS.LinkPreviewCard.icon;
  const monogram = <Monogram name={siteName ?? host} host={host} />;

  return <SceneCardShell card={card} height={height} bare bleed>
    <div className="vivic-link" data-link-fetched={!notFetched}>
      {tile !== "none" && <div className="vivic-link-tile" data-link-tile={image ? "image" : "monogram"} data-compact={tile === "compact" || undefined}>
        {image ? <MediaImage src={image} alt="" placeholder={monogram} /> : monogram}
        {tile === "full" && <span className="vivic-link-kicker"><Kicker size={12} strokeWidth={2.2} aria-hidden />{SCENE_CARD_KICKERS.LinkPreviewCard.label}</span>}
      </div>}
      <div className="vivic-link-content">
        <h3 className="vivic-link-title" title={fixed ? title ?? host : undefined} data-link-title>{title ?? host}</h3>
        {meta && <p className="vivic-link-meta" data-link-meta>{meta}</p>}
        <div ref={fitRef} className="vivic-link-fit">
          {description && descLines !== 0 && <p ref={descRef} className="vivic-link-desc" style={descLines ? { WebkitLineClamp: descLines } : undefined} data-link-description>{description}</p>}
          {showTags && <div className="vivic-link-tags" data-link-tags>
            {shownTags.map((tag, index) => <span key={index} className="vivic-scene-chip" title={tag}><span>{tag}</span></span>)}
            {shownTags.length < tags.length && <span className="vivic-scene-chip" data-more>+{tags.length - shownTags.length}</span>}
          </div>}
        </div>
        <footer className="vivic-scene-foot">
          <span className="flex min-w-0 flex-1 items-center gap-2.5">
            <SceneLink href={url} label={`打开链接：${host}`}>打开链接</SceneLink>
            {notFetched && <span className="vivic-link-note" data-link-not-fetched>未读取网页信息，仅保存链接</span>}
          </span>
          {editor.editable && <CopyButton text={url} label="复制链接" ariaLabel="复制这个链接" />}
        </footer>
      </div>
    </div>
  </SceneCardShell>;
}
