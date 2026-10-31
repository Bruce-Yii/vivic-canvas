import { z } from "zod";
import { CommonShape, OpenSourceData } from "./cardCommon";

/**
 * Closed display data for the scene cards. Every string and list is bounded;
 * images are either an https URL the user supplied or a local `media:` blob
 * stored by the user page. Nothing here can carry markup, code or a component.
 */
const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => text(max).optional();
const itemId = z.string().min(1).max(64);

export const IsoDateSchema = z.iso.date();
export const ClockTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
/** Year, year-month or full date, so history can be as precise as the user was. */
export const PartialDateSchema = z.string().regex(/^\d{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?)?$/);
export const MonthSchema = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/);
export const HttpsUrlSchema = z.string().max(2048).regex(/^https:\/\/[^\s<>"']+$/);
export const MediaRefSchema = z.string().max(2048).regex(/^(?:media:[A-Za-z0-9_-]{1,80}|https:\/\/[^\s<>"']+)$/);
export const ImageSchema = z.strictObject({
  src: MediaRefSchema,
  alt: optionalText(120),
  caption: optionalText(160),
  width: z.int().positive().max(20000).optional(),
  height: z.int().positive().max(20000).optional(),
});
const uniqueIds = <T extends { id: string }>(items: T[]) => new Set(items.map(item => item.id)).size === items.length;

export const PaperCardSchema = z.strictObject({
  ...CommonShape,
  type: z.literal("PaperCard"),
  displayProps: z.strictObject({
    title: text(240),
    authors: z.array(text(80)).max(20).optional(),
    venue: optionalText(160),
    year: z.int().min(1000).max(2200).optional(),
    abstract: optionalText(2000),
    keyPoints: z.array(text(200)).max(6).optional(),
    doi: z.string().max(200).regex(/^10\.\d{4,9}\/\S+$/).optional(),
    url: HttpsUrlSchema.optional(),
    tags: z.array(text(24)).max(6).optional(),
    readStatus: z.enum(["unread", "reading", "read"]).optional(),
  }),
  sourceData: OpenSourceData,
});

export const GalleryCardSchema = z.strictObject({
  ...CommonShape,
  type: z.literal("GalleryCard"),
  displayProps: z.strictObject({
    title: text(80),
    images: z.array(ImageSchema).max(36),
  }),
  sourceData: OpenSourceData,
});

export const ScheduleEventSchema = z.strictObject({
  id: itemId,
  day: z.int().min(1).max(7),
  start: ClockTimeSchema.optional(),
  end: ClockTimeSchema.optional(),
  title: text(80),
  location: optionalText(60),
  done: z.boolean().optional(),
}).refine(event => !event.end || (event.start !== undefined && event.end > event.start), "结束时间必须晚于开始时间");

export const WeeklyScheduleCardSchema = z.strictObject({
  ...CommonShape,
  type: z.literal("WeeklyScheduleCard"),
  displayProps: z.strictObject({
    title: text(80),
    /** Monday of the shown week, so weekday events resolve to real dates. */
    weekStart: IsoDateSchema.refine(date => new Date(`${date}T00:00:00Z`).getUTCDay() === 1, "weekStart 必须是周一"),
    events: z.array(ScheduleEventSchema).max(60).refine(uniqueIds),
  }),
  sourceData: OpenSourceData,
});

export const RoadmapPhaseSchema = z.strictObject({
  id: itemId,
  name: text(60),
  period: optionalText(40),
  status: z.enum(["done", "active", "planned"]),
  goal: optionalText(160),
  milestones: z.array(z.strictObject({ id: itemId, text: text(120), done: z.boolean() })).max(10).refine(uniqueIds),
});

export const RoadmapCardSchema = z.strictObject({
  ...CommonShape,
  type: z.literal("RoadmapCard"),
  displayProps: z.strictObject({
    title: text(80),
    phases: z.array(RoadmapPhaseSchema).min(1).max(8).refine(uniqueIds),
  }),
  sourceData: OpenSourceData,
});

export const NewsCardSchema = z.strictObject({
  ...CommonShape,
  type: z.literal("NewsCard"),
  displayProps: z.strictObject({
    headline: text(200),
    source: optionalText(80),
    publishedAt: IsoDateSchema.optional(),
    summary: text(800),
    keyPoints: z.array(text(200)).max(5).optional(),
    url: HttpsUrlSchema.optional(),
    image: MediaRefSchema.optional(),
    /** Who wrote the summary: the assistant, the source page, or the user. */
    summaryBy: z.enum(["ai", "source", "user"]).optional(),
  }),
  sourceData: OpenSourceData,
});

export const TimelineCardSchema = z.strictObject({
  ...CommonShape,
  type: z.literal("TimelineCard"),
  displayProps: z.strictObject({
    title: text(80),
    order: z.enum(["asc", "desc"]).optional(),
    events: z.array(z.strictObject({
      id: itemId,
      date: PartialDateSchema,
      title: text(100),
      description: optionalText(300),
    })).min(1).max(40).refine(uniqueIds),
  }),
  sourceData: OpenSourceData,
});

export const QuoteCardSchema = z.strictObject({
  ...CommonShape,
  type: z.literal("QuoteCard"),
  displayProps: z.strictObject({
    text: text(400),
    author: optionalText(60),
    source: optionalText(100),
    tag: optionalText(24),
  }),
  sourceData: OpenSourceData,
});

export const StoryCarouselCardSchema = z.strictObject({
  ...CommonShape,
  type: z.literal("StoryCarouselCard"),
  displayProps: z.strictObject({
    title: text(80),
    slides: z.array(z.strictObject({
      id: itemId,
      image: MediaRefSchema.optional(),
      heading: optionalText(60),
      text: text(300),
    })).min(1).max(15).refine(uniqueIds),
  }),
  sourceData: OpenSourceData,
});

export const ActivityKindSchema = z.enum(["done", "update", "create", "comment", "alert", "event"]);
export const ActivityFeedCardSchema = z.strictObject({
  ...CommonShape,
  type: z.literal("ActivityFeedCard"),
  displayProps: z.strictObject({
    title: text(80),
    /** "canvas": the feed is derived live from this canvas's own card history. */
    live: z.literal("canvas").optional(),
    items: z.array(z.strictObject({
      id: itemId,
      kind: ActivityKindSchema,
      text: text(160),
      at: z.iso.datetime().optional(),
      time: optionalText(32),
    })).max(50).refine(uniqueIds),
  }),
  sourceData: OpenSourceData,
});

export const ProgressRingCardSchema = z.strictObject({
  ...CommonShape,
  type: z.literal("ProgressRingCard"),
  displayProps: z.strictObject({
    title: text(60),
    current: z.number().finite().min(0).max(1e12),
    target: z.number().finite().positive().max(1e12),
    unit: optionalText(16),
    deadline: IsoDateSchema.optional(),
    note: optionalText(120),
  }),
  sourceData: OpenSourceData,
});

export const HabitHeatmapCardSchema = z.strictObject({
  ...CommonShape,
  type: z.literal("HabitHeatmapCard"),
  displayProps: z.strictObject({
    habit: text(60),
    checkins: z.array(IsoDateSchema).max(800).refine(days => new Set(days).size === days.length, "打卡日期不能重复"),
    weeklyGoal: z.int().min(1).max(7).optional(),
    startDate: IsoDateSchema.optional(),
  }),
  sourceData: OpenSourceData,
});

export const BookCardSchema = z.strictObject({
  ...CommonShape,
  type: z.literal("BookCard"),
  displayProps: z.strictObject({
    title: text(160),
    author: optionalText(80),
    status: z.enum(["want", "reading", "paused", "finished"]),
    currentPage: z.int().min(0).max(100000).optional(),
    totalPages: z.int().min(1).max(100000).optional(),
    rating: z.int().min(1).max(5).optional(),
    cover: MediaRefSchema.optional(),
    notes: z.array(text(200)).max(8).optional(),
  }).refine(book => book.currentPage === undefined || book.totalPages === undefined || book.currentPage <= book.totalPages, "当前页不能超过总页数"),
  sourceData: OpenSourceData,
});

export const MonthCalendarCardSchema = z.strictObject({
  ...CommonShape,
  type: z.literal("MonthCalendarCard"),
  displayProps: z.strictObject({
    title: optionalText(60),
    month: MonthSchema,
    events: z.array(z.strictObject({ id: itemId, date: IsoDateSchema, title: text(60), time: ClockTimeSchema.optional() })).max(80).refine(uniqueIds),
  }),
  sourceData: OpenSourceData,
});

export const ComparisonValueSchema = z.union([z.string().max(80), z.number().finite(), z.null()]);
export const ComparisonCardSchema = z.strictObject({
  ...CommonShape,
  type: z.literal("ComparisonCard"),
  displayProps: z.strictObject({
    title: text(80),
    options: z.array(z.strictObject({ id: itemId, name: text(40), note: optionalText(120) })).min(2).max(5).refine(uniqueIds),
    criteria: z.array(z.strictObject({
      id: itemId,
      name: text(40),
      values: z.array(ComparisonValueSchema).min(2).max(5),
      better: z.enum(["higher", "lower"]).optional(),
      unit: optionalText(12),
    })).min(1).max(12).refine(uniqueIds),
    recommendation: optionalText(200),
    chosenId: itemId.optional(),
  }).refine(card => card.criteria.every(row => row.values.length === card.options.length), "每个指标的取值数量必须与方案数量一致")
    .refine(card => card.chosenId === undefined || card.options.some(option => option.id === card.chosenId), "选中的方案不存在"),
  sourceData: OpenSourceData,
});

export const LinkPreviewCardSchema = z.strictObject({
  ...CommonShape,
  type: z.literal("LinkPreviewCard"),
  displayProps: z.strictObject({
    url: HttpsUrlSchema,
    title: optionalText(200),
    siteName: optionalText(80),
    description: optionalText(400),
    tags: z.array(text(24)).max(6).optional(),
    image: MediaRefSchema.optional(),
  }),
  sourceData: OpenSourceData,
});

export const PhotoCoverCardSchema = z.strictObject({
  ...CommonShape,
  type: z.literal("PhotoCoverCard"),
  displayProps: z.strictObject({
    title: text(80),
    date: IsoDateSchema.optional(),
    caption: optionalText(200),
    image: ImageSchema.optional(),
  }),
  sourceData: OpenSourceData,
});

export const NotificationCardSchema = z.strictObject({
  ...CommonShape,
  type: z.literal("NotificationCard"),
  displayProps: z.strictObject({
    title: text(80),
    body: optionalText(300),
    level: z.enum(["info", "success", "warning", "error"]),
    at: z.iso.datetime().optional(),
    status: z.enum(["unread", "read", "done"]).optional(),
    source: optionalText(40),
  }),
  sourceData: OpenSourceData,
});

export const SCENE_CARD_SCHEMAS = [
  PaperCardSchema,
  GalleryCardSchema,
  WeeklyScheduleCardSchema,
  RoadmapCardSchema,
  NewsCardSchema,
  TimelineCardSchema,
  QuoteCardSchema,
  StoryCarouselCardSchema,
  ActivityFeedCardSchema,
  ProgressRingCardSchema,
  HabitHeatmapCardSchema,
  BookCardSchema,
  MonthCalendarCardSchema,
  ComparisonCardSchema,
  LinkPreviewCardSchema,
  PhotoCoverCardSchema,
  NotificationCardSchema,
] as const;

export type PaperCard = z.infer<typeof PaperCardSchema>;
export type GalleryCard = z.infer<typeof GalleryCardSchema>;
export type WeeklyScheduleCard = z.infer<typeof WeeklyScheduleCardSchema>;
export type RoadmapCard = z.infer<typeof RoadmapCardSchema>;
export type NewsCard = z.infer<typeof NewsCardSchema>;
export type TimelineCard = z.infer<typeof TimelineCardSchema>;
export type QuoteCard = z.infer<typeof QuoteCardSchema>;
export type StoryCarouselCard = z.infer<typeof StoryCarouselCardSchema>;
export type ActivityFeedCard = z.infer<typeof ActivityFeedCardSchema>;
export type ProgressRingCard = z.infer<typeof ProgressRingCardSchema>;
export type HabitHeatmapCard = z.infer<typeof HabitHeatmapCardSchema>;
export type BookCard = z.infer<typeof BookCardSchema>;
export type MonthCalendarCard = z.infer<typeof MonthCalendarCardSchema>;
export type ComparisonCard = z.infer<typeof ComparisonCardSchema>;
export type LinkPreviewCard = z.infer<typeof LinkPreviewCardSchema>;
export type PhotoCoverCard = z.infer<typeof PhotoCoverCardSchema>;
export type NotificationCard = z.infer<typeof NotificationCardSchema>;
export type SceneImage = z.infer<typeof ImageSchema>;
