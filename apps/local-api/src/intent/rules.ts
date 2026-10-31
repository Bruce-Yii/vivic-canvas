import { randomUUID } from "node:crypto";
import type { Action, CardRecord } from "@vivic/contracts";
import type { CanvasContext } from "../schemas.js";
import { buildReminderActions, parseExactReminders } from "./reminders.js";
import { parseCountdownDuration } from "../cards/countdown.js";
import { parseLiteralNoteSlots } from "../cards/note.js";
import { parseTodoSlots } from "../cards/todo.js";
import { normalizeSimpleCommand } from "./commandText.js";

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

const DELETE_ALL = new RegExp("^(?:"
  + "(?:删除|删掉|移除|清空)(?:当前)?画布(?:上|中)?(?:的)?(?:所有|全部)(?:的)?卡片"
  + "|清空(?:当前)?画布"
  + "|清空(?:所有|全部)(?:的)?卡片"
  + "|(?:删除|删掉|移除)(?:所有|全部)(?:的)?卡片"
  + "|把(?:(?:当前)?画布(?:上|中)?(?:的)?)?(?:所有|全部)?(?:的)?卡片(?:全部|都)?(?:删除|删掉|移除|清空)"
  + "|把(?:当前)?画布清空"
  + ")$", "u");
const OVERVIEW = /^(?:显示全部|全部显示|看全部|适应画布|fit)$/i;
const RESTORE = /^(?:恢复原视图|恢复刚才的画面|恢复视图|退出聚焦|取消聚焦|restore)$/i;
const AWAKEN = /^(?:唤醒|唤醒一下)$/u;

/** Deterministic match or null. Never guesses — null defers to the planner. */
export const matchRules = (rawText: string, ctx: CanvasContext): RuleHit | null => {
  const input = rawText.trim();
  if (!input) return null;
  const withAwaken = (actions: Action[]): Action[] =>
    ctx.stage === "STANDBY" ? [{ type: "stage.awaken" }, ...actions] : actions;
  // One canonical surface for the fixed-phrase commands. The same politeness
  // and sentence-final punctuation are stripped for countdown/todo/note by
  // their shared parsers below.
  const simple = normalizeSimpleCommand(input);

  if (DELETE_ALL.test(simple) && ctx.cards.length) {
    return { actions: [{ type: "cards.delete", targetIds: ctx.cards.map(card => card.id) }], spokenText: "已删除当前画布全部卡片，可撤销" };
  }
  if (OVERVIEW.test(simple)) {
    return {
      actions: withAwaken([{ type: "canvas.fit" }]),
      spokenText: "已显示全部卡片",
    };
  }
  if (RESTORE.test(simple)) {
    return {
      actions: withAwaken([{ type: "canvas.restore" }]),
      spokenText: "已恢复原视图",
    };
  }
  if (AWAKEN.test(simple)) {
    return { actions: [{ type: "stage.awaken" }], spokenText: "已唤醒" };
  }

  // The todo contract owns the literal list guards; the fast path only builds
  // the same items into a minimal card. This prevents a second operation
  // ("加待办：买牛奶；显示全部") from being swallowed as an item. It runs
  // before the note parser so "记录待办：…" stays a todo, not note text.
  const todo = parseTodoSlots(input);
  if (todo) {
    return {
      actions: withAwaken([{ type: "card.create", card: todoCard(todo.items) }]),
      spokenText: `已记下 ${todo.items.length} 条待办`,
    };
  }

  // Explicit literal note content needs no probabilistic IDs or timestamps.
  // The note contract owns the literal-body guards (quoted commands, trailing
  // operations); reusing it keeps this fast path and the decision path aligned.
  const note = parseLiteralNoteSlots(input);
  if (note && "text" in note) {
    const stamp = iso();
    return { spokenText: "已记下便笺", actions: withAwaken([{ type: "card.create", card: {
      id: newId("note"), type: "NoteCard", variant: "minimal", displayProps: { text: note.text }, sourceData: {}, sources: [],
      layout: { x: 0, y: 0, width: 320, height: 120, pinned: false }, metadata: { createdAt: stamp, updatedAt: stamp },
    } }]) };
  }

  const reminders = parseExactReminders(input);
  if (reminders) return { actions: buildReminderActions(reminders, ctx), spokenText: `已设置 ${reminders.length} 项提醒` };

  // One duration grammar shared with the decision-path countdown contract:
  // both orders ("30分钟倒计时" / "倒计时30分钟"), polite prefixes, creation
  // verbs, measure words, "的" and trailing punctuation.
  const seconds = parseCountdownDuration(input);
  if (seconds !== null) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    const label = mins > 0 ? `${mins}分${secs > 0 ? `${secs}秒` : ""}` : `${secs}秒`;
    return {
      actions: withAwaken([{ type: "card.create", card: countdownCard(seconds) }]),
      spokenText: `${label}倒计时已就位`,
    };
  }

  return null;
};
