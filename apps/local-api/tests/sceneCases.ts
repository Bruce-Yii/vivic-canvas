import type { SceneId } from "@vivic/contracts";

/**
 * One realistic utterance per scene plus the payload a correct planner would
 * return. Unit tests replay the payloads through the real builder/grounding;
 * the live script sends only the utterances to the connected model.
 * Clock: 2026-10-17 10:00 Asia/Shanghai (a Saturday).
 */
export const SCENE_NOW = Date.parse("2026-10-17T02:00:00.000Z");
export const SCENE_ZONE = "Asia/Shanghai";

export interface SceneCase { scene: SceneId; input: string; payload: Record<string, unknown> }

export const SCENE_CASES: SceneCase[] = [
  { scene: "travel_offers", input: "帮我做旅游结果卡：下周去杭州住两晚，预算500",
    payload: { kind: "hotel", destination: "杭州", dateText: "下周", nights: 2, budget: 500 } },
  { scene: "countdown", input: "距离我的生日还有 25 天，帮我做个倒计时",
    payload: { title: "我的生日", targetDate: "2026-11-11" } },
  { scene: "academic_paper", input: "帮我整理一下这篇论文：Attention Is All You Need，作者 Ashish Vaswani、Noam Shazeer，发表在 NeurIPS 2017，DOI 10.48550/arXiv.1706.03762。摘要：我们提出了一种完全基于注意力机制的网络架构 Transformer，摒弃了循环和卷积，在机器翻译任务上效果更好，训练也更快。",
    payload: { title: "Attention Is All You Need", authors: ["Ashish Vaswani", "Noam Shazeer"], venue: "NeurIPS", year: 2017, doi: "10.48550/arXiv.1706.03762",
      abstract: "提出完全基于注意力机制的网络架构 Transformer，摒弃循环和卷积，在机器翻译任务上效果更好，训练也更快。", keyPoints: ["完全基于注意力机制", "摒弃循环和卷积"] } },
  { scene: "photo_gallery", input: "把这几张一起拍的照片做成照片墙：https://example.com/p1.jpg https://example.com/p2.jpg https://example.com/p3.jpg",
    payload: { title: "我们一起拍的照片", images: ["https://example.com/p1.jpg", { url: "https://example.com/p2.jpg" }, { url: "https://example.com/p3.jpg", caption: "第三张" }] } },
  { scene: "weekly_schedule", input: "帮我规划下周安排：周一上午9点开会，周三下午3点去健身房，周五晚上7点和朋友吃饭",
    payload: { title: "下周安排", weekStart: "2026-10-19", events: [{ day: 1, start: "09:00", title: "开会" }, { day: 3, start: "15:00", title: "去健身房" }, { day: 5, start: "19:00", title: "和朋友吃饭" }] } },
  { scene: "todo_list", input: "今天有什么要完成：交周报、取快递、给妈妈打电话",
    payload: { title: "今天要完成", items: ["交周报", "取快递", "给妈妈打电话"] } },
  { scene: "project_roadmap", input: "未来三个月怎么推进这个 App 项目：第一个月做需求调研，第二个月完成开发，第三个月测试上线",
    payload: { title: "App 项目推进计划", phases: [{ name: "需求调研", period: "第一个月", status: "active" }, { name: "开发", period: "第二个月", milestones: ["完成开发"] }, { name: "测试上线", period: "第三个月" }] } },
  { scene: "data_visualization", input: "这周每天的步数：周一 8000，周二 6500，周三 10200，周四 7600，周五 9100，帮我看看趋势",
    payload: { title: "本周步数", chartKind: "line", yLabel: "步", points: [{ x: "周一", y: 8000 }, { x: "周二", y: 6500 }, { x: "周三", y: 10200 }, { x: "周四", y: 7600 }, { x: "周五", y: 9100 }] } },
  { scene: "news_summary", input: "帮我摘要这条新闻：本市地铁 5 号线南延段将于 10 月 25 日开通运营，新增 6 座车站，全程运行约 32 分钟，开通首周票价八折，首末班车时间与既有线路保持一致。",
    payload: { headline: "地铁 5 号线南延段 10 月 25 日开通", summary: "地铁 5 号线南延段将于 10 月 25 日开通运营，新增 6 座车站，全程运行约 32 分钟，开通首周票价八折。", keyPoints: ["新增 6 座车站", "首周票价八折"] } },
  { scene: "historical_timeline", input: "整理我们认识以来的重要事情：2019年9月在图书馆认识，2021年5月第一次一起旅行去青岛，2023年一起搬到上海",
    payload: { title: "我们认识以来", events: [{ date: "2019-09", title: "在图书馆认识" }, { date: "2021-05", title: "第一次一起旅行", description: "去青岛" }, { date: "2023", title: "一起搬到上海" }] } },
  { scene: "quote_note", input: "记一句今天读到的话：“好的设计，是让人感觉不到设计。”——来自《设计心理学》",
    payload: { text: "好的设计，是让人感觉不到设计。", source: "《设计心理学》", tag: "阅读" } },
  { scene: "photo_story", input: "用这三张照片讲讲我们的旅行故事：第一天出发 https://example.com/a.jpg ，第二天爬山 https://example.com/b.jpg ，最后看海 https://example.com/c.jpg",
    payload: { title: "我们的旅行", slides: [{ heading: "出发", text: "第一天出发", imageUrl: "https://example.com/a.jpg" }, { heading: "爬山", text: "第二天爬山", imageUrl: "https://example.com/b.jpg" }, { heading: "看海", text: "最后看海", imageUrl: "https://example.com/c.jpg" }] } },
  { scene: "activity_feed", input: "最近产生了什么活动？",
    payload: { title: "最近动态", live: true } },
  { scene: "goal_progress", input: "今年读书目标 50 本，已经读了 18 本，看看完成多少了",
    payload: { title: "今年读书目标", current: 18, target: 50, unit: "本", deadline: "2026-12-31" } },
  { scene: "habit_tracking", input: "我每天跑步打卡，10月15日、10月16日和今天都跑了，看看最近每天有没有坚持",
    payload: { habit: "每天跑步", checkins: ["2026-10-15", "2026-10-16", "2026-10-17"] } },
  { scene: "book_record", input: "记录一下我在读《思考，快与慢》，作者丹尼尔·卡尼曼，读到第 86 页，一共 240 页",
    payload: { title: "思考，快与慢", author: "丹尼尔·卡尼曼", status: "reading", currentPage: 86, totalPages: 240 } },
  { scene: "monthly_calendar", input: "这个月的安排：10月20日体检，10月25日交房租，10月31日朋友婚礼",
    payload: { title: "这个月的安排", month: "2026-10", events: [{ date: "2026-10-20", title: "体检" }, { date: "2026-10-25", title: "交房租" }, { date: "2026-10-31", title: "朋友婚礼" }] } },
  { scene: "option_comparison", input: "帮我比较三套租房方案：A 月租 5200 通勤 15 分钟，B 月租 4600 通勤 30 分钟，C 月租 3800 通勤 50 分钟",
    payload: { title: "租房方案对比", options: ["A", "B", "C"], criteria: [{ name: "月租", values: [5200, 4600, 3800], better: "lower", unit: "元" }, { name: "通勤", values: [15, 30, 50], better: "lower", unit: "分钟" }], recommendation: "B 在租金和通勤之间更均衡", chosen: "B" } },
  { scene: "web_bookmark", input: "收藏这个网站 https://github.com/xyflow/xyflow",
    payload: { url: "https://github.com/xyflow/xyflow", siteName: "GitHub", tags: ["前端"] } },
  { scene: "photo_memory", input: "把这张照片做成纪念卡：2025年12月31日在外滩看跨年烟火 https://example.com/fireworks.jpg",
    payload: { title: "外滩跨年烟火", date: "2025-12-31", caption: "在外滩看跨年烟火", imageUrl: "https://example.com/fireworks.jpg" } },
  { scene: "single_notification", input: "通知：快递已经到驿站了，取件码 8-2-3017",
    payload: { title: "快递已到驿站", body: "取件码 8-2-3017", level: "success" } },
];

/** Requests that must NOT produce a card: plain chat, or a card with no evidence to fill it. */
export const NO_CARD_CASES: Array<{ input: string; expect: "reply" | "clarify" }> = [
  { input: "你好，今天心情不错", expect: "reply" },
  { input: "帮我做个生日倒计时", expect: "clarify" },
];

/** Easily-confused requests and the one scene each must map to (live evaluation). */
export const CONFUSABLE_CASES: Array<{ scene: SceneId; input: string }> = [
  { scene: "todo_list", input: "今天有什么要完成？写报告、回邮件、买菜" },
  { scene: "weekly_schedule", input: "今天几点做什么：9点开会，下午2点见客户，晚上8点健身" },
  { scene: "project_roadmap", input: "未来三个月怎么推进毕业论文：10月定题，11月写初稿，12月修改定稿" },
  { scene: "goal_progress", input: "今年目标跑 1000 公里，现在跑了 640 公里，完成多少了" },
  { scene: "habit_tracking", input: "最近每天有没有打卡背单词？10月14日、10月15日和10月17日背了" },
  { scene: "historical_timeline", input: "上个月发生了什么重要事件：9月3日项目立项，9月18日拿到第一笔融资，9月28日团队扩到10人" },
  { scene: "activity_feed", input: "这块画布最近有什么动态" },
  { scene: "countdown", input: "离 12 月 20 日考研还有多少天" },
  { scene: "monthly_calendar", input: "用月历展示：11月3日开会，11月11日聚餐，11月20日出差" },
  { scene: "historical_timeline", input: "做成时间线：2015年入学，2019年毕业，2022年创业" },
];
