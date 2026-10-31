import { z } from "zod";
import { CardRecordSchema } from "@vivic/contracts";
import { buildReminderActions, parseDuration, parseExactReminders } from "../intent/reminders.js";
import { newCardLayout } from "./build.js";
import { defineCardContract } from "./types.js";

export const CountdownSlotsSchema = z.strictObject({
  seconds: z.int().min(1).max(86_400),
  text: z.string().trim().max(160).optional(),
});

export const countdownContract = defineCardContract({
  id: "countdown",
  name: "倒计时与一次性提醒",
  description: "普通秒、分钟、小时的计时器或番茄钟。seconds为时长秒数；text仅在用户给出事项时填写，否则省略或空字符串，不要追问事项。生日/考试等日期倒数使用generate的日期场景。时间与通知状态由程序生成。",
  examples: ["倒计时五十分钟", "设一个5分钟倒计时", "十分钟后提醒我喝水"],
  cardType: "CountdownCard",
  slots: CountdownSlotsSchema,
  parse(text) {
    // The legacy reminder extractor can treat these suffixes as reminder text.
    // Defer the whole request rather than swallowing another action/condition.
    if (/顺便|同时|接着|另外|随后|要是|除非|假如|否则|并(?:打开|关闭|创建|新建|添加|设|删除|显示|恢复|保存)/.test(text)) return null;
    const reminders = parseExactReminders(text);
    if (reminders) {
      // A single slots object cannot represent multiple reminders without loss.
      if (reminders.length !== 1) return null;
      return { seconds: reminders[0]!.afterSeconds, text: reminders[0]!.text };
    }
    const input = text.trim();
    const match = input.match(/^(?:创建|新建|设|定|来)?\s*(?:一个|个)?\s*(.+?)\s*倒计时$/)
      ?? input.match(/^倒计时\s*(.+)$/);
    const seconds = match ? parseDuration(match[1]!) : null;
    return seconds === null ? null : { seconds };
  },
  build(slots, context, now) {
    const stamp = now.toISOString();
    return buildReminderActions([{ afterSeconds: slots.seconds, text: slots.text ?? "" }], context).map(action => {
      if (action.type !== "card.create" || action.card.type !== "CountdownCard") return action;
      return { ...action, card: CardRecordSchema.parse({
        ...action.card,
        sourceData: {
          targetAt: new Date(now.getTime() + slots.seconds * 1000).toISOString(),
          startedAt: stamp,
          ...(slots.text ? { reminderText: slots.text } : {}),
        },
        layout: newCardLayout(action.card.layout.width, action.card.layout.height, context),
        metadata: { createdAt: stamp, updatedAt: stamp },
      }) };
    });
  },
});
