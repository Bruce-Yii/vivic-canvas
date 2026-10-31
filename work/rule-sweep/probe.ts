import { matchRules } from "../../apps/local-api/src/intent/rules.js";
import { countdownContract } from "../../apps/local-api/src/cards/countdown.js";
import { todoContract } from "../../apps/local-api/src/cards/todo.js";
import { noteContract } from "../../apps/local-api/src/cards/note.js";
import { overviewContract, restoreContract } from "../../apps/local-api/src/cards/views.js";
import type { CardBuildContext } from "../../apps/local-api/src/cards/types.js";

const ctx: CardBuildContext = { canvasId: "probe", stage: "WORKSPACE", viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], cards: [] };

const prefixes = ["", "帮我", "请", "请帮我", "给我", "请给我", "麻烦", "麻烦帮我"];
const verbs = ["", "创建", "新建", "设", "设置", "定", "来", "搞", "弄", "建", "加", "添加"];
const quantifiers = ["", "一个", "个"];
const durations = ["30分钟", "三十分钟", "半小时", "1小时30分钟", "90秒", "一个半小时"];
const punctuation = ["", "。", "！", "!", " ", "  "];

const countdown: string[] = [];
for (const dur of durations) for (const p of punctuation) {
  countdown.push(`${dur}倒计时${p}`, `倒计时${dur}${p}`, `${dur}的倒计时${p}`, `倒计时 ${dur}${p}`);
}
for (const p of prefixes) for (const dur of durations) {
  countdown.push(`${p}倒计时${dur}`, `${p}倒计时 ${dur}`, `${p}倒计时${dur}。`);
}
for (const p of prefixes) for (const v of verbs) for (const q of quantifiers) {
  countdown.push(`${p}${v}${q}30分钟倒计时`, `${p}${v}${q}倒计时30分钟`, `${p}${v}${q}30分钟的倒计时`);
}

const uniq = (xs: string[]) => [...new Set(xs)];
const cd = uniq(countdown);
const failures: Array<{ text: string; rules: string; contract: string }> = [];
for (const text of cd) {
  const rules = matchRules(text, { canvasId: "probe", stage: "WORKSPACE", viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], cards: [] });
  const contract = countdownContract.parse!(text, ctx);
  if (!rules || !contract) failures.push({ text, rules: rules ? "hit" : "-", contract: contract ? "hit" : "-" });
}
console.log(`countdown variants: ${cd.length}; misses: ${failures.length}`);
for (const f of failures.slice(0, 120)) console.log(JSON.stringify(f));

const todoCases = uniq([
  ...prefixes.flatMap(p => ["加", "添加", "新增", "创建", "新建", "列", "来", "搞", "记", "写"].flatMap(v =>
    quantifiers.flatMap(q => [`${p}${v}${q}待办：买牛奶`, `${p}${v}${q}待办买牛奶`]))),
  ...["待办：买牛奶", "待办: 买牛奶", "待办：买牛奶。", "待办：买牛奶！", "待办：买牛奶；交周报", "待办：买牛奶、交周报", "待办：买牛奶\n交周报"],
]);
const todoFailures: Array<{ text: string; rules: string; contract: string }> = [];
for (const text of todoCases) {
  const rules = matchRules(text, { canvasId: "probe", stage: "WORKSPACE", viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], cards: [] });
  const contract = todoContract.parse!(text, ctx);
  if (!rules || !contract) todoFailures.push({ text, rules: rules ? "hit" : "-", contract: contract ? "hit" : "-" });
}
console.log(`\ntodo variants: ${todoCases.length}; misses: ${todoFailures.length}`);
for (const f of todoFailures.slice(0, 120)) console.log(JSON.stringify(f));

const noteCases = uniq([
  ...prefixes.flatMap(p => ["创建", "新建", "添加", "记下", "记", "记录", "写", "建"].flatMap(v =>
    quantifiers.flatMap(q => [`${p}${v}${q}便签：明天交周报`, `${p}${v}${q}便签明天交周报`]))),
  "记一下明天交周报", "记下来：明天交周报", "便签：明天交周报", "笔记: 明天交周报", "帮我记个便签，内容是明天交周报",
]);
const noteFailures: Array<{ text: string; rules: string; contract: string }> = [];
for (const text of noteCases) {
  const rules = matchRules(text, { canvasId: "probe", stage: "WORKSPACE", viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], cards: [] });
  const contract = noteContract.parse!(text, ctx);
  if (!rules || !contract) noteFailures.push({ text, rules: rules ? "hit" : "-", contract: contract ? "hit" : "-" });
}
console.log(`\nnote variants: ${noteCases.length}; misses: ${noteFailures.length}`);
for (const f of noteFailures.slice(0, 80)) console.log(JSON.stringify(f));

const simpleCases = uniq([
  ...prefixes.flatMap(p => ["显示全部", "全部显示", "看全部", "适应画布", "恢复原视图", "恢复刚才的画面", "恢复视图", "退出聚焦", "取消聚焦"].flatMap(c => [`${p}${c}`, `${p}${c}。`, `${p}${c}！`])),
]);
const simpleFailures: Array<{ text: string; rules: string; contract: string }> = [];
for (const text of simpleCases) {
  const rules = matchRules(text, { canvasId: "probe", stage: "WORKSPACE", viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], cards: [] });
  const contract = overviewContract.parse!(text, ctx) ?? restoreContract.parse!(text, ctx);
  if (!rules || !contract) simpleFailures.push({ text, rules: rules ? "hit" : "-", contract: contract ? "hit" : "-" });
}
console.log(`\noverview/restore variants: ${simpleCases.length}; misses: ${simpleFailures.length}`);
for (const f of simpleFailures.slice(0, 80)) console.log(JSON.stringify(f));
