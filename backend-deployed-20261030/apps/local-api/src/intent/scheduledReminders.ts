import { randomUUID } from "node:crypto";
import { absoluteReminderTime, nextReminderOccurrence, relativeReminderDate, TimeZoneSchema,
  type Action, type CountdownCard, type ReminderCondition, type ReminderSchedule } from "@vivic/contracts";
import type { CanvasContext } from "../schemas.js";
import { chineseNumber, parseDuration } from "./reminders.js";

type Result = { actions?: Action[]; message: string };
const mixed = /然后|同时|并且|顺便|接着|[；;\n]|再(?:删|创建|聚焦|添加|提醒)|不要|不用/;
const number = "[零一二两三四五六七八九十\\d]+";

function clock(raw: string): string | null {
  const match = raw.trim().match(new RegExp(`^(凌晨|早上|上午|中午|下午|晚上|晚间)?\\s*(${number})(?:[:：](\\d{2})|点(?:(半)|(${number})分?)?)$`));
  if (!match) return null;
  let hour = chineseNumber(match[2]!); const minute = match[3] ? Number(match[3]) : match[4] ? 30 : match[5] ? chineseNumber(match[5]) : 0;
  if (hour === null || minute === null || hour > 23 || minute > 59) return null;
  const period = match[1] ?? "";
  if (/凌晨|早上|上午/.test(period) && hour >= 12 || /下午|晚上|晚间/.test(period) && hour === 0 || /晚上|晚间/.test(period) && hour === 12) return null;
  if (/下午|晚上|晚间/.test(period) && hour < 12) hour += 12;
  if (match[1] === "中午" && hour < 11) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function conditionTarget(reference: string, ctx: CanvasContext): ReminderCondition | null {
  if (!/^(?:第[一二两三四五六七八九十\d]+张)?(?:待办|任务|倒计时|提醒)(?:卡片)?(?:[「“"][^」”"]+[」”"])?(?:的)?(?:第[一二两三四五六七八九十\d]+项)?$/.test(reference)) return null;
  const type = /待办|任务/.test(reference) ? "TodoCard" : /倒计时|提醒/.test(reference) ? "CountdownCard" : null;
  let cards = ctx.cards.filter(card => card.type === type);
  const name = reference.match(/[「“"]([^」”"]+)[」”"]/);
  const ordinal = reference.match(/第([一二两三四五六七八九十\d]+)张/);
  if (name) cards = cards.filter(card => card.id === name[1] || card.aliases?.includes(name[1]!));
  if (ordinal) { const index = chineseNumber(ordinal[1]!); cards = index ? cards.slice(index - 1, index) : []; }
  if (cards.length !== 1) return null;
  const target = cards[0]!, item = reference.match(/第([一二两三四五六七八九十\d]+)项/);
  if (type === "TodoCard") {
    const items = target.displayProps.items;
    if (!Array.isArray(items) || !items.length) return null;
    const index = item ? chineseNumber(item[1]!) : null;
    const selected = index ? items[index - 1] : undefined;
    if (item && (!selected || typeof selected.id !== "string" || selected.done)) return null;
    if (!item && items.every(row => row?.done === true)) return null;
    return { kind: "todo.completed", cardId: target.id, ...(selected ? { itemId: selected.id } : {}), delaySeconds: 0 };
  }
  if (type === "CountdownCard" && !item && !target.sourceDataSummary.notifiedAt)
    return { kind: "countdown.completed", cardId: target.id, delaySeconds: 0 };
  return null;
}

/** Explicit schedules are built deterministically; no LLM date arithmetic. */
export function scheduledReminderIntent(text: string, ctx: CanvasContext, now = Date.now()): Result | null {
  const raw = text.trim().replace(/^(?:请帮我|帮我|请)\s*/, "").replace(/[。！!]$/, "");
  if (/^(?:删除|取消|暂停|继续|恢复|修改|把|将)/.test(raw)) return null;
  if (!/提醒/.test(raw) || !/每隔|每天|每周|工作日|明天|后天|今天|今晚|昨天|\d{4}-\d{2}-\d{2}|(?:当|如果).*(?:完成|结束)后/.test(raw)) return null;
  if (mixed.test(raw) || (raw.match(/提醒我/g)?.length ?? 0) !== 1)
    return { message: "请一次设置一项计划提醒，多个操作请分开发送；本次没有执行任何部分。" };
  const parts = raw.split("提醒我"); let when = parts[0]!.trim(), task = parts[1]!.trim();
  if (!task || task.length > 160) return { message: "请提供 1–160 字的提醒事项。" };
  let timeZone = ctx.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zoneMatch = when.match(/(?:^|\s)([A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+|UTC)(?:\s|$)/);
  if (zoneMatch) { timeZone = zoneMatch[1]!; when = when.replace(zoneMatch[0], " ").trim(); }
  const namedZones: Record<string, string> = { 北京: "Asia/Shanghai", 上海: "Asia/Shanghai", 中国: "Asia/Shanghai", 纽约: "America/New_York", 东京: "Asia/Tokyo", 伦敦: "Europe/London" };
  const named = when.match(/^(北京|上海|中国|纽约|东京|伦敦)时间\s*/);
  if (named) { timeZone = namedZones[named[1]!]!; when = when.slice(named[0].length).trim(); }
  if (!TimeZoneSchema.safeParse(timeZone).success) return { message: "请指定有效的 IANA 时区，例如 Asia/Shanghai。" };
  let targetAt: string, schedule: ReminderSchedule | undefined, condition: ReminderCondition | undefined;
  try {
    if (when.startsWith("每隔")) {
      const duration = parseDuration(when.slice(2));
      if (duration === null || duration < 5) return { message: "重复间隔须为 5 秒至 24 小时，例如「每隔30分钟提醒我喝水」。" };
      schedule = { kind: "interval", everySeconds: duration };
      targetAt = new Date(now + duration * 1000).toISOString();
    } else if (/^(每天|工作日|每周)/.test(when)) {
      const every = when.match(/^(每天|工作日|每周([一二三四五六日天1-7](?:[、,，][一二三四五六日天1-7])*))\s*(.+)$/);
      const time = every ? clock(every[3]!) : null;
      if (!every || !time) return { message: "请写明时间，例如「每天09:00提醒我喝水」「每周一、三、五下午3点提醒我休息」。" };
      const weekdays = every[1] === "工作日" ? [1, 2, 3, 4, 5] : every[2]
        ? [...new Set(every[2].split(/[、,，]/).map(day => /日|天/.test(day) ? 7 : chineseNumber(day)!))] : undefined;
      schedule = { kind: "calendar", time, timeZone, ...(weekdays ? { weekdays } : {}) };
      targetAt = nextReminderOccurrence(schedule, new Date(now).toISOString(), now);
    } else if (/^(当|如果)/.test(when)) {
      const match = when.match(/^(?:当|如果)(.+?)(?:完成|结束)后\s*(.*?)$/);
      condition = match ? conditionTarget(match[1]!.trim(), ctx) ?? undefined : undefined;
      const delay = match?.[2] ? parseDuration(match[2]) : 0;
      if (!condition || delay === null) return { message: "请明确一张尚未完成的待办（可指定第几项）或未结束的倒计时；仅支持画布内完成条件，不猜测天气等外部条件。" };
      condition.delaySeconds = delay; targetAt = new Date(now).toISOString();
    } else {
      const absolute = when.match(/^(今天|明天|后天|今晚|\d{4}-\d{2}-\d{2})\s*(.+)$/);
      const time = absolute ? clock(absolute[1] === "今晚" && !/晚上|下午|晚间/.test(absolute[2]!) ? `晚上${absolute[2]}` : absolute[2]!) : null;
      if (!absolute || !time) return { message: "请明确日期和时间，例如「明天上午9点提醒我开会」或「2026-12-01 09:30 Asia/Tokyo提醒我开会」。" };
      const date = /^\d{4}/.test(absolute[1]!) ? absolute[1]! : relativeReminderDate(absolute[1] === "明天" ? 1 : absolute[1] === "后天" ? 2 : 0, now, timeZone);
      targetAt = absoluteReminderTime(date, time, timeZone);
      if (Date.parse(targetAt) <= now || Date.parse(targetAt) - now > 366 * 86400000) return { message: "请提供未来一年内尚未过去的明确提醒时间。" };
    }
  } catch { return { message: "日期/时间无效，或处在夏令时重复/不存在的时段；请改用明确、唯一的当地时间和时区。" }; }
  const stamp = new Date(now).toISOString();
  const card: CountdownCard = { id: `countdown_${randomUUID()}`, type: "CountdownCard", variant: "minimal", displayProps: {},
    sourceData: { targetAt, startedAt: stamp, reminderText: task, timeZone, ...(schedule ? { schedule } : {}), ...(condition ? { condition } : {}) },
    sources: [], layout: { x: 0, y: 0, width: 264, height: 96, pinned: false }, metadata: { createdAt: stamp, updatedAt: stamp } };
  return { message: condition ? "已设置条件提醒，满足后开始计时。" : schedule ? "已设置重复提醒。" : "已设置日期提醒。",
    actions: [...(ctx.stage === "STANDBY" ? [{ type: "stage.awaken" as const }] : []), { type: "card.create", card }, { type: "canvas.fit" }] };
}
