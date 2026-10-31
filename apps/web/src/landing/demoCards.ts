import { SCENE_CARD_SIZES, type CardRecord, type SceneId } from "@/contracts";
import { addDays, mondayOf, todayIn } from "@/cards/scene/dates";

/**
 * Landing page demo cards. Every card is static sample data rendered by the
 * real card components (the same registry the Display uses); nothing here is
 * written to a canvas or sent anywhere. Each card carries the sentence a user
 * might say to get it, and its numbers/dates come from that sentence.
 */
export interface DemoCard {
  /** What the user says (or types) on the user page. */
  prompt: string;
  card: CardRecord;
}

const iso = (time: number) => new Date(time).toISOString();

const PHOTO = {
  lake: "https://images.unsplash.com/photo-1470770841072-f978cf4d019e?w=900&q=75",
  road: "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?w=900&q=75",
  sunset: "https://images.unsplash.com/photo-1469474968028-56623f02e42e?w=900&q=75",
  sea: "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=1000&q=75",
};

const common = (id: string, size: { width: number; height: number }, now: number) => ({
  id: `landing-${id}`,
  variant: "standard" as const,
  sources: [],
  layout: { x: 0, y: 0, ...size, pinned: false },
  metadata: { createdAt: iso(now - 86_400_000), updatedAt: iso(now - 600_000) },
  sourceData: {},
});
const scene = (name: SceneId, id: string, now: number) => common(id, SCENE_CARD_SIZES[name], now);

export function buildDemoCards(now: number = Date.now()) {
  const today = todayIn(undefined, now);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
  const year = today.slice(0, 4);
  const month = today.slice(0, 7);
  const nextMonday = addDays(mondayOf(today), 7);
  const birthday = addDays(today, 25);

  const cards = {
    travel: {
      prompt: "下周去杭州住两晚，预算500（旅游DEMO，无需连接模型）",
      card: { ...scene("travel_offers", "travel", now), type: "TravelOffersCard",
        displayProps: { query: { kind: "hotel", destination: "杭州", dateText: "下周", nights: 2, budget: 500 },
          items: [{ id: "demo-stay", kind: "hotel", title: "杭州 · 演示住宿", subtitle: "虚构样例，不代表真实酒店、价格或可预订库存。",
            price: { amount: 328, currency: "CNY" }, tags: ["模拟数据", "不可预订"] }],
          fetchedAt: iso(now), mode: "demo", status: "ok", selectedIds: [], notes: "" },
        sourceData: { provider: "vivic-demo", tool: "travel.search", requestId: "landing-travel-demo" },
        sources: [{ kind: "service", title: "Vivic 旅游演示数据", provider: "vivic-demo", fetchedAt: iso(now), readFullPage: false }] },
    },
    countdown: {
      prompt: "距离我生日还有 25 天，帮我做个倒计时",
      card: { ...scene("countdown", "countdown", now), type: "CountdownCard", displayProps: {},
        sourceData: { targetAt: iso(Date.parse(`${birthday}T00:00:00`)), startedAt: iso(now - 5 * 86_400_000), timeZone: zone,
          event: { title: "我的生日", date: birthday, note: "记得提前订蛋糕" } } },
    },
    timer: {
      prompt: "帮我倒计时 25 分钟",
      card: { ...common("timer", { width: 240, height: 120 }, now), type: "CountdownCard", displayProps: {},
        sourceData: { targetAt: iso(now + 25 * 60_000), startedAt: iso(now) } },
    },
    reminder: {
      prompt: "20 分钟后提醒我取快递",
      card: { ...common("reminder", { width: 300, height: 120 }, now), type: "CountdownCard", displayProps: {},
        sourceData: { targetAt: iso(now + 20 * 60_000), startedAt: iso(now), reminderText: "取快递" } },
    },
    todo: {
      prompt: "今天要做：交周报、取快递、给妈妈打电话",
      card: { ...scene("todo_list", "todo", now), type: "TodoCard",
        displayProps: { title: "今天要完成", items: [
          { id: "t1", text: "交周报", done: true },
          { id: "t2", text: "取快递", done: false },
          { id: "t3", text: "给妈妈打电话", done: false },
        ] } },
    },
    week: {
      prompt: "下周一上午 9 点开会，周三下午 3 点健身，周五晚上 8 点看电影",
      card: { ...scene("weekly_schedule", "week", now), type: "WeeklyScheduleCard",
        displayProps: { title: "下周安排", weekStart: nextMonday, events: [
          { id: "w1", day: 1, start: "09:00", title: "开会" },
          { id: "w2", day: 3, start: "15:00", title: "健身" },
          { id: "w3", day: 5, start: "20:00", title: "看电影" },
        ] } },
    },
    chart: {
      prompt: "这周专注时长：周一 3.5、周二 4、周三 2.5、周四 5、周五 4.5 小时",
      card: { ...scene("data_visualization", "chart", now), type: "ChartCard",
        displayProps: { title: "本周专注时长", chartKind: "line", xLabel: "日期", yLabel: "小时",
          points: [{ x: "周一", y: 3.5 }, { x: "周二", y: 4 }, { x: "周三", y: 2.5 }, { x: "周四", y: 5 }, { x: "周五", y: 4.5 }] } },
    },
    goal: {
      prompt: "今年读书目标 50 本，已经读了 18 本",
      card: { ...scene("goal_progress", "goal", now), type: "ProgressRingCard",
        displayProps: { title: "今年读书目标", current: 18, target: 50, unit: "本", deadline: `${year}-12-31` } },
    },
    habit: {
      prompt: "把我的跑步打卡做成热力图，每周目标 4 次",
      card: { ...scene("habit_tracking", "habit", now), type: "HabitHeatmapCard",
        displayProps: { habit: "每天跑步", weeklyGoal: 4,
          checkins: Array.from({ length: 63 }, (_, i) => addDays(today, -i)).filter((_, i) => i < 5 || (i % 3 !== 0 && i % 7 !== 5)) } },
    },
    book: {
      prompt: "在读《思考，快与慢》，读到第 86 页，一共 240 页",
      card: { ...scene("book_record", "book", now), type: "BookCard",
        displayProps: { title: "思考，快与慢", author: "丹尼尔·卡尼曼", status: "reading", currentPage: 86, totalPages: 240, rating: 4, notes: ["系统一快而直觉，系统二慢而费力"] } },
    },
    month: {
      prompt: "这个月 20 号体检，25 号交房租，28 号考试",
      card: { ...scene("monthly_calendar", "month", now), type: "MonthCalendarCard",
        displayProps: { title: "本月安排", month, events: [
          { id: "m1", date: `${month}-20`, title: "体检" },
          { id: "m2", date: `${month}-25`, title: "交房租" },
          { id: "m3", date: `${month}-28`, title: "考试" },
        ] } },
    },
    compare: {
      prompt: "比较三套租房：A 月租 5200、通勤 15 分钟、45 平；B 4600、30 分钟、60 平；C 3800、50 分钟、52 平",
      card: { ...scene("option_comparison", "compare", now), type: "ComparisonCard",
        displayProps: { title: "三套租房方案", options: [{ id: "a", name: "方案 A" }, { id: "b", name: "方案 B" }, { id: "c", name: "方案 C" }],
          criteria: [
            { id: "rent", name: "月租", values: [5200, 4600, 3800], better: "lower", unit: "元" },
            { id: "commute", name: "通勤", values: [15, 30, 50], better: "lower", unit: "分钟" },
            { id: "area", name: "面积", values: [45, 60, 52], better: "higher", unit: "㎡" },
          ], recommendation: "综合租金、通勤和面积，方案 B 更均衡。", chosenId: "b" } },
    },
    link: {
      prompt: "收藏这个网站 https://github.com/xyflow/xyflow",
      card: { ...scene("web_bookmark", "link", now), type: "LinkPreviewCard",
        displayProps: { url: "https://github.com/xyflow/xyflow", title: "xyflow — React Flow", siteName: "GitHub", description: "用于构建节点式编辑器和交互图的 React 库。", tags: ["前端", "工具"] } },
    },
    cover: {
      prompt: "把这张照片做成纪念卡：去年 9 月 12 日，第一次看海",
      card: { ...scene("photo_memory", "cover", now), type: "PhotoCoverCard",
        displayProps: { title: "第一次看海", date: `${Number(year) - 1}-09-12`, caption: "那天风很大，但很开心。", image: { src: PHOTO.sea, alt: "海边日落" } } },
    },
    notice: {
      prompt: "通知：快递到驿站了，取件码 8-2-3017",
      card: { ...scene("single_notification", "notice", now), type: "NotificationCard",
        displayProps: { title: "快递已到驿站", body: "取件码 8-2-3017", level: "success", at: iso(now - 12 * 60_000), status: "unread" } },
    },
    paper: {
      prompt: "整理这篇论文：https://arxiv.org/abs/1706.03762",
      card: { ...scene("academic_paper", "paper", now), type: "PaperCard",
        displayProps: { title: "Attention Is All You Need", authors: ["Ashish Vaswani", "Noam Shazeer", "Niki Parmar", "Jakob Uszkoreit"],
          venue: "NeurIPS", year: 2017, url: "https://arxiv.org/abs/1706.03762",
          abstract: "提出完全基于注意力机制的 Transformer 架构，摒弃循环与卷积，在机器翻译上效果更好、训练更快。",
          keyPoints: ["自注意力替代循环结构", "多头注意力捕捉不同子空间"], tags: ["NLP"], readStatus: "reading" } },
    },
    news: {
      prompt: "帮我摘要这条新闻（附上链接）",
      card: { ...scene("news_summary", "news", now), type: "NewsCard",
        displayProps: { headline: "城市地铁新线路本周开通", source: "城市日报", publishedAt: addDays(today, -1),
          summary: "新线路连接城东与高铁站，全程约 32 分钟，首末班车时间与既有线路一致，开通首周票价八折。",
          keyPoints: ["全程约 32 分钟", "首周票价八折"], url: "https://example.com/news/metro", summaryBy: "ai" } },
    },
    timeline: {
      prompt: "整理我们认识以来的大事：2019 年 9 月在图书馆认识，2021 年 5 月第一次旅行，2023 年搬到上海",
      card: { ...scene("historical_timeline", "timeline", now), type: "TimelineCard",
        displayProps: { title: "我们认识以来", events: [
          { id: "e1", date: "2019-09", title: "在图书馆认识", description: "借了同一本书" },
          { id: "e2", date: "2021-05", title: "第一次一起旅行" },
          { id: "e3", date: "2023", title: "一起搬到上海" },
        ] } },
    },
    quote: {
      prompt: "记一句今天读到的话：好的设计，是让人感觉不到设计。",
      card: { ...scene("quote_note", "quote", now), type: "QuoteCard",
        displayProps: { text: "好的设计，是让人感觉不到设计。", source: "今天读到的", tag: "灵感" } },
    },
    story: {
      prompt: "用这三张照片讲讲我们的旅行：出发、山路、日落",
      card: { ...scene("photo_story", "story", now), type: "StoryCarouselCard",
        displayProps: { title: "一路向山海", slides: [
          { id: "s1", image: PHOTO.lake, heading: "出发", text: "清晨，背上包出发。" },
          { id: "s2", image: PHOTO.road, heading: "山路", text: "走了很久的山路。" },
          { id: "s3", image: PHOTO.sunset, heading: "日落", text: "终于赶上了日落。" },
        ] } },
    },
    gallery: {
      prompt: "把周末出游的三张照片做成照片墙",
      card: { ...scene("photo_gallery", "gallery", now), type: "GalleryCard",
        displayProps: { title: "周末出游", images: [
          { src: PHOTO.lake, caption: "湖边小屋" }, { src: PHOTO.road, caption: "山路" }, { src: PHOTO.sunset, caption: "日落" },
        ] } },
    },
    roadmap: {
      prompt: "未来三个月：第一个月调研，第二个月开发，第三个月内测上线",
      card: { ...scene("project_roadmap", "roadmap", now), type: "RoadmapCard",
        displayProps: { title: "三个月推进计划", phases: [
          { id: "p1", name: "调研", period: "第 1 个月", status: "done", milestones: [{ id: "r1", text: "用户访谈", done: true }] },
          { id: "p2", name: "开发", period: "第 2 个月", status: "active", milestones: [{ id: "r2", text: "核心功能", done: false }] },
          { id: "p3", name: "内测上线", period: "第 3 个月", status: "planned", milestones: [{ id: "r3", text: "邀请内测", done: false }] },
        ] } },
    },
    feed: {
      prompt: "最近画布上有什么变化？",
      card: { ...scene("activity_feed", "feed", now), type: "ActivityFeedCard",
        displayProps: { title: "最近动态", items: [
          { id: "a1", kind: "done", text: "完成了「交周报」", at: iso(now - 4 * 60_000) },
          { id: "a2", kind: "create", text: "新建了下周安排", at: iso(now - 50 * 60_000) },
          { id: "a3", kind: "update", text: "读书进度更新到 18 本", at: iso(now - 5 * 3_600_000) },
        ] } },
    },
    weather: {
      prompt: "上海今天天气怎么样？",
      card: { ...common("weather", { width: 240, height: 150 }, now), type: "WeatherCard",
        displayProps: { tempC: 23, conditionIcon: "cloud" }, sourceData: { location: "上海" } },
    },
    search: {
      prompt: "查一下 React Flow 是什么",
      card: { ...common("search", { width: 340, height: 190 }, now), type: "SearchResultCard",
        displayProps: { title: "React Flow", summary: "用于构建节点式编辑器、流程图和交互图的 React 组件库。", sourceLabel: "reactflow.dev" },
        sources: [{ title: "React Flow", url: "https://reactflow.dev", fetchedAt: iso(now - 60_000), provider: "web", readFullPage: false }] },
    },
    table: {
      prompt: "建个表：问卷 30 份，访谈提纲 5 份，测试记录 12 份",
      card: { ...common("table", { width: 320, height: 200 }, now), type: "TableCard",
        displayProps: { columns: ["材料", "份数"], rows: [["问卷", 30], ["访谈提纲", 5], ["测试记录", 12]] } },
    },
  } satisfies Record<string, { prompt: string; card: Record<string, unknown> }>;

  return cards as unknown as Record<keyof typeof cards, DemoCard>;
}

export type DemoCardKey = keyof ReturnType<typeof buildDemoCards>;

/** Order of the curved scene ring: all twenty-one scene cards plus the classic cards. */
export const RING_ORDER: DemoCardKey[] = [
  "countdown", "week", "compare", "goal", "story", "todo", "chart", "timeline", "link", "habit",
  "cover", "month", "book", "quote", "notice", "paper", "gallery", "roadmap", "news", "feed",
  "travel", "weather", "timer", "search", "table",
];
