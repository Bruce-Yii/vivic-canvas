import type { PaperCard } from "@/contracts";
import { SceneCardShell, type BadgeTone } from "../SceneCardShell";
import { useCardEditor } from "../cardContext";
import { CopyButton, DetailField, DetailPopover, SceneLink, SegmentedControl, hostnameOf, rowsThatFit, useFitHeight } from "../DetailPopover";
import type { CardViewProps } from "../types";
import "./PaperCardView.css";

type Paper = PaperCard["displayProps"];
type ReadStatus = NonNullable<Paper["readStatus"]>;

const READ_STATUS: ReadonlyArray<{ value: ReadStatus; label: string; tone: BadgeTone }> = [
  { value: "unread", label: "未读", tone: "neutral" },
  { value: "reading", label: "在读", tone: "accent" },
  { value: "read", label: "已读", tone: "positive" },
];

// Display line boxes (px), mirrored in PaperCardView.css.
const LINE = 20;
const GAP = 8;
const TAG_ROW = 24;
const POINTS_LABEL = 20;
const DISPLAY_POINTS = 3;
const DISPLAY_TAGS = 4;
const SHORT_VENUE = 18;
// Display heights (px) below which the meta line shrinks to one line, then hides, so the title is never squeezed.
const META_TWO_LINES = 220;
const META_MIN = 160;

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
const joinNames = (names: string[]) => names.join(names.some(name => CJK.test(name)) ? "、" : ", ");
export const authorLine = (authors: string[]): string => authors.length > 3 ? `${joinNames(authors.slice(0, 3))} 等 ${authors.length} 人` : joinNames(authors);

export const doiUrl = (doi: string): string => `https://doi.org/${encodeURI(doi)}`;
const sentence = (text: string) => /[.?!。？！]$/.test(text) ? text : `${text}.`;

/** `Authors (Year). Title. Venue. https://doi.org/DOI` — absent parts are simply left out. */
export function paperCitation(paper: Paper): string {
  const authors = paper.authors?.length ? paper.authors.join(", ") : "";
  const lead = authors ? `${authors}${paper.year ? ` (${paper.year})` : ""}.` : paper.year ? `(${paper.year}).` : "";
  const link = paper.doi ? doiUrl(paper.doi) : paper.url ?? "";
  return [lead, sentence(paper.title), paper.venue ? sentence(paper.venue) : "", link].filter(Boolean).join(" ");
}

export function PaperCardView({ card, height }: CardViewProps<"PaperCard">) {
  const paper = card.displayProps;
  const { title, venue, year, abstract, doi, url, readStatus } = paper;
  const authors = paper.authors ?? [];
  const points = paper.keyPoints ?? [];
  const tags = paper.tags ?? [];
  const editor = useCardEditor(card);
  const fixed = height !== undefined;
  const [boxRef, boxHeight] = useFitHeight<HTMLDivElement>(fixed);
  const [pointsRef, pointsHeight] = useFitHeight<HTMLDivElement>(fixed && points.length > 0);

  // Short venues sit in the badge; a long one moves to the meta line instead of being cut.
  const shortVenue = venue && venue.length <= SHORT_VENUE ? venue : undefined;
  const badge = shortVenue && year ? `${shortVenue} · ${year}` : shortVenue ?? (year ? String(year) : "论文");
  const meta = [authors.length ? authorLine(authors) : "", venue && !shortVenue ? venue : ""].filter(Boolean).join(" · ");
  const status = READ_STATUS.find(item => item.value === readStatus);
  const citation = paperCitation(paper);

  // Display budget: tags pinned at the bottom, abstract first, key points take what is left.
  let showTags = tags.length > 0;
  let abstractLines = abstract ? (fixed ? (points.length ? 3 : 10) : 6) : 0;
  if (fixed && boxHeight !== null) {
    if (showTags && (abstract || points.length) && boxHeight - TAG_ROW - GAP < LINE) showTags = false;
    if (abstract) abstractLines = rowsThatFit(boxHeight - (showTags ? TAG_ROW + GAP : 0), LINE, abstractLines);
  }
  // With no abstract the key points are the body, so a tall card may show all of them.
  const pointCap = abstract ? DISPLAY_POINTS : points.length;
  const pointRows = fixed ? rowsThatFit(pointsHeight, LINE, Math.min(pointCap, points.length), POINTS_LABEL) : points.length;
  const showMeta = Boolean(meta) && (!fixed || height >= META_MIN);
  const metaClass = !fixed || height >= META_TWO_LINES ? "vivic-scene-clamp-2" : "block truncate";
  const shownTags = fixed && tags.length > DISPLAY_TAGS ? tags.slice(0, DISPLAY_TAGS - 1) : tags;

  return <SceneCardShell card={card} height={height} title={title} badge={badge} badgeTone="accent"
    meta={showMeta ? <span className={metaClass} title={fixed ? meta : undefined}>{meta}</span> : undefined}
    footer={<>
      {!editor.editable && status ? <span className="vivic-scene-badge" data-tone={status.tone} data-paper-status={status.value}>{status.label}</span> : <span aria-hidden />}
      <span className="ml-auto flex min-w-0 items-center gap-3">
        {doi && <SceneLink href={doiUrl(doi)} label={`打开 DOI：${doi}`}>DOI</SceneLink>}
        {url && <SceneLink href={url} label="打开原文">原文</SceneLink>}
        <DetailPopover heading={title} triggerLabel="查看文献详情">
          {authors.length > 0 && <DetailField label={`作者 · ${authors.length} 人`}>{joinNames(authors)}</DetailField>}
          {(venue || year) && <DetailField label="发表">{[venue, year].filter(Boolean).join(" · ")}</DetailField>}
          <DetailField label="摘要">{abstract ? <p className="m-0 whitespace-pre-line">{abstract}</p> : <span className="vivic-scene-muted">未附摘要</span>}</DetailField>
          {points.length > 0 && <DetailField label={`要点 · ${points.length} 条`}>
            <ul className="m-0 grid list-disc gap-1 pl-4 marker:text-[var(--vivic-accent)]">{points.map((point, index) => <li key={index}>{point}</li>)}</ul>
          </DetailField>}
          {tags.length > 0 && <DetailField label="标签"><div className="flex flex-wrap gap-1">{tags.map((tag, index) => <span key={index} className="vivic-scene-chip">{tag}</span>)}</div></DetailField>}
          {(doi || url) && <DetailField label="链接"><div className="grid justify-items-start gap-1">
            {doi && <SceneLink href={doiUrl(doi)}>doi.org/{doi}</SceneLink>}
            {url && <SceneLink href={url}>{hostnameOf(url)}</SceneLink>}
          </div></DetailField>}
          <DetailField label="引用"><p className="m-0 rounded-[var(--radius-md)] bg-[var(--vivic-subtle)] px-2.5 py-2 text-[12.5px] leading-relaxed" data-paper-citation>{citation}</p></DetailField>
        </DetailPopover>
      </span>
    </>}>
    <div ref={boxRef} className="vivic-paper" data-paper-read-status={readStatus}>
      {abstract && abstractLines > 0 && <p className="vivic-paper-abstract" style={{ WebkitLineClamp: abstractLines }} data-paper-abstract>{abstract}</p>}
      {points.length > 0 && <div ref={pointsRef} className="vivic-paper-points" data-paper-points={pointRows}>
        {pointRows > 0 && <>
          <span className="vivic-paper-points-label">要点{points.length > pointRows && <span className="font-medium tracking-normal" data-paper-points-more>+{points.length - pointRows}</span>}</span>
          <ul>{points.slice(0, pointRows).map((point, index) => <li key={index} title={fixed ? point : undefined}>{point}</li>)}</ul>
        </>}
      </div>}
      {!abstract && !points.length && <p className="vivic-scene-muted m-0 text-[12.5px]" data-paper-empty>未附摘要与要点</p>}
      {showTags && <div className="vivic-paper-tags" data-paper-tags>
        {shownTags.map((tag, index) => <span key={index} className="vivic-scene-chip" title={tag}><span>{tag}</span></span>)}
        {shownTags.length < tags.length && <span className="vivic-scene-chip" data-more>+{tags.length - shownTags.length}</span>}
      </div>}
      {editor.editable && <div className="nodrag nopan flex flex-wrap items-center gap-2 pt-1" data-paper-tools>
        <SegmentedControl label="阅读状态" value={readStatus} options={READ_STATUS} onChange={value => editor.patch({ readStatus: value })} />
        <CopyButton text={citation} label="复制引用" ariaLabel="复制这篇文献的引用" />
      </div>}
    </div>
  </SceneCardShell>;
}
