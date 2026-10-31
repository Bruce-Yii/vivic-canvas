import { matchRules } from "../../apps/local-api/src/intent/rules.js";
import { countdownContract } from "../../apps/local-api/src/cards/countdown.js";
import { todoContract } from "../../apps/local-api/src/cards/todo.js";
import { noteContract } from "../../apps/local-api/src/cards/note.js";
import { overviewContract, restoreContract } from "../../apps/local-api/src/cards/views.js";
import type { CardBuildContext } from "../../apps/local-api/src/cards/types.js";

const card = { id: "card-1", type: "NoteCard" as const, aliases: [], displayProps: { text: "x" }, sourceDataSummary: {}, layout: { x: 0, y: 0, width: 100, height: 100, pinned: false } };
const ctx: CardBuildContext = { canvasId: "probe", stage: "WORKSPACE", viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], cards: [card] };
const empty = { ...ctx, cards: [] };

const deferCountdown = [
  "倒计时", "帮我创建一个倒计时", "倒计时50", "倒计时0秒", "倒计时25小时", "倒计时30分钟然后显示全部",
  "倒计时30分钟，显示全部", "不要倒计时30分钟", "别设个30分钟倒计时", "如果下雨就倒计时30分钟",
  "解释一下倒计时30分钟", "倒计时30分钟是什么意思", "倒计时30分钟吗", "倒计时30分钟？", "把倒计时30分钟",
  "倒计时30分钟提醒我喝水", "倒计时30分钟，提醒我喝水", "30分钟倒计时提醒我喝水", "加待办：倒计时30分钟",
  "把30分钟倒计时删掉",
];
const deferTodo = [
  "加待办：买牛奶；显示全部", "加待办：买牛奶；取消固定购物清单", "加待办：买牛奶；把书移到左边",
  "加待办：买牛奶；恢复原视图", "加待办：买牛奶；删除便签", "加待办：买牛奶。显示全部", "加待办：买牛奶。交周报",
  "加待办：买牛奶，然后显示全部", "加待办：买牛奶并创建便签", "加待办：买牛奶，别添加第二项",
  "加待办：如果我确认再添加买牛奶", "加待办：", "待办：；，", "待办：买牛奶，然后提醒我开会",
  "添加待办：买牛奶；再聚焦这张卡", "待办：买牛奶，取消聚焦", "待办：买牛奶；顺便打开浏览器",
  "待办：买牛奶再显示全部", "待办：买牛奶，如果下雨就不要创建", "待办：把这张便签改成完成",
  "待办：买牛奶，别添加第二项", "加待办：买牛奶；移动卡片", "加待办：买牛奶；固定购物清单",
  "加待办：买牛奶；打开购物清单", "加待办：买牛奶；搜索明天天气", "加待办：买牛奶；查天气",
  "加待办：买牛奶；提醒我喝水", "加待办：买牛奶；倒计时5分钟", "加待办：买牛奶；设个5分钟计时器",
  "加待办：买牛奶；生成阅读计划卡", "加待办：买牛奶；创建一张周计划卡", "加待办：买牛奶；新建待办",
  "加待办：买牛奶；记个便签", "加待办：买牛奶；写便签", "加待办：买牛奶；把这张便签改成完成",
];
const deferNote = [
  "帮我记个便签明天交周报，再设个50分钟倒计时", "记一下明天交周报，然后显示全部",
  "记一下明天交周报。显示全部", "记一下明天交周报。然后聚焦它", "帮我记个便签：买牛奶；显示全部",
  "帮我记个便签：买牛奶，然后显示全部", "帮我记个便签：买牛奶，再设个倒计时",
  "帮我记个便签：买牛奶，删除便签", "帮我记个便签：买牛奶，取消聚焦", "帮我记个便签：买牛奶，恢复原视图",
  "帮我记个便签：买牛奶，打开浏览器", "帮我记个便签：买牛奶，搜索天气",
  "帮我记个便签：买牛奶，提醒我喝水", "帮我记个便签：买牛奶，倒计时5分钟",
  "帮我记个便签：买牛奶，设个倒计时", "帮我记个便签：买牛奶，创建便签",
  "帮我记个便签：买牛奶，记一下", "帮我记个便签：买牛奶，生成报告",
  "帮我记个便签：买牛奶，聚焦它", "帮我记个便签：买牛奶，放大",
  "帮我记个便签：买牛奶，高亮", "帮我记个便签：买牛奶，移动",
  "帮我记个便签：买牛奶，固定", "帮我记个便签：买牛奶，暂停",
  "帮我记个便签：买牛奶，继续", "帮我记个便签：买牛奶，修改",
  "帮我记个便签：买牛奶，保存", "帮我记个便签：买牛奶，关闭",
  "帮我记个便签：买牛奶，查一下", "记一下", "便签：", "新建便笺，内容是", "创建便笺：",
  "帮我解释光合作用",
];
const deferSimple = [
  "帮我显示全部然后删除这张卡", "显示全部？", "显示全部吗", "如何显示全部", "解释一下显示全部",
  "不要显示全部", "别显示全部", "如果显示全部", "显示全部是什么意思", "把显示全部",
  "恢复原视图然后显示全部", "恢复原视图，显示全部", "恢复原视图。显示全部",
  "帮我恢复原视图，再设个倒计时", "唤醒屏幕", "唤醒词", "唤醒我", "唤醒一下然后显示全部",
];
const deferDelete = [
  "删除所有卡片中的一张", "删除所有卡片吗", "删除所有卡片？", "不要删除所有卡片", "别清空画布",
  "如果删除所有卡片", "解释删除所有卡片", "删除所有卡片然后显示全部", "删除所有卡片。显示全部",
  "清空画布后恢复", "清空画布，恢复原视图", "删除所有卡片；显示全部", "删除这张卡片", "删除所有",
  "清空", "全部删除", "删除所有卡", "删除所有卡片中的",
];
const hitDelete = [
  "删除所有卡片", "帮我删除所有卡片", "请把所有卡片都删掉。", "给我清空画布", "把当前画布清空",
  "清空当前画布上的所有卡片", "删除画布上所有卡片", "删除当前画布中的所有卡片", "移除全部卡片",
  "把全部卡片都删除", "把卡片全部删除", "把卡片都删除", "把卡片删除", "清空所有卡片",
  "清空全部卡片", "删掉所有卡片！", "删除所有卡片。", "请帮我清空当前画布。", "麻烦你把所有卡片删除。",
];

const failures: string[] = [];
const check = (label: string, text: string, actual: boolean, expected: boolean) => {
  if (actual !== expected) failures.push(`${label} ${expected ? "should hit" : "should defer"} but ${actual ? "hit" : "deferred"}: ${text}`);
};
for (const text of deferCountdown) check("countdown", text, matchRules(text, ctx) !== null, false);
for (const text of deferTodo) check("todo", text, matchRules(text, ctx) !== null, false);
for (const text of deferNote) check("note", text, matchRules(text, ctx) !== null, false);
for (const text of deferSimple) check("simple", text, matchRules(text, ctx) !== null, false);
for (const text of deferDelete) check("delete", text, matchRules(text, ctx) !== null, false);
for (const text of hitDelete) check("delete", text, matchRules(text, ctx) !== null, true);
check("delete-no-cards", "删除所有卡片", matchRules("删除所有卡片", empty) !== null, false);
console.log(`defer cases: ${deferCountdown.length + deferTodo.length + deferNote.length + deferSimple.length + deferDelete.length}; failures: ${failures.length}`);
for (const f of failures) console.log(f);

// Contract parity for the same defer set (where a contract exists).
const contractFailures: string[] = [];
for (const text of deferCountdown) if (countdownContract.parse!(text, ctx) !== null) contractFailures.push(`countdown contract: ${text}`);
for (const text of deferTodo) if (todoContract.parse!(text, ctx) !== null) contractFailures.push(`todo contract: ${text}`);
for (const text of deferNote) if (noteContract.parse!(text, ctx) !== null) contractFailures.push(`note contract: ${text}`);
for (const text of deferSimple) if (overviewContract.parse!(text, ctx) !== null || restoreContract.parse!(text, ctx) !== null) contractFailures.push(`view contract: ${text}`);
console.log(`contract defer failures: ${contractFailures.length}`);
for (const f of contractFailures) console.log(f);
