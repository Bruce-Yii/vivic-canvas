import { z } from "zod";
import { CardRecordSchema } from "@vivic/contracts";
import { buildReminderActions, MAX_REMINDERS, parseDuration, parseEnumeratedReminders, parseExactReminders } from "../intent/reminders.js";
import { COUNTDOWN_VERBS, stripPoliteness, stripRequestFrame, trimTerminalPunctuation } from "../intent/commandText.js";
import { newCardLayout } from "./build.js";
import { defineCardContract } from "./types.js";

const text = z.string().trim().max(160).optional();
/** One item of an explicitly enumerated reminder sentence. */
export const CountdownReminderSchema = z.strictObject({
  afterSeconds: z.int().min(1).max(86_400),
  text: z.string().trim().min(1).max(160),
});
export const CountdownSlotsSchema = z.union([
  z.strictObject({ seconds: z.int().min(1).max(86_400), text }),
  // "五分钟后提醒我喝水和吃药" names two items in one clause. The deterministic
  // grammar splits them so the host builds one card per item without the model
  // folding (or dropping) an item; R2 coverage stays the guard for model plans.
  z.strictObject({ reminders: z.array(CountdownReminderSchema).min(2).max(MAX_REMINDERS) }),
]);

/**
 * One duration grammar for both the legacy fast rules and the decision-path
 * contract. Accepts both word orders, optional politeness/creation verbs and
 * measure words, a "的" before 倒计时, and sentence-final punctuation.
 */
export const parseCountdownDuration = (source: string): number | null => {
  const input = trimTerminalPunctuation(stripPoliteness(source));
  const { rest } = stripRequestFrame(input, COUNTDOWN_VERBS);
  const match = rest.match(/^(.+?)\s*的?\s*倒计时$/u) ?? rest.match(/^倒计时\s*(.+)$/u);
  if (!match) return null;
  return parseDuration(match[1]!.trim());
};

export const countdownContract = defineCardContract({
  id: "countdown",
  name: "倒计时与一次性提醒",
  description: "普通秒、分钟、小时的计时器或番茄钟。seconds为时长秒数；text仅在用户给出事项时填写，否则省略或空字符串，不要追问事项。用户在一句里明确列出多个提醒事项时，用reminders为每项建一张卡。生日/考试等日期倒数使用generate的日期场景。时间与通知状态由程序生成。",
  examples: ["倒计时五十分钟", "设一个5分钟倒计时", "十分钟后提醒我喝水", "五分钟后提醒我喝水和吃药"],
  cardType: "CountdownCard",
  slots: CountdownSlotsSchema,
  parse(source) {
    // The legacy reminder extractor can treat these suffixes as reminder text.
    // Defer the whole request rather than swallowing another action/condition.
    if (/顺便|同时|接着|另外|随后|要是|除非|假如|否则|并(?:打开|关闭|创建|新建|添加|设|删除|显示|恢复|保存)/.test(source)) return null;
    // Several triggers ("5分钟后…，10分钟后…") are separate clauses; this
    // single-clause grammar must not swallow them into one contract.
    if ((source.match(/提醒我/g)?.length ?? 0) > 1) return null;
    // Explicit item enumerations are deterministic: one reminder per item.
    const enumerated = parseEnumeratedReminders(source);
    if (enumerated && enumerated.length > 1) return { reminders: enumerated };
    const reminders = parseExactReminders(source);
    if (reminders) {
      // A single slots object cannot represent multiple reminders without loss.
      if (reminders.length !== 1) return null;
      return { seconds: reminders[0]!.afterSeconds, text: reminders[0]!.text };
    }
    const seconds = parseCountdownDuration(source);
    return seconds === null ? null : { seconds };
  },
  build(slots, context, now) {
    const stamp = now.toISOString();
    const reminders = "reminders" in slots ? slots.reminders : [{ afterSeconds: slots.seconds, text: slots.text ?? "" }];
    let cardIndex = 0;
    return buildReminderActions(reminders, context).map(action => {
      if (action.type !== "card.create" || action.card.type !== "CountdownCard") return action;
      const reminder = reminders[cardIndex++]!;
      return { ...action, card: CardRecordSchema.parse({
        ...action.card,
        sourceData: {
          targetAt: new Date(now.getTime() + reminder.afterSeconds * 1000).toISOString(),
          startedAt: stamp,
          ...(reminder.text ? { reminderText: reminder.text } : {}),
        },
        layout: newCardLayout(action.card.layout.width, action.card.layout.height, context),
        metadata: { createdAt: stamp, updatedAt: stamp },
      }) };
    });
  },
});
