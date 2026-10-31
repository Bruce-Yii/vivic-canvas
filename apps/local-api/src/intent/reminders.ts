import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Action, CountdownCard } from "@vivic/contracts";
import type { CanvasContext } from "../schemas.js";
import { stripPoliteness } from "./commandText.js";

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
const PART = `${NUMBER}\\s*(?:小时|钟头|分钟|秒钟|分|秒)`;
export const DURATION = `(?:${PART}\\s*)+`;

/** Consumes the ENTIRE duration; extra instructions can never disappear. */
export const parseDuration = (raw: string): number | null => {
  const text = raw.trim()
    .replace(/^一刻钟$/u, "15分钟")
    // "一个半小时"/"两个半钟头" mean 1.5/2.5 hours, not 0.5 hours.
    .replace(/^([一二两三四五六七八九十]|\d+)个半(小时|钟头)/u, (_match, count: string, unit: string) => `${count}${unit}30分钟`)
    .replace(/个(?=小时|钟头)/gu, "");
  if (!new RegExp(`^${DURATION}$`).test(text)) return null;
  let total = 0;
  const seen = new Set<string>();
  for (const match of text.matchAll(new RegExp(`(${NUMBER})\\s*(小时|钟头|分钟|秒钟|分|秒)`, "g"))) {
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
  const text = stripPoliteness(raw);
  if (!isReminderCreation(text) || !/提醒/.test(text)) return null;
  const clauses = text.replace(/[。！!]$/, "")
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
    // A bare 及 is a real item boundary, but a single 涉及/及时 item must keep
    // working. Defer the whole clause instead of building one compound card.
    if (seconds === null || items.some((s) => !s || s.length > 160 || containsItemBoundary(s) ||
      /和|以及|然后|如果|再|提醒|倒计时|并且|或者|还是|每天|每隔|重复|不要|别|不用|取消/.test(s))) return null;
    reminders.push(...items.map((text) => ({ afterSeconds: seconds, text })));
  }
  return reminders.length > 0 && reminders.length <= MAX_REMINDERS ? reminders : null;
};

/** Conservative item boundary guards. A conjunction only separates two real
 * reminder items; comitative phrases ("和家人开会") and lexical words
 * ("和平", "温和", "涉及") keep their 和/及. */
const PERSON_PREFIX = ["家人", "家里", "朋友", "同事", "同学", "老师", "老板", "领导", "客户", "供应商", "团队",
  "公司", "父母", "妈妈", "爸爸", "老婆", "老公", "孩子", "儿子", "女儿", "哥哥", "姐姐", "弟弟", "妹妹",
  "爷爷", "奶奶", "阿姨", "叔叔", "我", "你", "他", "她", "它", "大家", "别人", "对方", "他人", "伙伴", "室友", "邻居"];
const HE_RIGHT_WORD = ["和平", "和谐", "和解", "和好", "和睦", "和气", "和蔼", "和服", "和尚", "和声", "和弦",
  "和风", "和煦", "和缓", "和议", "和谈", "和约", "和棋", "和数", "和面", "和稀泥", "和盘", "和衣", "和颜", "和衷"];
const HE_LEFT_WORD = ["温", "柔", "平", "缓", "总", "饱", "调", "中", "附", "迎", "随", "谦", "暖", "热", "软", "共", "还"];
const JI_RIGHT_WORD = ["及时", "及格", "及早", "及第", "及其", "及至", "及物"];
// Common words whose last character precedes 及: 涉及, 普及, 埃及, 不及, 企及...
const JI_LEFT_WORD = ["涉", "普", "波", "危", "顾", "提", "触", "以", "埃", "不", "企", "殃", "累", "料", "比", "赶", "又"];

// `phrase` starts at the connector itself, so 和平/及时 are matched whole
// rather than as a bare right-hand item ("苹果" must not be mistaken for 和平).
const splitHe = (left: string, right: string, phrase: string): boolean =>
  left.length >= 2 && right.length >= 2 &&
  !PERSON_PREFIX.some((prefix) => right.startsWith(prefix)) &&
  !HE_RIGHT_WORD.some((word) => phrase.startsWith(word)) &&
  !HE_LEFT_WORD.some((word) => left.endsWith(word));
const splitJi = (left: string, right: string, phrase: string): boolean =>
  left.length >= 2 && right.length >= 2 &&
  !JI_RIGHT_WORD.some((word) => phrase.startsWith(word)) &&
  !JI_LEFT_WORD.some((word) => left.endsWith(word));

/** A bare 及 used as a list boundary must defer rather than become one
 * compound reminder; 涉及/及时 are lexical and stay single items. */
function containsItemBoundary(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const phrase = text.slice(index);
    if (phrase.startsWith("以及")) {
      if (text.slice(0, index).trim().length >= 2 && text.slice(index + 2).trim().length >= 2) return true;
    }
    if (phrase.startsWith("及") && splitJi(text.slice(0, index).trim(), text.slice(index + 1).trim(), phrase)) return true;
  }
  return false;
}

/** Splits only explicit enumerations. Anything that could be a comitative
 * phrase, a lexical word, a condition, a negation or a second operation keeps
 * the whole clause so the caller can defer rather than guess. */
const splitEnumeratedItems = (text: string): string[] | null => {
  const items: string[] = [];
  let current = "";
  let malformed = false;
  const push = () => {
    const item = current.trim();
    if (!item) malformed = true;
    else items.push(item);
    current = "";
  };
  for (let index = 0; index < text.length; index += 1) {
    const rest = text.slice(index);
    const char = text[index]!;
    if (char === "、" || char === "，" || char === ",") { push(); continue; }
    if (rest.startsWith("还有")) {
      const left = current.trim(), right = text.slice(index + 2).trim();
      if (left.length >= 2 && right.length >= 2) { push(); index += 1; continue; }
    }
    if (rest.startsWith("以及")) {
      const left = current.trim(), right = text.slice(index + 2).trim();
      if (left.length >= 2 && right.length >= 2) { push(); index += 1; continue; }
    }
    if (rest.startsWith("及")) {
      const left = current.trim(), right = text.slice(index + 1).trim();
      if (splitJi(left, right, rest)) { push(); continue; }
    }
    if (char === "和") {
      const left = current.trim(), right = text.slice(index + 1).trim();
      if (splitHe(left, right, rest)) { push(); continue; }
    }
    current += char;
  }
  const last = current.trim();
  if (!last) malformed = true;
  else items.push(last);
  return malformed ? null : items;
};

const malformedEnumeratedItem = (item: string): boolean =>
  !item || item.length > 160 ||
  /以及|还有|然后|如果|再|提醒|倒计时|并且|或者|还是|每天|每隔|重复|不要|别|不用|取消/.test(item) ||
  /(?:以及|还有)$/.test(item) ||
  new RegExp(DURATION).test(item);

/** Item-level enumeration used to verify coverage, never to bypass the
 * single-item card contract. It is deliberately stricter than
 * parseExactReminders and stays internal to coverage/planner validation. */
export const parseEnumeratedReminders = (raw: string): Reminder[] | null => {
  const cleaned = stripPoliteness(raw);
  if (!isReminderCreation(cleaned) || !/提醒/.test(cleaned)) return null;
  const text = cleaned.replace(/[。！!]+$/, "");
  const start = new RegExp(
    `(?:(?:(?:请)?帮我|请)\\s*)?(${DURATION})\\s*(?:之后|以后|后)\\s*(?:再)?提醒我` +
    `|(?:请)?提醒我\\s*(${DURATION})\\s*(?:之后|以后|后)`, "g");
  const matches = [...text.matchAll(start)].map((match) => {
    const duration = match[1] ?? match[2] ?? "";
    const seconds = parseDuration(duration);
    return seconds === null ? null : { index: match.index!, end: match.index! + match[0].length, seconds };
  });
  if (!matches.length || matches.some((match) => !match)) return null;
  const leading = text.slice(0, matches[0]!.index).trim();
  if (leading && !/^(?:请|帮我|请帮我|在|请在|帮我在|请帮我在)$/.test(leading)) return null;
  const reminders: Reminder[] = [];
  for (const [position, match] of matches.entries()) {
    const next = matches[position + 1];
    let object = next ? text.slice(match!.end, next.index) : text.slice(match!.end);
    if (next) {
      // The next clause may be introduced by a comma plus a sequencing word.
      for (;;) {
        const before = object;
        object = object.trim().replace(/[\s，,；;、]+$/, "").replace(/(?:然后|并且|以及|还有|再|和)$/, "");
        if (object === before) break;
      }
    } else {
      object = object.trim().replace(/[\s，,；;、]+$/, "");
    }
    const items = splitEnumeratedItems(object);
    if (!items || items.some(malformedEnumeratedItem)) return null;
    reminders.push(...items.map((item) => ({ afterSeconds: match!.seconds, text: item })));
    if (reminders.length > MAX_REMINDERS) return null;
  }
  return reminders.length > 0 ? reminders : null;
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
const COVERAGE_ISSUE = "遗漏或更改了明确的提醒事项";

/** An explicit timed reminder is the only grammar R2 may lean on: without it
 * a trailing "然后..." can be the user's own next action ("现在提醒我喝水
 * 然后睡觉"), which must stay one reminder. */
const DURATION_TRIGGER = new RegExp(
  `(?:${DURATION})\\s*(?:之后|以后|后)\\s*(?:再)?提醒我|(?:请)?提醒我\\s*(?:${DURATION})\\s*(?:之后|以后|后)`);

/** The item phrase after the first "提醒我" trigger, used only by R2. */
const coveragePhrase = (text: string): { phrase: string; anchored: boolean } | null => {
  const start = text.search(/提醒我/);
  if (start < 0) return null;
  const phrase = text.slice(start + "提醒我".length).replace(/[。！!]+$/, "").trim();
  return phrase ? { phrase, anchored: DURATION_TRIGGER.test(text) } : null;
};

/** Splits an item phrase for coverage only, never to build cards. Durations
 * and repeated "提醒我" triggers are normalized away, 然后 is a sequence
 * boundary; 和/及 keep the conservative guards so 和家人开会, 涉及, 和平 and
 * 及时 stay one item. */
const coverageItems = (raw: string): string[] | null => {
  const normalized = raw
    .replace(new RegExp(`(?:${DURATION})?\\s*(?:之后|以后|后)?\\s*(?:再)?提醒我`, "g"), "、")
    .replace(new RegExp(`(?:${DURATION})\\s*(?:之后|以后|后)?`, "g"), "、")
    .replace(/然后/g, "、")
    .replace(/[、，,；;]+/g, "、")
    .replace(/(^|、)再/g, "$1")
    .replace(/^、+|、+$/g, "")
    .trim();
  return normalized ? splitEnumeratedItems(normalized) : [];
};

/** R2: when no deterministic split exists, coverage must still not lose or
 * fold an item. Each CountdownCard holds one item, so a reminder text that
 * still contains an item separator is a fold; missing items are rejected. */
const nonDeterministicCoverageIssue = (text: string, reminders: Reminder[]): string | null => {
  const found = coveragePhrase(text);
  if (!found) return null;
  const { phrase, anchored } = found;
  const enumerated = /[、，,；;]|以及|还有|和|及/.test(phrase);
  if (!enumerated && !(anchored && /然后/.test(phrase))) return null;
  const items = coverageItems(phrase);
  if (!items) return COVERAGE_ISSUE;
  if (!items.length) return null;
  for (const reminder of reminders) {
    const folded = coverageItems(reminder.text);
    if (!folded || folded.length > 1) return COVERAGE_ISSUE;
  }
  if (items.length <= 1 && reminders.length <= 1) return null;
  if (items.length !== reminders.length) return COVERAGE_ISSUE;
  if (items.some((item, index) => !compactText(item) ||
    !compactText(reminders[index]!.text).includes(compactText(item)))) return COVERAGE_ISSUE;
  return null;
};

/** Source anchors prevent invented task text and catch explicit missing items.
 * Ambiguous implicit references still require model clarification. */
export const reminderCoverageIssue = (text: string, reminders: Reminder[]): string | null => {
  if (/如果|除非|每隔|每天|重复|或者|还是|不要|不用|取消/.test(text)) return "条件、重复或否定提醒需要澄清，不能只执行部分事项";
  // Enumerated items ("喝水、吃药", "喝水和吃药") must all be covered. The
  // planner may still return several plans for one clause; it must not fold
  // distinct items into one reminder text or drop one of them.
  const exact = parseEnumeratedReminders(text) ?? parseExactReminders(text);
  if (exact && (exact.length !== reminders.length || exact.some((r, i) =>
    r.afterSeconds !== reminders[i]?.afterSeconds || r.text !== reminders[i]?.text))) return COVERAGE_ISSUE;
  // R2: both parsers refused to split. Never fall through to the substring
  // check, or one folded reminder silently swallows a second item.
  if (!exact) {
    const ambiguous = nonDeterministicCoverageIssue(text, reminders);
    if (ambiguous) return ambiguous;
  }
  const countMatch = text.match(new RegExp(`(${NUMBER})\\s*(?:件事|个提醒|项提醒|个倒计时)`));
  const count = countMatch ? chineseNumber(countMatch[1]!) : null;
  const durations = [...text.matchAll(new RegExp(DURATION, "g"))];
  if ((count !== null && count !== reminders.length) || durations.length > reminders.length) return "提醒数量不完整，请澄清而非遗漏事项";
  if (/提醒/.test(text) && reminders.some((r) => !r.text)) return "每项提醒必须包含原文事项";
  if (reminders.some((r) => r.text && !compactText(text).includes(compactText(r.text)))) return "提醒内容必须引用用户原文，不得虚构";
  return null;
};
