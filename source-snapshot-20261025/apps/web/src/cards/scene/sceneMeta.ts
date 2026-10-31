import {
  Activity, Bell, BookMarked, BookOpenText, CalendarDays, CalendarRange, ChartLine, CloudSun, GalleryHorizontalEnd, History, Hourglass, Image,
  Images, Link2, ListChecks, Milestone, Newspaper, Quote, Scale, Search, StickyNote, Table2, Target, Flame, type LucideIcon,
} from "lucide-react";
import type { CardType } from "@/contracts";

/** Kicker (small overline) and icon per card type; the visible card "family name". */
export const SCENE_CARD_KICKERS: Record<CardType, { label: string; icon: LucideIcon }> = {
  FileCard: { label: "文件", icon: BookOpenText },
  TravelOffersCard: { label: "旅游结果", icon: Search },
  ExtensionCard: { label: "扩展卡片", icon: StickyNote },
  CountdownCard: { label: "倒计时", icon: Hourglass },
  TodoCard: { label: "待办", icon: ListChecks },
  WeatherCard: { label: "天气", icon: CloudSun },
  NoteCard: { label: "便笺", icon: StickyNote },
  SearchResultCard: { label: "资料", icon: Search },
  TableCard: { label: "表格", icon: Table2 },
  ChartCard: { label: "数据", icon: ChartLine },
  PaperCard: { label: "文献", icon: BookOpenText },
  GalleryCard: { label: "照片墙", icon: Images },
  WeeklyScheduleCard: { label: "周计划", icon: CalendarRange },
  RoadmapCard: { label: "路线图", icon: Milestone },
  NewsCard: { label: "资讯", icon: Newspaper },
  TimelineCard: { label: "时间线", icon: History },
  QuoteCard: { label: "金句", icon: Quote },
  StoryCarouselCard: { label: "照片故事", icon: GalleryHorizontalEnd },
  ActivityFeedCard: { label: "动态", icon: Activity },
  ProgressRingCard: { label: "目标", icon: Target },
  HabitHeatmapCard: { label: "习惯打卡", icon: Flame },
  BookCard: { label: "阅读", icon: BookMarked },
  MonthCalendarCard: { label: "月历", icon: CalendarDays },
  ComparisonCard: { label: "方案对比", icon: Scale },
  LinkPreviewCard: { label: "收藏", icon: Link2 },
  PhotoCoverCard: { label: "纪念", icon: Image },
  NotificationCard: { label: "通知", icon: Bell },
};
