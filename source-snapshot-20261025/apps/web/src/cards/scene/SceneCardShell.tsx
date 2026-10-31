import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import type { CardRecord } from "@/contracts";
import { SCENE_CARD_KICKERS } from "./sceneMeta";
import { useCardMode } from "./cardContext";
import "./sceneCards.css";
import { HarkIcon } from "@/components/hark/HarkPrimitives";

export type BadgeTone = "accent" | "positive" | "caution" | "danger" | "neutral";

// D semantic mapping to retained source glyphs. Weather, chart types and other
// domain symbols without a source equivalent retain the existing Lucide assets.
const HARK_SCENE_GLYPHS: Partial<Record<CardRecord["type"], string>> = {
  TravelOffersCard: "search", ExtensionCard: "apps", TodoCard: "list", NoteCard: "file", FileCard: "file",
  SearchResultCard: "research", PaperCard: "file", GalleryCard: "photos", WeeklyScheduleCard: "calendar",
  NewsCard: "file", TimelineCard: "schedule", StoryCarouselCard: "photos", ActivityFeedCard: "list",
  BookCard: "file", MonthCalendarCard: "calendar", LinkPreviewCard: "link", PhotoCoverCard: "photo", NotificationCard: "alert",
};

interface ShellProps {
  card: CardRecord;
  /** Display: the exact inner height the canvas reserved; omitted on the user page. */
  height?: number;
  title?: ReactNode;
  meta?: ReactNode;
  badge?: ReactNode;
  badgeTone?: BadgeTone;
  icon?: LucideIcon;
  /** Exact source glyph, when this family has a matching Hark icon. */
  harkIcon?: string;
  kicker?: string;
  footer?: ReactNode;
  /** Edge-to-edge media cards draw over the card padding. */
  bleed?: boolean;
  /** Hide the standard header entirely (cover-style cards draw their own). */
  bare?: boolean;
  className?: string;
  children?: ReactNode;
}

/** Unified header/body/footer rhythm for every scene card. */
export function SceneCardShell({ card, height, title, meta, badge, badgeTone = "accent", icon, harkIcon, kicker, footer, bleed, bare, className, children }: ShellProps) {
  const mode = useCardMode();
  const fallback = SCENE_CARD_KICKERS[card.type];
  const Icon = icon ?? fallback.icon;
  const glyph = harkIcon ?? HARK_SCENE_GLYPHS[card.type];
  const fixedHeight = height === undefined ? undefined : Math.max(40, bleed ? height + 40 : height);
  return <section
    className={`vivic-scene${className ? ` ${className}` : ""}`}
    data-scene-card={card.type}
    data-mode={mode}
    data-fixed={fixedHeight !== undefined || undefined}
    data-bleed={bleed || undefined}
    style={fixedHeight !== undefined ? { height: fixedHeight } : undefined}
  >
    {!bare && <header className="vivic-scene-head">
      <div className="vivic-scene-heading">
        <span className="vivic-scene-mark" title={kicker ?? fallback.label}>{glyph ? <HarkIcon name={glyph} size={16} aria-hidden /> : <Icon size={15} strokeWidth={1.75} aria-hidden />}</span>
        {title ? <><h3 className="vivic-scene-title">{title}</h3><span className="sr-only vivic-scene-kind">{kicker ?? fallback.label}</span></>
          : <span className="vivic-scene-kicker">{kicker ?? fallback.label}</span>}
      </div>
      {badge !== undefined && badge !== null && badge !== false && <span className="vivic-scene-badge" data-tone={badgeTone} title={typeof badge === "string" ? badge : undefined}>{badge}</span>}
    </header>}
    {!bare && meta && <p className="vivic-scene-meta">{meta}</p>}
    <div className="vivic-scene-body">{children}</div>
    {footer && <footer className="vivic-scene-foot">{footer}</footer>}
  </section>;
}

/** Shared empty state; on the user page it can carry the action that fills it. */
export function SceneEmpty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return <div className="vivic-scene-empty" data-scene-empty><span>{children}</span>{action}</div>;
}
