import { SCENE_CARD_SIZES, type CardRecord, type SceneId } from "@/contracts";
import { addDays, mondayOf, todayIn } from "./dates";

/**
 * SAMPLE data for the Card Playground and tests. Every fixture is labelled
 * "示例" and is never written to a real canvas. Dates are relative to `now`
 * so the date-driven cards always show a meaningful state.
 */
const iso = (time: number) => new Date(time).toISOString();

const shell = (scene: SceneId, id: string, now: number) => ({
  id: `sample-${id}`,
  variant: "standard" as const,
  sources: [],
  layout: { x: 0, y: 0, ...SCENE_CARD_SIZES[scene], pinned: false },
  metadata: { createdAt: iso(now - 3 * 86_400_000), updatedAt: iso(now - 3_600_000) },
  sourceData: { sample: "示例数据" },
});

export function buildSceneFixtures(now: number = Date.now()): Record<SceneId, CardRecord> {
  const today = todayIn(undefined, now);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
  const birthday = addDays(today, 25);
  const monday = mondayOf(today);
  const month = today.slice(0, 7);
  return {
    travel_offers: {
      ...shell("travel_offers", "travel", now), type: "TravelOffersCard",
      displayProps: { query: { kind: "hotel", destination: "杭州", dateText: "下周", nights: 2, budget: 500 },
        items: [{ id: "demo-hotel", kind: "hotel", title: "杭州 · 演示住宿", subtitle: "虚构样例，不代表真实可预订住宿。", price: { amount: 328, currency: "CNY" }, tags: ["模拟数据"] }],
        fetchedAt: iso(now), mode: "demo", status: "ok", selectedIds: [], notes: "" },
      sourceData: { provider: "vivic-demo", tool: "travel.search", requestId: "sample-travel" },
    },
    countdown: {
      ...shell("countdown", "countdown", now), type: "CountdownCard", displayProps: {},
      sourceData: { targetAt: iso(Date.parse(`${birthday}T00:00:00`)), startedAt: iso(now - 5 * 86_400_000), timeZone: zone,
        event: { title: "我的生日", date: birthday, note: "示例：记得提前订蛋糕" } },
    },
    academic_paper: {
      ...shell("academic_paper", "paper", now), type: "PaperCard",
      displayProps: {
        title: "Attention Is All You Need", authors: ["Ashish Vaswani", "Noam Shazeer", "Niki Parmar", "Jakob Uszkoreit"],
        venue: "NeurIPS", year: 2017, doi: "10.48550/arXiv.1706.03762", url: "https://arxiv.org/abs/1706.03762",
        abstract: "示例摘要：提出完全基于注意力机制的 Transformer 架构，摒弃循环与卷积，在机器翻译任务上取得更好效果且训练更快。",
        keyPoints: ["示例：自注意力替代循环结构", "示例：多头注意力捕捉不同子空间", "示例：位置编码保留序列顺序"], tags: ["NLP", "示例"], readStatus: "reading",
      },
    },
    photo_gallery: {
      ...shell("photo_gallery", "gallery", now), type: "GalleryCard",
      displayProps: { title: "示例 · 周末出游", images: [
        { src: "https://images.unsplash.com/photo-1470770841072-f978cf4d019e?w=800&q=75", caption: "示例：湖边小屋" },
        { src: "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?w=800&q=75", caption: "示例：山路" },
        { src: "https://images.unsplash.com/photo-1469474968028-56623f02e42e?w=800&q=75", caption: "示例：日落" },
        { src: "media:sample-missing", caption: "示例：本地照片缺失时的降级" },
      ] },
    },
    weekly_schedule: {
      ...shell("weekly_schedule", "week", now), type: "WeeklyScheduleCard",
      displayProps: { title: "示例 · 本周安排", weekStart: monday, events: [
        { id: "e1", day: 1, start: "09:30", end: "10:00", title: "团队晨会" },
        { id: "e2", day: 2, start: "19:00", title: "游泳", location: "体育馆" },
        { id: "e3", day: 3, start: "14:30", end: "16:00", title: "项目评审" },
        { id: "e4", day: 4, title: "交周报" },
        { id: "e5", day: 5, start: "20:00", title: "看电影" },
        { id: "e6", day: 6, start: "10:00", title: "回家吃饭" },
      ] },
    },
    todo_list: {
      ...shell("todo_list", "todo", now), type: "TodoCard",
      displayProps: { title: "示例 · 今天要完成", items: [
        { id: "item-1", text: "整理会议记录", done: true },
        { id: "item-2", text: "发送报价材料", done: true },
        { id: "item-3", text: "阅读两篇论文", done: false },
        { id: "item-4", text: "复盘项目进度", done: false },
      ] },
    },
    project_roadmap: {
      ...shell("project_roadmap", "roadmap", now), type: "RoadmapCard",
      displayProps: { title: "示例 · 产品上线计划", phases: [
        { id: "p1", name: "调研", period: "第 1 个月", status: "done", milestones: [{ id: "m1", text: "用户访谈 10 人", done: true }, { id: "m2", text: "需求文档", done: true }] },
        { id: "p2", name: "开发", period: "第 2 个月", status: "active", goal: "完成核心功能", milestones: [{ id: "m3", text: "卡片系统", done: true }, { id: "m4", text: "AI 场景识别", done: false }] },
        { id: "p3", name: "发布", period: "第 3 个月", status: "planned", milestones: [{ id: "m5", text: "内测", done: false }, { id: "m6", text: "正式上线", done: false }] },
      ] },
    },
    data_visualization: {
      ...shell("data_visualization", "chart", now), type: "ChartCard",
      displayProps: { title: "示例 · 本周专注时长", chartKind: "line", xLabel: "日期", yLabel: "小时",
        points: [{ x: "周一", y: 3.5 }, { x: "周二", y: 4 }, { x: "周三", y: 2.5 }, { x: "周四", y: 5 }, { x: "周五", y: 4.5 }, { x: "周六", y: 6 }, { x: "周日", y: 3 }] },
    },
    news_summary: {
      ...shell("news_summary", "news", now), type: "NewsCard",
      displayProps: { headline: "示例：城市地铁新线路本周开通", source: "示例日报", publishedAt: addDays(today, -1),
        summary: "示例摘要：新线路连接城东与高铁站，全程 32 分钟，首末班车时间与既有线路一致，开通首周票价八折。",
        keyPoints: ["示例：全程约 32 分钟", "示例：首周票价八折"], url: "https://example.com/news/metro", summaryBy: "ai" },
    },
    historical_timeline: {
      ...shell("historical_timeline", "timeline", now), type: "TimelineCard",
      displayProps: { title: "示例 · 我们认识以来", events: [
        { id: "t1", date: "2019-09", title: "大学开学第一次见面", description: "示例：在图书馆借同一本书" },
        { id: "t2", date: "2021-05-20", title: "第一次一起旅行", description: "示例：去了青岛" },
        { id: "t3", date: "2023", title: "一起搬到上海" },
        { id: "t4", date: "2025-12-31", title: "跨年烟火", description: "示例：在外滩看烟花" },
      ] },
    },
    quote_note: {
      ...shell("quote_note", "quote", now), type: "QuoteCard",
      displayProps: { text: "好的想法，值得被好好看见。", author: "示例作者", source: "示例 · 灵感 #08", tag: "灵感" },
    },
    photo_story: {
      ...shell("photo_story", "story", now), type: "StoryCarouselCard",
      displayProps: { title: "示例 · 一路向山海", slides: [
        { id: "s1", image: "https://images.unsplash.com/photo-1470770841072-f978cf4d019e?w=900&q=75", heading: "出发", text: "示例：清晨六点，背上包出发。" },
        { id: "s2", image: "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?w=900&q=75", heading: "山路", text: "示例：走了三个小时的山路。" },
        { id: "s3", heading: "终点", text: "示例：还没有照片的一页，会显示占位背景。" },
      ] },
    },
    activity_feed: {
      ...shell("activity_feed", "feed", now), type: "ActivityFeedCard",
      displayProps: { title: "示例 · 最近动态", items: [
        { id: "a1", kind: "done", text: "完成了「整理会议记录」", at: iso(now - 4 * 60_000) },
        { id: "a2", kind: "create", text: "新建了周计划卡片", at: iso(now - 50 * 60_000) },
        { id: "a3", kind: "comment", text: "在论文卡片里添加了笔记", at: iso(now - 5 * 3_600_000) },
        { id: "a4", kind: "alert", text: "示例：周报明天截止", time: "昨天 18:00" },
      ] },
    },
    goal_progress: {
      ...shell("goal_progress", "goal", now), type: "ProgressRingCard",
      displayProps: { title: "示例 · 今年读书目标", current: 18, target: 50, unit: "本", deadline: `${today.slice(0, 4)}-12-31`, note: "示例：每月 4 本" },
    },
    habit_tracking: {
      ...shell("habit_tracking", "habit", now), type: "HabitHeatmapCard",
      displayProps: { habit: "示例 · 每天跑步", weeklyGoal: 4,
        checkins: Array.from({ length: 60 }, (_, i) => addDays(today, -i)).filter((_, i) => i < 6 || (i % 3 !== 0 && i % 7 !== 5)) },
    },
    book_record: {
      ...shell("book_record", "book", now), type: "BookCard",
      displayProps: { title: "示例 · 思考，快与慢", author: "丹尼尔·卡尼曼", status: "reading", currentPage: 86, totalPages: 240, rating: 4, notes: ["示例：系统一快而直觉"] },
    },
    monthly_calendar: {
      ...shell("monthly_calendar", "month", now), type: "MonthCalendarCard",
      displayProps: { title: "示例 · 本月安排", month, events: [
        { id: "c1", date: `${month}-05`, title: "交房租" },
        { id: "c2", date: `${month}-12`, title: "体检", time: "08:30" },
        { id: "c3", date: `${month}-12`, title: "复诊" },
        { id: "c4", date: `${month}-20`, title: "妈妈生日" },
        { id: "c5", date: `${month}-28`, title: "考试" },
      ] },
    },
    option_comparison: {
      ...shell("option_comparison", "compare", now), type: "ComparisonCard",
      displayProps: { title: "示例 · 三套租房方案", options: [{ id: "o1", name: "方案 A", note: "离公司近" }, { id: "o2", name: "方案 B" }, { id: "o3", name: "方案 C", note: "最便宜" }],
        criteria: [
          { id: "k1", name: "月租", values: [5200, 4600, 3800], better: "lower", unit: "元" },
          { id: "k2", name: "通勤", values: [15, 30, 50], better: "lower", unit: "分钟" },
          { id: "k3", name: "面积", values: [45, 60, 52], better: "higher", unit: "㎡" },
          { id: "k4", name: "采光", values: ["好", "一般", "好"] },
        ], recommendation: "示例：综合通勤与租金，方案 B 更均衡。", chosenId: "o2" },
    },
    web_bookmark: {
      ...shell("web_bookmark", "link", now), type: "LinkPreviewCard",
      displayProps: { url: "https://github.com/xyflow/xyflow", title: "xyflow — React Flow", siteName: "GitHub", description: "示例：用于构建节点式编辑器和交互图的 React 库。", tags: ["前端", "示例"] },
    },
    photo_memory: {
      ...shell("photo_memory", "cover", now), type: "PhotoCoverCard",
      displayProps: { title: "示例 · 第一次看海", date: addDays(today, -400), caption: "示例：那天风很大，但很开心。",
        image: { src: "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=1000&q=75", alt: "示例海边照片" } },
    },
    single_notification: {
      ...shell("single_notification", "notice", now), type: "NotificationCard",
      displayProps: { title: "示例：快递已到驿站", body: "示例：取件码 8-2-3017，今晚 21:00 前可取。", level: "success", at: iso(now - 12 * 60_000), status: "unread", source: "示例" },
    },
  } as Record<SceneId, CardRecord>;
}

/** Stress fixtures: very long text, empty collections and extreme values must still render. */
export function buildEdgeFixtures(now: number = Date.now()): Array<{ label: string; card: CardRecord }> {
  const base = buildSceneFixtures(now);
  const long = (n: number) => "超长文本示例".repeat(Math.ceil(n / 6)).slice(0, n);
  const today = todayIn(undefined, now);
  return [
    { label: "长标题文献", card: { ...base.academic_paper, id: "edge-paper", displayProps: { title: long(240), authors: Array.from({ length: 20 }, (_, i) => `作者${i + 1}`), abstract: long(2000) } } as CardRecord },
    { label: "空照片墙", card: { ...base.photo_gallery, id: "edge-gallery", displayProps: { title: "还没有照片", images: [] } } as CardRecord },
    { label: "空周计划", card: { ...base.weekly_schedule, id: "edge-week", displayProps: { title: "空的一周", weekStart: mondayOf(today), events: [] } } as CardRecord },
    { label: "超额进度", card: { ...base.goal_progress, id: "edge-goal", displayProps: { title: long(60), current: 1e9, target: 3 } } as CardRecord },
    { label: "过去的倒计时", card: { ...base.countdown, id: "edge-countdown", sourceData: { ...(base.countdown as Extract<CardRecord, { type: "CountdownCard" }>).sourceData,
      targetAt: new Date(now - 40 * 86_400_000).toISOString(), event: { title: "已经过去的纪念日", date: addDays(today, -40) } } } as CardRecord },
    { label: "无打卡记录", card: { ...base.habit_tracking, id: "edge-habit", displayProps: { habit: "冥想", checkins: [] } } as CardRecord },
    { label: "空月历", card: { ...base.monthly_calendar, id: "edge-month", displayProps: { month: "2030-02", events: [] } } as CardRecord },
    { label: "缺少图片的封面", card: { ...base.photo_memory, id: "edge-cover", displayProps: { title: "还没选照片", caption: long(200) } } as CardRecord },
    { label: "坏链接图片", card: { ...base.photo_memory, id: "edge-cover-broken", displayProps: { title: "图片加载失败", image: { src: "https://invalid.example/not-found.jpg" } } } as CardRecord },
    { label: "长通知", card: { ...base.single_notification, id: "edge-notice", displayProps: { title: long(80), body: long(300), level: "error" } } as CardRecord },
    { label: "空动态（实时画布）", card: { ...base.activity_feed, id: "edge-feed", displayProps: { title: "画布动态", live: "canvas", items: [] } } as CardRecord },
  ];
}
