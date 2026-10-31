import { randomUUID } from "node:crypto";
import type { Action, CardRecord } from "@vivic/contracts";
import type { CanvasContext } from "../schemas.js";
import { buildReminderActions, parseDuration, parseExactReminders } from "./reminders.js";

/**
 * TEMPORARY (Phase 2a): server-side mirror of the fast exact-match subset of
 * apps/web/src/commands — countdown create, todo create, awaken, canvas.fit,
 * canvas.restore. Anything richer (references, deletes, compound intent)
 * goes to the LLM planner; if Winnow lands later it slots between this and
 * the planner. Extraction into a real shared "commands" package that serves
 * both the in-browser store and this context-free variant is deferred.
 */

const newId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;

const iso = () => new Date().toISOString();

const countdownCard = (seconds: number): CardRecord => ({
  id: newId("countdown"),
  type: "CountdownCard",
  variant: "minimal",
  displayProps: {},
  sourceData: {
    targetAt: new Date(Date.now() + seconds * 1000).toISOString(),
    startedAt: iso(),
  },
  sources: [],
  layout: { x: 0, y: 0, width: 264, height: 96, pinned: false },
  metadata: { createdAt: iso(), updatedAt: iso() },
});

const todoCard = (items: string[]): CardRecord => {
  const ts = iso();
  return {
    id: newId("todo"),
    type: "TodoCard",
    variant: "minimal",
    displayProps: {
      items: items.map((text, i) => ({ id: `item-${i + 1}`, text, done: false })),
    },
    sourceData: {},
    sources: [],
    layout: { x: 0, y: 0, width: 288, height: 160, pinned: false },
    metadata: { createdAt: ts, updatedAt: ts },
  };
};

export interface RuleHit {
  actions: Action[];
  spokenText: string;
}

/** Deterministic match or null. Never guesses — null defers to the planner. */
export const matchRules = (rawText: string, ctx: CanvasContext): RuleHit | null => {
  const input = rawText.trim();
  if (!input) return null;
  const withAwaken = (actions: Action[]): Action[] =>
    ctx.stage === "STANDBY" ? [{ type: "stage.awaken" }, ...actions] : actions;

  if (/^(?:请)?(?:(?:删除|删掉|移除|清空)(?:当前画布(?:上|中)?(?:的)?)?(?:所有|全部)(?:的)?卡片|清空(?:当前)?画布|把(?:所有|全部)(?:的)?卡片(?:全部|都)?(?:删除|删掉|移除|清空))[。！!]?$/u.test(input) && ctx.cards.length) {
    return { actions: [{ type: "cards.delete", targetIds: ctx.cards.map(card => card.id) }], spokenText: "已删除当前画布全部卡片，可撤销" };
  }
  if (/^(显示全部|全部显示|看全部|适应画布|fit)$/i.test(input)) {
    return {
      actions: withAwaken([{ type: "canvas.fit" }]),
      spokenText: "已显示全部卡片",
    };
  }
  if (/^(恢复原视图|恢复刚才的画面|恢复视图|退出聚焦|取消聚焦|restore)$/i.test(input)) {
    return {
      actions: withAwaken([{ type: "canvas.restore" }]),
      spokenText: "已恢复原视图",
    };
  }
  if (/^唤醒$/.test(input)) {
    return { actions: [{ type: "stage.awaken" }], spokenText: "已唤醒" };
  }

  // Explicit literal note content needs no probabilistic IDs or timestamps.
  const note = input.match(/^(?:请|帮我|请帮我)?\s*(?:创建|新建|添加|记下|记|记录)(?:一?[张个条])?(?:便笺|便签|笔记)\s*[:：]\s*([\s\S]+)$/);
  if (note && note[1]!.trim().length <= 500) {
    const stamp = iso();
    return { spokenText: "已记下便笺", actions: withAwaken([{ type: "card.create", card: {
      id: newId("note"), type: "NoteCard", variant: "minimal", displayProps: { text: note[1]!.trim() }, sourceData: {}, sources: [],
      layout: { x: 0, y: 0, width: 320, height: 120, pinned: false }, metadata: { createdAt: stamp, updatedAt: stamp },
    } }]) };
  }

  const reminders = parseExactReminders(input);
  if (reminders) return { actions: buildReminderActions(reminders, ctx), spokenText: `已设置 ${reminders.length} 项提醒` };

  // Full-duration match keeps the ordinary countdown path offline and fast.
  const countdownMatch =
    input.match(/^(?:创建|新建|设|定|来)?\s*(?:一个|个)?\s*(.+?)\s*倒计时$/) ??
    input.match(/^倒计时\s*(.+)$/);
  if (countdownMatch) {
    const total = parseDuration(countdownMatch[1]!);
    if (total === null || total < 5) return null;
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    const label = mins > 0 ? `${mins}分${secs > 0 ? `${secs}秒` : ""}` : `${secs}秒`;
    return {
      actions: withAwaken([{ type: "card.create", card: countdownCard(total) }]),
      spokenText: `${label}倒计时已就位`,
    };
  }

  // todo: 加待办：a；b；c
  const todoMatch =
    input.match(/^(?:加|添加|新增|创建|列)(?:个|一条|几条|下)?\s*待办\s*[:：]?\s*(.+)$/) ??
    input.match(/^待办\s*[:：]\s*(.+)$/);
  if (todoMatch) {
    const items = todoMatch[1]!
      .split(/[;；,，、\n]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    if (items.length === 0 || items.length > 12 || items.some((t) => t.length > 160 || /提醒|倒计时|然后|并且|再(?:创建|删除|聚焦)/.test(t))) return null;
    return {
      actions: withAwaken([{ type: "card.create", card: todoCard(items) }]),
      spokenText: `已记下 ${items.length} 条待办`,
    };
  }

  return null;
};
