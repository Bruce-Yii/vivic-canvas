import { z } from "zod";
import { isDateCountdown, type CardRecord, type CardType } from "./cardRecord";

/**
 * Scene registry: the single source of truth for "which card shows this".
 * Every scene_id maps to exactly one card_type and every card_type below is
 * claimed by exactly one scene, so a scene can never randomly switch cards.
 * Weather, Note, Table and SearchResult keep their existing, non-scene paths.
 */
export const SCENES = [
  { id: "travel_offers", cardType: "TravelOffersCard", label: "旅游查询结果", group: "travel" },
  { id: "countdown", cardType: "CountdownCard", label: "重要日期倒计时", group: "time" },
  { id: "academic_paper", cardType: "PaperCard", label: "学术文献整理", group: "knowledge" },
  { id: "photo_gallery", cardType: "GalleryCard", label: "多张照片展示", group: "visual" },
  { id: "weekly_schedule", cardType: "WeeklyScheduleCard", label: "周计划及短期日程", group: "time" },
  { id: "todo_list", cardType: "TodoCard", label: "待办任务", group: "plan" },
  { id: "project_roadmap", cardType: "RoadmapCard", label: "长期项目规划", group: "plan" },
  { id: "data_visualization", cardType: "ChartCard", label: "数据趋势与统计", group: "record" },
  { id: "news_summary", cardType: "NewsCard", label: "新闻资讯摘要", group: "knowledge" },
  { id: "historical_timeline", cardType: "TimelineCard", label: "历史事件回顾", group: "record" },
  { id: "quote_note", cardType: "QuoteCard", label: "金句与灵感记录", group: "knowledge" },
  { id: "photo_story", cardType: "StoryCarouselCard", label: "多张照片叙事", group: "visual" },
  { id: "activity_feed", cardType: "ActivityFeedCard", label: "连续活动动态", group: "record" },
  { id: "goal_progress", cardType: "ProgressRingCard", label: "单项目标进度", group: "plan" },
  { id: "habit_tracking", cardType: "HabitHeatmapCard", label: "习惯打卡", group: "plan" },
  { id: "book_record", cardType: "BookCard", label: "单本书籍记录", group: "knowledge" },
  { id: "monthly_calendar", cardType: "MonthCalendarCard", label: "月度日期安排", group: "time" },
  { id: "option_comparison", cardType: "ComparisonCard", label: "多方案比较", group: "record" },
  { id: "web_bookmark", cardType: "LinkPreviewCard", label: "网页和资源收藏", group: "knowledge" },
  { id: "photo_memory", cardType: "PhotoCoverCard", label: "单张照片纪念", group: "visual" },
  { id: "single_notification", cardType: "NotificationCard", label: "单条通知或提醒", group: "record" },
] as const satisfies ReadonlyArray<{ id: string; cardType: CardType; label: string; group: string }>;

export type SceneDefinition = (typeof SCENES)[number];
export type SceneId = SceneDefinition["id"];
export type SceneCardType = SceneDefinition["cardType"];
export const SCENE_IDS = SCENES.map(scene => scene.id) as [SceneId, ...SceneId[]];
export const SceneIdSchema = z.enum(SCENE_IDS);

export const SCENE_BY_ID = Object.fromEntries(SCENES.map(scene => [scene.id, scene])) as { [K in SceneId]: Extract<SceneDefinition, { id: K }> };
export const SCENE_CARD_TYPE = Object.fromEntries(SCENES.map(scene => [scene.id, scene.cardType])) as { [K in SceneId]: Extract<SceneDefinition, { id: K }>["cardType"] };
export const SCENE_OF_CARD_TYPE = Object.fromEntries(SCENES.map(scene => [scene.cardType, scene.id])) as Record<SceneCardType, SceneId>;

/** Default canvas footprint per scene. Scene cards render at exactly this height on Display. */
export const SCENE_CARD_SIZES: { [K in SceneId]: { width: number; height: number } } = {
  travel_offers: { width: 400, height: 360 },
  countdown: { width: 300, height: 200 },
  academic_paper: { width: 380, height: 300 },
  photo_gallery: { width: 420, height: 340 },
  weekly_schedule: { width: 600, height: 320 },
  todo_list: { width: 320, height: 200 },
  project_roadmap: { width: 600, height: 320 },
  data_visualization: { width: 420, height: 300 },
  news_summary: { width: 380, height: 340 },
  historical_timeline: { width: 360, height: 380 },
  quote_note: { width: 320, height: 220 },
  photo_story: { width: 440, height: 340 },
  activity_feed: { width: 340, height: 340 },
  goal_progress: { width: 280, height: 300 },
  habit_tracking: { width: 400, height: 260 },
  book_record: { width: 380, height: 240 },
  monthly_calendar: { width: 360, height: 380 },
  option_comparison: { width: 560, height: 340 },
  web_bookmark: { width: 340, height: 230 },
  photo_memory: { width: 380, height: 320 },
  single_notification: { width: 340, height: 160 },
};

/** Scene of a stored card. A plain timer/reminder CountdownCard is not a scene card. */
export const sceneOfCard = (card: CardRecord): SceneId | null => {
  if (card.type === "CountdownCard") return isDateCountdown(card) ? "countdown" : null;
  return (SCENE_OF_CARD_TYPE as Partial<Record<CardType, SceneId>>)[card.type] ?? null;
};
