import { lazy, type ComponentType } from "react";
import { isDateCountdown, type CardRecord, type CardType } from "@/contracts";
import { CountdownCardView } from "./CountdownCardView";
import { ReminderListView } from "./ReminderListView";
import { TodoCardView } from "./TodoCardView";
import { SearchResultCardView } from "./SearchResultCardView";
import { WeatherCardView } from "./WeatherCardView";
import { TableCardView } from "./TableCardView";
import { NoteCardView } from "./NoteCardView";
import { FileCardView } from "./FileCardView";
import type { CardViewProps } from "./scene/types";
import { CountdownDateView } from "./scene/views/CountdownDateView";
import { PaperCardView } from "./scene/views/PaperCardView";
import { GalleryCardView } from "./scene/views/GalleryCardView";
import { WeeklyScheduleCardView } from "./scene/views/WeeklyScheduleCardView";
import { RoadmapCardView } from "./scene/views/RoadmapCardView";
import { NewsCardView } from "./scene/views/NewsCardView";
import { TimelineCardView } from "./scene/views/TimelineCardView";
import { QuoteCardView } from "./scene/views/QuoteCardView";
import { StoryCarouselCardView } from "./scene/views/StoryCarouselCardView";
import { ActivityFeedCardView } from "./scene/views/ActivityFeedCardView";
import { ProgressRingCardView } from "./scene/views/ProgressRingCardView";
import { HabitHeatmapCardView } from "./scene/views/HabitHeatmapCardView";
import { BookCardView } from "./scene/views/BookCardView";
import { MonthCalendarCardView } from "./scene/views/MonthCalendarCardView";
import { ComparisonCardView } from "./scene/views/ComparisonCardView";
import { LinkPreviewCardView } from "./scene/views/LinkPreviewCardView";
import { PhotoCoverCardView } from "./scene/views/PhotoCoverCardView";
import { NotificationCardView } from "./scene/views/NotificationCardView";

const ChartCardView = lazy(() => import("./ChartCardView").then(module => ({ default: module.ChartCardView })));
const TravelOffersCardView = lazy(() => import("./scene/views/TravelOffersCardView").then(module => ({ default: module.TravelOffersCardView })));
const ExtensionCardView = lazy(() => import("@/extensions/ExtensionCardView").then(module => ({ default: module.ExtensionCardView })));

const itemHighlight = (card: CardRecord, props: CardViewProps) => props.highlight?.cardId === card.id ? props.highlight.itemId : undefined;

/**
 * Card registry: every schema-gated card type has exactly one renderer. The
 * scene registry in @vivic/contracts decides which type a scene uses; this
 * map decides how that type looks. Unknown types never reach React — they are
 * rejected at the contract boundary — and a render error is contained per card.
 */
export const CARD_VIEWS: { [K in CardType]: ComponentType<CardViewProps<K>> } = {
  FileCard: FileCardView,
  TravelOffersCard: TravelOffersCardView,
  ExtensionCard: ExtensionCardView,
  CountdownCard: props => isDateCountdown(props.card) ? <CountdownDateView {...props} />
    : props.card.sourceData.reminderText ? <ReminderListView cards={[props.card]} highlightedId={props.highlight?.cardId} />
    : <CountdownCardView card={props.card} />,
  TodoCard: props => <TodoCardView card={props.card} highlightedItemId={itemHighlight(props.card, props as CardViewProps)} />,
  SearchResultCard: props => <SearchResultCardView card={props.card} />,
  NoteCard: props => <NoteCardView card={props.card} />,
  WeatherCard: props => <WeatherCardView card={props.card} />,
  TableCard: props => <TableCardView card={props.card} highlightedItemId={itemHighlight(props.card, props as CardViewProps)} />,
  ChartCard: props => <ChartCardView card={props.card} />,
  PaperCard: PaperCardView,
  GalleryCard: GalleryCardView,
  WeeklyScheduleCard: WeeklyScheduleCardView,
  RoadmapCard: RoadmapCardView,
  NewsCard: NewsCardView,
  TimelineCard: TimelineCardView,
  QuoteCard: QuoteCardView,
  StoryCarouselCard: StoryCarouselCardView,
  ActivityFeedCard: ActivityFeedCardView,
  ProgressRingCard: ProgressRingCardView,
  HabitHeatmapCard: HabitHeatmapCardView,
  BookCard: BookCardView,
  MonthCalendarCard: MonthCalendarCardView,
  ComparisonCard: ComparisonCardView,
  LinkPreviewCard: LinkPreviewCardView,
  PhotoCoverCard: PhotoCoverCardView,
  NotificationCard: NotificationCardView,
};

export { fixedContentHeight, usesFixedHeight } from "./sizing";
