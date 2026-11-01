import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { planFromToolCalls, type ToolCall } from "../src/intent/toolCalls.js";
import type { CanvasContext } from "../src/schemas.js";

/**
 * Post-process the 100-case probe: (1) normalized arg comparison, (2) host
 * contract pass over the model's real tool_calls. Local only, no network.
 */

const WORKSPACE = resolve(import.meta.dirname, "../../../../..");
const DIR = resolve(WORKSPACE, "work/tool-calling-product");
const data = JSON.parse(readFileSync(resolve(DIR, "results-100.json"), "utf8")) as {
  rows: Array<{ id: string; text: string; expected: Array<{ name: string; args: Record<string, unknown> }>;
    actual: Array<{ name: string; arguments: Record<string, unknown> }>; nameOk: boolean; argsOk: boolean;
    tags: string[]; ms: number; error?: string }>;
};

const ctx: CanvasContext = {
  canvasId: "canvas_tool_probe",
  stage: "WORKSPACE",
  viewport: { x: 0, y: 0, zoom: 1 },
  focusHistory: ["note_meeting"],
  timeZone: "Asia/Shanghai",
  cards: [
    { id: "note_meeting", type: "NoteCard", aliases: ["会议记录"], displayProps: { text: "会议记录" }, sourceDataSummary: {}, layout: { x: 0, y: 0, width: 320, height: 120 } },
    { id: "note_shopping", type: "NoteCard", aliases: ["购物便笺"], displayProps: { text: "购物便笺" }, sourceDataSummary: {}, layout: { x: 344, y: 0, width: 320, height: 120 } },
    { id: "todo_week", type: "TodoCard", aliases: ["本周待办"], displayProps: { title: "本周待办" }, sourceDataSummary: {}, layout: { x: 688, y: 0, width: 288, height: 160 } },
    { id: "countdown_tea", type: "CountdownCard", aliases: ["泡茶 5 分钟"], displayProps: {}, sourceDataSummary: {}, layout: { x: 1000, y: 0, width: 220, height: 220 } },
  ],
};

const CN: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const cn = (raw: string): number => {
  if (/^\d+$/u.test(raw)) return Number(raw);
  if (raw === "十") return 10;
  if (raw.length === 1) return CN[raw] ?? NaN;
  if (raw.length === 2 && raw[0] === "十") return 10 + (CN[raw[1]!] ?? 0);
  if (raw.length === 2 && raw[1] === "十") return (CN[raw[0]!] ?? 0) * 10;
  return NaN;
};
const clock = (raw: unknown): string => {
  const text = String(raw ?? "");
  const m = text.match(/(\d{1,2}|[零〇一二两三四五六七八九十]{1,2})\s*(?:[:：]\s*(\d{1,2})|点\s*(半|一刻|三刻|\d{1,2}|[零〇一二两三四五六七八九十]{1,2})?)?/u);
  if (!m) return text;
  let hour = cn(m[1]!);
  const tail = m[2] ?? m[3] ?? "";
  const minute = tail === "半" ? 30 : tail === "一刻" ? 15 : tail === "三刻" ? 45 : tail ? cn(tail) : 0;
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return text;
  if (/(下午|傍晚|晚上|晚间)/u.test(text) && hour < 12) hour += 12;
  return `${hour}:${minute}`;
};
const text = (raw: unknown) => String(raw ?? "").replace(/[\s，。！？、；：:,.!?;]/gu, "").replace(/^(会议结论|结论)(是|：)/u, "");
const day = (raw: unknown) => String(raw ?? "").replace(/个|星期|礼拜/gu, "").replace(/^下/u, "下");

function argsMatch(expected: { name: string; args: Record<string, unknown> }, actual: { name: string; arguments: Record<string, unknown> }): boolean {
  if (expected.name !== actual.name) return false;
  const want = expected.args ?? {};
  const got = actual.arguments ?? {};
  switch (expected.name) {
    case "create_countdown":
      return Math.abs(Number(want.minutes) - Number(got.minutes)) < 1e-6;
    case "create_todo": {
      const a = (want.items as string[]).map(text).sort();
      const b = ((got.items as string[]) ?? []).map(text).sort();
      return a.length === b.length && a.every((item, index) => item === b[index]);
    }
    case "create_note":
      return text(want.text) === text(got.text) || text(got.text).includes(text(want.text));
    case "create_weekly_plan":
      return text(want.topic).length > 0 && text(got.topic).includes(text(want.topic));
    case "create_schedule": {
      if (text(want.title) !== text(got.title)) return false;
      if (want.day !== undefined && day(want.day) !== day(got.day)) return false;
      if (want.time !== undefined && clock(want.time) !== clock(got.time)) return false;
      return true;
    }
    case "focus_card":
      return String(want.card_id ?? "") === String(got.card_id ?? "");
    case "clarify":
      return text(got.question).length > 0;
    default:
      return true;
  }
}

const rows = data.rows.map(row => {
  const nameOk = row.actual.length === row.expected.length
    && row.expected.every((want, index) => row.actual[index]?.name === want.name);
  const argsOk = nameOk && row.expected.every((want, index) => argsMatch(want, row.actual[index]!));
  return { ...row, nameOk, argsOk };
});

const contract = [] as Array<{ id: string; kind: string; issues: string[] }>;
for (const row of rows) {
  const calls: ToolCall[] = row.actual.map(call => ({ name: call.name, arguments: call.arguments }));
  const plan = await planFromToolCalls(calls, ctx);
  contract.push({ id: row.id, kind: plan.kind, issues: plan.issues });
}
const byKind = contract.reduce<Record<string, number>>((acc, item) => {
  acc[item.kind] = (acc[item.kind] ?? 0) + 1;
  return acc;
}, {});
const expectedNoCard = new Set(["chat", "clarify"]);
const misCreate = rows.filter(row => expectedNoCard.has(row.expected[0]?.name ?? "")
  && row.actual.some(call => call.name.startsWith("create_")));
const contractPass = contract.filter(item => item.kind !== "invalid").length;

const total = rows.length;
const nameOk = rows.filter(row => row.nameOk).length;
const argsOk = rows.filter(row => row.argsOk).length;
const multi = rows.filter(row => row.expected.length >= 2);
const multiOk = multi.filter(row => row.argsOk).length;

const summary = {
  total, nameOk, argsOk, multi: multi.length, multiOk,
  contractPass, contractInvalid: total - contractPass, byKind,
  misCreate: misCreate.length, misCreateIds: misCreate.map(row => row.id),
  strict: data.rows.filter(row => row.argsOk).length,
};
writeFileSync(resolve(DIR, "results-100-normalized.json"), JSON.stringify({ summary, rows: rows.map(({ id, text: input, expected, actual, nameOk, argsOk }) => ({ id, text: input, expected, actual, nameOk, argsOk })) }, null, 2));

const markdown = [
  "# 工具调用 100 条：归一化判定 + host 契约复核（本地）",
  "",
  `- 用例：${total}`,
  `- 工具序列正确：**${nameOk}/${total} = ${(nameOk / total * 100).toFixed(1)}%**`,
  `- 参数正确（归一化：中文数字/标点/时间写法）：**${argsOk}/${total} = ${(argsOk / total * 100).toFixed(1)}%**（严格口径 ${summary.strict}/${total}）`,
  `- 多卡（≥2 调用）：**${multiOk}/${multi.length}**`,
  `- host 契约通过（adapter + ActionEnvelopeSchema）：**${contractPass}/${total} = ${(contractPass / total * 100).toFixed(1)}%**`,
  `- 契约分布：${JSON.stringify(byKind)}`,
  `- 模型误建（期望 chat/clarify 却出现 create_*）：**${misCreate.length}** ${misCreate.length ? `(${misCreate.map(row => row.id).join(", ")})` : ""}`,
  "",
  "## 仍需产品拍板",
  "- `tc-074/075`「把两张卡都打开」：模型给两次 `focus_card`，adapter 现在按「一次只能聚焦一张」返回 clarify。若产品允许连续聚焦，应改 adapter 与 expected。",
  "- `tc-080`「记个便笺，然后明天交周报」：模型返回 clarify + create_todo 混批，adapter 判 invalid 并回退旧链路；这是模型边界，不是映射器 bug。",
].join("\n");
writeFileSync(resolve(DIR, "REPORT-100-final.md"), markdown);
console.log(markdown);
