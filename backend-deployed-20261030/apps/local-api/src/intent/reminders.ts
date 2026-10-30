import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Action, CountdownCard } from "@vivic/contracts";
import type { CanvasContext } from "../schemas.js";

export const MAX_REMINDERS = 10; // awaken + 10 creates + fit = 12 actions
export const ReminderSchema = z.strictObject({
  afterSeconds: z.int().min(1).max(86_400),
  text: z.string().trim().max(160), // empty only for an ordinary countdown
});
export type Reminder = z.infer<typeof ReminderSchema>;
export const ReminderPlanSchema = z.union([
  z.strictObject({ reminders: z.array(ReminderSchema).min(1).max(MAX_REMINDERS) }),
  z.strictObject({ clarify: z.string().trim().min(1).max(180) }),
]);

const DIGITS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
export const chineseNumber = (text: string): number | null => {
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  if (text === "半") return 0.5;
  if (/^[零一二两三四五六七八九]$/.test(text)) return DIGITS[text]!;
  const m = text.match(/^([一二两三四五六七八九]?)十([一二三四五六七八九]?)$/);
  return m ? (m[1] ? DIGITS[m[1]]! : 1) * 10 + (m[2] ? DIGITS[m[2]]! : 0) : null;
};
const NUMBER = "(?:\\d+(?:\\.\\d+)?|[零一二两三四五六七八九十半]+)";
const PART = `${NUMBER}\\s*(?:小时|分钟|秒钟|分|秒)`;
export const DURATION = `(?:${PART}\\s*)+`;

/** Consumes the ENTIRE duration; extra instructions can never disappear. */
export const parseDuration = (raw: string): number | null => {
  const text = raw.trim().replace(/个(?=小时)/g, "");
  if (!new RegExp(`^${DURATION}$`).test(text)) return null;
  let total = 0;
  const seen = new Set<string>();
  for (const match of text.matchAll(new RegExp(`(${NUMBER})\\s*(小时|分钟|秒钟|分|秒)`, "g"))) {
    const number = chineseNumber(match[1]!);
    const unit = match[2]!.startsWith("分") ? "分" : match[2]!.startsWith("秒") ? "秒" : "小时";
    if (number === null || seen.has(unit)) return null;
    seen.add(unit);
    total += number * (unit === "小时" ? 3600 : unit === "分" ? 60 : 1);
  }
  return Number.isInteger(total) && total >= 1 && total <= 86_400 ? total : null;
};

/** Only pure creation enters the small extraction contract. Mixed operations
 * stay in the generic planner, which can clarify atomically. */
export const isReminderCreation = (text: string): boolean =>
  /提醒|倒计时/.test(text) && !/删除|删掉|取消|暂停|继续|恢复|修改|改成|改为|延长|缩短|放大|聚焦|高亮|待办|便签|笔记|显示全部|天气|搜索|查一下|查查|图表|表格/.test(text);

export const parseExactReminders = (raw: string): Reminder[] | null => {
  if (!isReminderCreation(raw) || !/提醒/.test(raw)) return null;
  const clauses = raw.trim().replace(/[。！!]$/, "")
    .split(/[，,；;\n]+|(?:然后|以及|并且|再|和)(?=\s*(?:\d|[零一二两三四五六七八九十半]))/)
    .map((s) => s.trim());
  const reminders: Reminder[] = [];
  for (const clause of clauses) {
    const m = clause.match(new RegExp(`^(?:(?:请)?帮我|请)?\\s*(${DURATION})\\s*(?:之后|以后|后)\\s*(?:再)?提醒我\\s*(.+)$`)) ??
      clause.match(new RegExp(`^(?:请)?提醒我\\s*(${DURATION})\\s*(?:之后|以后|后)\\s*(.+)$`));
    if (!m) return null;
    const seconds = parseDuration(m[1]!);
    // Only an explicit enumeration is deterministic. Conjunctions/conditions
    // can change meaning, so the model must extract or ask for clarification.
    const items = m[2]!.split("、").map((s) => s.trim());
    if (seconds === null || items.some((s) => !s || s.length > 160 || /和|以及|然后|如果|再|提醒|倒计时|并且|或者|还是|每天|每隔|重复|不要|别|不用|取消/.test(s))) return null;
    reminders.push(...items.map((text) => ({ afterSeconds: seconds, text })));
  }
  return reminders.length > 0 && reminders.length <= MAX_REMINDERS ? reminders : null;
};

export const buildReminderActions = (reminders: Reminder[], ctx: CanvasContext): Action[] => {
  const now = Date.now();
  const stamp = new Date(now).toISOString();
  const actions: Action[] = ctx.stage === "STANDBY" ? [{ type: "stage.awaken" }] : [];
  for (const [index, reminder] of reminders.entries()) {
    const card: CountdownCard = {
      id: `countdown_${randomUUID()}`, type: "CountdownCard", variant: "minimal",
      displayProps: {},
      sourceData: { targetAt: new Date(now + reminder.afterSeconds * 1000).toISOString(),
        startedAt: stamp, ...(reminder.text ? { reminderText: reminder.text } : {}) },
      sources: [],
      layout: { x: (index % 3) * 304, y: Math.floor(index / 3) * 136, width: 264, height: 96, pinned: false },
      metadata: { createdAt: stamp, updatedAt: stamp },
    };
    actions.push({ type: "card.create", card });
  }
  actions.push(reminders.length > 1 ? { type: "canvas.fit" } :
    { type: "card.focus", targetId: (actions.find((a) => a.type === "card.create") as Extract<Action, { type: "card.create" }>).card.id });
  return actions;
};

const compactText = (text: string) => text.replace(/[\s，,。；;、：:！!？?]/g, "");
/** Source anchors prevent invented task text and catch explicit missing items.
 * Ambiguous implicit references still require model clarification. */
export const reminderCoverageIssue = (text: string, reminders: Reminder[]): string | null => {
  if (/如果|除非|每隔|每天|重复|或者|还是|不要|不用|取消/.test(text)) return "条件、重复或否定提醒需要澄清，不能只执行部分事项";
  const exact = parseExactReminders(text);
  if (exact && (exact.length !== reminders.length || exact.some((r, i) =>
    r.afterSeconds !== reminders[i]?.afterSeconds || r.text !== reminders[i]?.text))) return "遗漏或更改了明确的提醒事项";
  const countMatch = text.match(new RegExp(`(${NUMBER})\\s*(?:件事|个提醒|项提醒|个倒计时)`));
  const count = countMatch ? chineseNumber(countMatch[1]!) : null;
  const durations = [...text.matchAll(new RegExp(DURATION, "g"))];
  if ((count !== null && count !== reminders.length) || durations.length > reminders.length) return "提醒数量不完整，请澄清而非遗漏事项";
  if (/提醒/.test(text) && reminders.some((r) => !r.text)) return "每项提醒必须包含原文事项";
  if (reminders.some((r) => r.text && !compactText(text).includes(compactText(r.text)))) return "提醒内容必须引用用户原文，不得虚构";
  return null;
};
