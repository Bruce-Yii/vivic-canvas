import type { SceneId } from "@vivic/contracts";
import { SCENE_CASES, SCENE_NOW, SCENE_ZONE } from "../tests/sceneCases.js";
export { SCENE_NOW as GOLDEN_NOW, SCENE_ZONE as GOLDEN_ZONE };

export interface GoldenCase {
  id: string; input: string; scene: SceneId; payload: Record<string, unknown>;
  expect: "card" | "clarify"; fields?: Record<string, unknown>;
}
/** Fixed, versioned Chinese utterances. Offline mode replays these expected extractions, never claims model accuracy. */
export const GOLDEN_CASES: GoldenCase[] = SCENE_CASES.map((item, i) => ({ ...item, id: `scene-${i + 1}`, expect: "card" }));

const goals = ["跑步", "读书", "存钱", "背单词", "论文页数", "编程练习", "健身", "学琴", "志愿服务", "晨练", "写作", "游泳"];
for (const [i, title] of goals.entries()) {
  const current = (i + 1) * 3, target = (i + 1) * 10;
  GOLDEN_CASES.push({ id: `goal-${i + 1}`, scene: "goal_progress", expect: "card",
    input: `我今年的${title}目标是${target}，目前完成${current}，帮我显示完成比例`,
    payload: { title, current, target }, fields: { "displayProps.current": current, "displayProps.target": target } });
  const habit = ["冥想", "喝水", "早睡", "散步", "阅读", "俯卧撑", "学习英语", "练字", "拉伸", "记账", "骑车", "画画"][i]!;
  GOLDEN_CASES.push({ id: `habit-${i + 1}`, scene: "habit_tracking", expect: "card",
    input: `帮我做${habit}打卡：2026年10月15日、2026年10月16日和2026年10月17日完成了，每周目标${i % 7 + 1}天`,
    payload: { habit, checkins: ["2026-10-15", "2026-10-16", "2026-10-17"], weeklyGoal: i % 7 + 1 }, fields: { "displayProps.habit": habit, "displayProps.weeklyGoal": i % 7 + 1 } });
  const task = ["交作业", "检查库存", "回复客户", "整理照片", "买牛奶", "洗衣服", "订餐", "准备答辩", "备份电脑", "预约体检", "写测试", "浇花"][i]!;
  GOLDEN_CASES.push({ id: `todo-${i + 1}`, scene: "todo_list", expect: "card",
    input: `请列成可勾选的待办清单：${task}、取快递、回邮件`, payload: { items: [task, "取快递", "回邮件"] },
    fields: { "displayProps.items.0.text": task, "displayProps.items.0.done": false } });
  GOLDEN_CASES.push({ id: `timeline-${i + 1}`, scene: "historical_timeline", expect: "card",
    input: `把第${i + 1}个项目经历整理成时间线：2024年3月启动，2025年6月交付，2026年8月验收`,
    payload: { title: `项目${i + 1}`, events: [{ date: "2024-03", title: "启动" }, { date: "2025-06", title: "交付" }, { date: "2026-08", title: "验收" }] },
    fields: { "displayProps.events.0.date": "2024-03", "displayProps.events.2.date": "2026-08" } });
  const destination = ["杭州", "上海", "北京", "广州", "深圳", "成都", "重庆", "西安", "武汉", "南京", "苏州", "青岛"][i]!;
  GOLDEN_CASES.push({ id: `hotel-${i + 1}`, scene: "travel_offers", expect: "card",
    input: `下周去${destination}住${i % 4 + 1}晚，住宿预算${300 + i * 50}，查询一下`,
    payload: { kind: "hotel", destination, dateText: "下周", nights: i % 4 + 1, budget: 300 + i * 50 },
    fields: { "displayProps.query.destination": destination, "displayProps.query.nights": i % 4 + 1, "displayProps.mode": "demo" } });
  const text = ["今天也要认真生活", "开始比完美重要", "把事情一件件做好", "留一点时间给自己", "慢慢走也会到达", "好奇心是最好的老师", "先做好眼前的小事", "改变从一个小习惯开始", "读书也要思考", "休息也是计划的一部分", "与昨天的自己比较", "记住今天的阳光"][i]!;
  GOLDEN_CASES.push({ id: `quote-${i + 1}`, scene: "quote_note", expect: "card",
    input: `把这句话记成金句卡：${text}`, payload: { text }, fields: { "displayProps.text": text } });
}

const rejects: Array<[SceneId, string, Record<string, unknown>]> = [
  ["countdown", "做生日倒计时", { title: "生日", targetDate: "2030-01-01" }],
  ["goal_progress", "显示我的读书进度", { title: "读书", current: 18, target: 50 }],
  ["data_visualization", "画一个步数趋势图", { chartKind: "line", points: [{ x: "周一", y: 999 }] }],
  ["historical_timeline", "整理我的成长经历", { title: "成长", events: [{ date: "2015", title: "毕业" }] }],
  ["book_record", "记录在读《三体》", { title: "三体", currentPage: 50, totalPages: 300 }],
  ["web_bookmark", "收藏那个网站", { url: "https://invented.example/" }],
  ["travel_offers", "杭州住两晚", { kind: "hotel", destination: "杭州", nights: 2 }],
  ["travel_offers", "下周去杭州住两晚", { kind: "hotel", destination: "上海", dateText: "下周", nights: 2 }],
  ["travel_offers", "下周查杭州酒店", { kind: "hotel", destination: "杭州", dateText: "下周" }],
  ["travel_offers", "下周去杭州住两晚，请查一下", { kind: "hotel", destination: "杭州", dateText: "下周", nights: 2, items: [] }],
  ["travel_offers", "查明天去杭州的机票", { kind: "flight", destination: "杭州", dateText: "明天" }],
  ["news_summary", "总结今天的新闻", { headline: "新闻", summary: "未提供的事件" }],
];
GOLDEN_CASES.push(...rejects.map(([scene, input, payload], i): GoldenCase => ({ id: `clarify-${i + 1}`, scene, input, payload, expect: "clarify" })));
