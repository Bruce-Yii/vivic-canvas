import type { ReactNode } from "react";
import type { NewsCard } from "@/contracts";
import { SceneCardShell, type BadgeTone } from "../SceneCardShell";
import { formatFullDate, formatMonthDay, todayIn } from "../dates";
import { MediaImage } from "../MediaImage";
import { SCENE_CARD_KICKERS } from "../sceneMeta";
import { DetailField, DetailPopover, SceneLink, hostnameOf, rowsThatFit, useFitHeight } from "../DetailPopover";
import type { CardViewProps } from "../types";
import "./NewsCardView.css";

// Display line boxes (px), mirrored in NewsCardView.css.
const LINE = 20;
const POINTS_LABEL = 20;
const DISPLAY_POINTS = 2;
const COVER_SHARE = 0.32;
// Display heights (px): a cover needs room for the headline, and the meta line goes before the title is squeezed.
const COVER_MIN = 220;
const META_MIN = 160;

const SUMMARY_BY: Record<NonNullable<NewsCard["displayProps"]["summaryBy"]>, { badge?: string; tone: BadgeTone; label: string }> = {
  ai: { badge: "AI 摘要", tone: "accent", label: "AI 摘要" },
  source: { badge: "原文摘录", tone: "neutral", label: "原文摘录" },
  user: { tone: "neutral", label: "摘要" },
};

/** Same year: "10月16日"; otherwise the full date so old news never looks current. */
const formatNewsDay = (iso: string): string => iso.slice(0, 4) === todayIn().slice(0, 4) ? formatMonthDay(iso) : formatFullDate(iso, false);

const formatFetched = (iso: string): string => {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return `${sameYear ? "" : `${date.getFullYear()}年`}${date.getMonth() + 1}月${date.getDate()}日`;
};

export function NewsCardView({ card, height }: CardViewProps<"NewsCard">) {
  const { headline, source, publishedAt, summary, url, image, summaryBy } = card.displayProps;
  const points = card.displayProps.keyPoints ?? [];
  const sources = card.sources ?? [];
  const fixed = height !== undefined;
  const cover = Boolean(image) && (!fixed || height >= COVER_MIN);
  const [boxRef, boxHeight] = useFitHeight<HTMLDivElement>(fixed);
  const [pointsRef, pointsHeight] = useFitHeight<HTMLDivElement>(fixed && points.length > 0);

  const by = summaryBy ? SUMMARY_BY[summaryBy] : undefined;
  const meta = [source, publishedAt ? formatNewsDay(publishedAt) : ""].filter(Boolean).join(" · ");
  const metaNode = meta && (!fixed || height >= META_MIN) ? (fixed ? <span className="block truncate" title={meta}>{meta}</span> : meta) : undefined;
  const summaryLines = fixed ? rowsThatFit(boxHeight, LINE, cover ? 3 : 4) : 8;
  const pointRows = fixed ? rowsThatFit(pointsHeight, LINE, Math.min(DISPLAY_POINTS, points.length), POINTS_LABEL) : points.length;

  const body = <div ref={boxRef} className="vivic-news" data-news-summary-by={summaryBy}>
    {summaryLines > 0 && <p className="vivic-news-summary" style={{ WebkitLineClamp: summaryLines }} data-news-summary>{summary}</p>}
    {points.length > 0 && <div ref={pointsRef} className="vivic-news-points" data-news-points={pointRows}>
      {pointRows > 0 && <>
        <span className="vivic-news-points-label">要点{points.length > pointRows && <span className="font-medium tracking-normal" data-news-points-more>+{points.length - pointRows}</span>}</span>
        <ul>{points.slice(0, pointRows).map((point, index) => <li key={index} title={fixed ? point : undefined}>{point}</li>)}</ul>
      </>}
    </div>}
  </div>;

  const footer: ReactNode = <>
    {url ? <SceneLink href={url} label="阅读原文（新窗口打开）">阅读原文</SceneLink> : <span className="vivic-scene-muted" data-news-no-link>未附原文链接</span>}
    <DetailPopover heading={headline} triggerLabel="查看资讯详情">
      {meta && <DetailField label="来源">{[source, publishedAt ? formatFullDate(publishedAt) : ""].filter(Boolean).join(" · ")}</DetailField>}
      <DetailField label={by?.label ?? "摘要"}><p className="m-0 whitespace-pre-line">{summary}</p></DetailField>
      {points.length > 0 && <DetailField label={`要点 · ${points.length} 条`}>
        <ul className="m-0 grid list-disc gap-1 pl-4 marker:text-[var(--vivic-accent-2)]">{points.map((point, index) => <li key={index}>{point}</li>)}</ul>
      </DetailField>}
      {url && <DetailField label="原文"><SceneLink href={url}>{hostnameOf(url)}</SceneLink></DetailField>}
      {sources.length > 0 && <DetailField label={`引用来源 · ${sources.length}`}>
        <ul className="m-0 grid list-none gap-2 p-0" data-news-sources>{sources.map((item, index) => <li key={index} className="grid min-w-0 gap-0.5">
          {item.url ? <SceneLink href={item.url}>{item.title.trim() || hostnameOf(item.url)}</SceneLink> : <span>{item.title}</span>}
          <span className="vivic-scene-muted text-[11.5px]">
            {[item.url ? hostnameOf(item.url) : "服务来源", formatFetched(item.fetchedAt), item.readFullPage ? "已读全文" : "仅摘要"].filter(Boolean).join(" · ")}
          </span>
        </li>)}</ul>
      </DetailField>}
    </DetailPopover>
  </>;

  if (!cover) {
    return <SceneCardShell card={card} height={height} title={headline} badge={by?.badge} badgeTone={by?.tone}
      meta={metaNode} footer={footer}>{body}</SceneCardShell>;
  }

  const Kicker = SCENE_CARD_KICKERS.NewsCard.icon;
  return <SceneCardShell card={card} height={height} bare bleed>
    <div className="vivic-news-layout" data-news-cover>
      <div className="vivic-news-cover" style={fixed ? { height: Math.round((height + 40) * COVER_SHARE) } : undefined}>
        <MediaImage src={image} alt="" />
      </div>
      <div className="vivic-news-content">
        <header className="vivic-scene-head">
          <span className="vivic-scene-kicker"><Kicker size={13} strokeWidth={2.2} aria-hidden />{SCENE_CARD_KICKERS.NewsCard.label}</span>
          {by?.badge && <span className="vivic-scene-badge" data-tone={by.tone}>{by.badge}</span>}
        </header>
        <h3 className="vivic-scene-title">{headline}</h3>
        {metaNode && <p className="vivic-scene-meta">{metaNode}</p>}
        {body}
        <footer className="vivic-scene-foot">{footer}</footer>
      </div>
    </div>
  </SceneCardShell>;
}
