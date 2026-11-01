import { planFromToolCalls, type ToolCall } from "../src/intent/toolCalls.js";
import type { CanvasContext } from "../src/schemas.js";

const ctx: CanvasContext = {
  canvasId: "smoke",
  stage: "WORKSPACE",
  viewport: { x: 0, y: 0, zoom: 1 },
  focusHistory: ["note_meeting"],
  cards: [
    { id: "note_meeting", type: "NoteCard", aliases: ["会议记录"], displayProps: { text: "会议记录" }, sourceDataSummary: {}, layout: { x: 0, y: 0, width: 320, height: 120 } },
    { id: "note_shopping", type: "NoteCard", aliases: ["购物便笺"], displayProps: { text: "购物" }, sourceDataSummary: {}, layout: { x: 344, y: 0, width: 320, height: 120 } },
    { id: "todo_week", type: "TodoCard", aliases: ["本周待办"], displayProps: { title: "本周待办" }, sourceDataSummary: {}, layout: { x: 688, y: 0, width: 288, height: 160 } },
    { id: "countdown_tea", type: "CountdownCard", aliases: ["泡茶"], displayProps: {}, sourceDataSummary: {}, layout: { x: 1000, y: 0, width: 220, height: 220 } },
  ],
};

const cases: Array<[string, ToolCall[]]> = [
  ["countdown", [{ name: "create_countdown", arguments: { minutes: 10 } }]],
  ["note+countdown", [{ name: "create_note", arguments: { text: "明天交周报" } }, { name: "create_countdown", arguments: { minutes: 50 } }]],
  ["numbered3", [{ name: "create_countdown", arguments: { minutes: 30 } }, { name: "create_schedule", arguments: { title: "健身", day: "周四", time: "下午" } }, { name: "create_schedule", arguments: { title: "开会", day: "周四", time: "上午9点" } }]],
  ["focus_card", [{ name: "focus_card", arguments: { card_id: "note_meeting" } }]],
  ["focus_created", [{ name: "create_note", arguments: { text: "交周报" } }, { name: "focus_created", arguments: {} }]],
  ["canvas_fit", [{ name: "canvas_fit", arguments: {} }]],
  ["weekly", [{ name: "create_weekly_plan", arguments: { topic: "健身计划" } }]],
  ["clarify", [{ name: "clarify", arguments: { question: "要聚焦哪张卡？" } }]],
  ["chat", [{ name: "chat", arguments: {} }]],
  ["invalid-mix", [{ name: "clarify", arguments: { question: "?" } }, { name: "create_note", arguments: { text: "x" } }]],
  ["invalid-focus", [{ name: "focus_card", arguments: { card_id: "missing" } }]],
];

for (const [name, calls] of cases) {
  const plan = await planFromToolCalls(calls, ctx);
  console.log(name, "=>", plan.kind, "actions=", plan.actions.map(a => a.type).join(","),
    "cards=", plan.created.map(c => c.cardType).join(","), "issues=", plan.issues.join("|"));
}
