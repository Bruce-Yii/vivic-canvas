import { isDateCountdown, type Action, type CardRecord } from "@/contracts";
import { newId } from "@/lib/id";
import type { VivicState } from "@/state/canvasStore";
import { resolveReference, type ResolvedCard } from "./references";
import { zhToNumber } from "./zhNumber";
import { resumeReminderSource } from "@/reminders/reminders";
import { completedCountdown } from "@/canvas/reminderPresentation";

export { zhToNumber };

/**
 * Local rules-only command parser (no LLM; validated remote planning is handled separately).
 * Chinese-first. Everything it emits is a validated Action set — never DOM
 * mutation. Destructive intent with low confidence returns `clarify` instead
 * of acting (candidates get highlighted on stage; the user picks in /control).
 */

export interface CommandContext {
  state: VivicState;
  canvasId: string;
  now?: () => number;
}

export type CommandClarifyAction = "delete" | "focus" | "highlight" | "expand" | "collapse";

export type CommandResult =
  | {
      kind: "envelope";
      actions: Action[];
      spokenText?: string;
      description: string;
    }
  | {
      kind: "clarify";
      action: CommandClarifyAction;
      candidates: ResolvedCard[];
      prompt: string;
    }
  | { kind: "undo" }
  | { kind: "redo" }
  | { kind: "unknown"; message: string };

// ---------------------------------------------------------------- zh numerals
const DURATION_TOKEN = "(\\d+(?:\\.\\d+)?|[零一二两三四五六七八九十半]+)";

const parseDurationSeconds = (text: string): number | null => {
  const minMatch = text.match(new RegExp(`${DURATION_TOKEN}\\s*分(?:钟)?`));
  const secMatch = text.match(new RegExp(`${DURATION_TOKEN}\\s*秒`));
  if (!minMatch && !secMatch) return null;
  const minutes = minMatch ? zhToNumber(minMatch[1]!) : 0;
  const seconds = secMatch ? zhToNumber(secMatch[1]!) : 0;
  if (minutes === null || seconds === null) return null;
  const total = Math.round(minutes * 60 + seconds);
  return total >= 5 && total <= 24 * 3600 ? total : null;
};

// ------------------------------------------------------------------ builders
const builtinLayout = { x: 0, y: 0, width: 264, height: 96, pinned: false };

const countdownCard = (seconds: number, now: number): CardRecord => {
  const ts = new Date(now).toISOString();
  return {
    id: newId("countdown"),
    type: "CountdownCard",
    variant: "minimal",
    displayProps: {},
    sourceData: {
      targetAt: new Date(now + seconds * 1000).toISOString(),
      startedAt: ts,
    },
    sources: [],
    layout: builtinLayout,
    metadata: { createdAt: ts, updatedAt: ts },
  };
};

const todoCard = (items: string[], now: number): CardRecord | null => {
  const cleaned = items
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, 12);
  if (cleaned.length === 0 || cleaned.some((t) => t.length > 160)) return null;
  const ts = new Date(now).toISOString();
  return {
    id: newId("todo"),
    type: "TodoCard",
    variant: "minimal",
    displayProps: {
      items: cleaned.map((text, i) => ({ id: `item-${i + 1}`, text, done: false })),
    },
    sourceData: {},
    sources: [],
    layout: { ...builtinLayout, width: 288, height: 160 },
    metadata: { createdAt: ts, updatedAt: ts },
  };
};

const withAwaken = (ctx: CommandContext, actions: Action[]): Action[] =>
  ctx.state.stage === "STANDBY"
    ? [{ type: "stage.awaken" }, ...actions]
    : actions;

/** Shared by direct commands and candidate confirmation: expansion must never become focus. */
export const clarifiedCardAction = (intent: CommandClarifyAction, card: CardRecord): Action | null => {
  if (intent === "expand" || intent === "collapse") {
    return card.type === "NoteCard" ? { type: "card.update", targetId: card.id, variant: intent === "expand" ? "expanded" : "minimal" } : null;
  }
  if (intent === "highlight") return { type: "card.highlight", targetId: card.id, durationMs: 6000 };
  return intent === "delete" ? { type: "card.delete", targetId: card.id } : { type: "card.focus", targetId: card.id };
};

// Closed single-reference grammar: a compound/negative instruction must not partially execute.
const noteReference = /^(?:(?:(?:这|那)(?:一)?(?:张|个)?|刚才(?:那(?:张|个))?|最近|左边|右边|中间|中央|第(?:[一二两三四五六七八九十]|\d+)(?:张|个))(?:的)?)?(?:便笺|便签|笔记|note)(?:卡片|卡)?$/i;
const implicitNoteReference = /^(?:(?:这|那)(?:张|个)(?:卡片|卡)?|它|刚才那个|最近那个|第(?:[一二两三四五六七八九十]|\d+)(?:张|个))$/;

// -------------------------------------------------------------------- parser
export const parseCommand = (
  rawInput: string,
  ctx: CommandContext,
): CommandResult => {
  const input = rawInput.trim().replace(/^取消(?=.+(?:提醒|倒计时)[。！!]?$)/, "删除");
  const now = ctx.now?.() ?? Date.now();
  if (!input) return { kind: "unknown", message: "请输入指令" };

  if (/^(?:请)?(?:(?:删除|删掉|移除|清空)(?:当前画布(?:上|中)?(?:的)?)?(?:所有|全部)(?:的)?卡片|清空(?:当前)?画布|把(?:当前画布(?:上|中)?(?:的)?)?(?:所有|全部)(?:的)?卡片(?:全部|都)?(?:删除|删掉|移除|清空))[。！!]?$/u.test(input)) {
    const targetIds = ctx.state.cards.filter(card => !card.exitingRequestId).map(card => card.record.id);
    return targetIds.length ? { kind: "envelope", actions: [{ type: "cards.delete", targetIds }], spokenText: `已删除当前画布的全部 ${targetIds.length} 张卡片，可撤销`, description: "删除全部卡片" }
      : { kind: "unknown", message: "当前画布已经没有卡片。" };
  }

  const todoUpdate = input.match(/^(?:请)?(?:把|将)?(?:第([一二两三四五六七八九十\d]+)张)?待办(?:卡片)?(?:的)?第([一二两三四五六七八九十\d]+)项(?:标记为|设为|改为)?(完成|已完成|未完成|取消完成)[。！!]?$/);
  if (todoUpdate) {
    const todos = ctx.state.cards.filter(c => !c.exitingRequestId && c.record.type === "TodoCard");
    const cardIndex = todoUpdate[1] ? zhToNumber(todoUpdate[1]) : todos.length === 1 ? 1 : null;
    const itemIndex = zhToNumber(todoUpdate[2]!);
    const card = cardIndex ? todos[cardIndex - 1]?.record : undefined;
    if (card?.type !== "TodoCard" || !itemIndex || !card.displayProps.items[itemIndex - 1])
      return { kind: "unknown", message: "请明确第几张待办及有效的第几项，例如「把第2张待办第1项标记为完成」。" };
    const done = todoUpdate[3] === "完成" || todoUpdate[3] === "已完成";
    return { kind: "envelope", actions: withAwaken(ctx, [{ type: "card.update", targetId: card.id,
      displayProps: { items: card.displayProps.items.map((item, index) => index === itemIndex - 1 ? { ...item, done } : item) } }]),
      spokenText: `已将待办第${itemIndex}项标记为${done ? "完成" : "未完成"}`, description: "更新待办完成状态" };
  }

  const timerState = input.match(/^(暂停|继续|恢复)(.*(?:提醒|倒计时))[。！!]?$/);
  if (timerState && !/然后|并且|同时|不要|[，,；;\n]/.test(input)) {
    const reference = timerState[2]!, timerCards = ctx.state.cards.filter(card => card.record.type === "CountdownCard" && !isDateCountdown(card.record) && !card.exitingRequestId && !completedCountdown(card));
    const name = reference.replace(/(?:的)?(?:提醒|倒计时)$/, "");
    const named = timerCards.filter(card => card.record.type === "CountdownCard" && (card.record.sourceData.reminderText === name || card.record.metadata.aliases?.includes(name)));
    const generic = /^(?:(?:这|那)(?:个|张)?|刚才(?:那个)?|最近|左边(?:的)?|右边(?:的)?|第[一二两三四五六七八九十\d]+(?:个|张)(?:的)?)?(?:提醒|倒计时)$/.test(reference);
    const resolution = named.length === 1 ? { kind: "unique" as const, card: named[0]!.record }
      : named.length || !generic ? { kind: "none" as const }
        : resolveReference(reference, { state: { ...ctx.state, cards: timerCards }, now: ctx.now });
    if (resolution.kind !== "unique" || resolution.card.type !== "CountdownCard")
      return { kind: "unknown", message: "请明确一张提醒，例如「暂停喝水提醒」；不会任意修改多个提醒。" };
    const card = resolution.card;
    return { kind: "envelope", actions: [{ type: "card.update", targetId: card.id, sourceData: timerState[1] === "暂停"
      ? { pausedAt: new Date(now).toISOString() } : card.sourceData.pausedAt ? resumeReminderSource(card, now) : {} }],
      spokenText: timerState[1] === "暂停" ? "已暂停提醒" : "已继续提醒", description: "更新提醒状态" };
  }

  const highlightTodo = input.match(/^(?:请)?高亮(?:显示)?(?:第([一二两三四五六七八九十\d]+)张)?待办(?:卡片)?(?:的)?第([一二两三四五六七八九十\d]+)项[。！!]?$/)
    ?? input.match(/^(?:请)?(?:把|将)?(?:第([一二两三四五六七八九十\d]+)张)?待办(?:卡片)?(?:的)?第([一二两三四五六七八九十\d]+)项(?:高亮|高亮显示)[。！!]?$/);
  if (highlightTodo) {
    const todos = ctx.state.cards.filter(c => !c.exitingRequestId && c.record.type === "TodoCard");
    const cardIndex = highlightTodo[1] ? zhToNumber(highlightTodo[1]) : todos.length === 1 ? 1 : null;
    const itemIndex = zhToNumber(highlightTodo[2]!);
    const card = cardIndex ? todos[cardIndex - 1]?.record : undefined;
    if (card?.type !== "TodoCard" || !itemIndex || !card.displayProps.items[itemIndex - 1]) return { kind: "unknown", message: "请明确第几张待办和第几项。" };
    return { kind: "envelope", actions: [{ type: "card.highlight", targetId: card.id, itemId: card.displayProps.items[itemIndex - 1]!.id, durationMs: 6000 }], spokenText: `已高亮待办第${itemIndex}项`, description: "高亮待办条目" };
  }

  // A reference command cannot silently execute only the first clause.
  if (/^(?:删除|删掉|删了|删|移除|去掉|放大|聚焦|高亮|选中|看一看|看下|看看|focus)/i.test(input)
    && /然后|并且|同时|顺便|接着|不要|不用|别|[，,；;\n]|再(?:删|创建|聚焦|添加|提醒|显示|恢复|放大)|并(?:删|创建|聚焦|添加|提醒)|(?:待办|倒计时|便笺|便签|卡片).*(?:和|以及|与|或者).*(?:待办|倒计时|便笺|便签|卡片)/.test(input)) {
    return { kind: "unknown", message: "请将多个操作或否定要求拆开说明；本次未执行任何部分。" };
  }

  // canvas-level views
  if (/^(?:请|帮我|请帮我)?\s*(?:(?:显示|展示|看看|看|全部显示)(?:一下)?(?:所有|全部)?(?:的)?卡片|显示全部|全部显示|看全部|适应画布|fit)[。！!]*$/i.test(input)) {
    return {
      kind: "envelope",
      actions: withAwaken(ctx, [{ type: "canvas.fit" }]),
      spokenText: "已显示全部卡片",
      description: "显示全部",
    };
  }
  if (/^(恢复原视图|恢复刚才的画面|恢复视图|退出聚焦|取消聚焦|restore)$/i.test(input)) {
    return {
      kind: "envelope",
      actions: withAwaken(ctx, [{ type: "canvas.restore" }]),
      spokenText: "已恢复原视图",
      description: "恢复原视图",
    };
  }
  if (/^(撤销|撤销删除)$/.test(input)) return { kind: "undo" };
  if (/^(重做|恢复上次撤销)$/.test(input)) return { kind: "redo" };
  if (/^唤醒$/.test(input)) {
    return {
      kind: "envelope",
      actions: [{ type: "stage.awaken" }],
      description: "唤醒",
    };
  }

  const note = input.match(/^(?:请|帮我|请帮我)?\s*(?:创建|新建|添加|记下|记|记录)(?:一?[张个条])?(?:便笺|便签|笔记)\s*[:：]\s*([\s\S]+)$/);
  if (note && note[1]!.trim().length <= 500) {
    const stamp = new Date(now).toISOString();
    return { kind: "envelope", spokenText: "已记下便笺", description: "创建便笺", actions: withAwaken(ctx, [{ type: "card.create", card: {
      id: newId("note"), type: "NoteCard", variant: "minimal", displayProps: { text: note[1]!.trim() }, sourceData: {}, sources: [],
      layout: { x: 0, y: 0, width: 320, height: 120, pinned: false }, metadata: { createdAt: stamp, updatedAt: stamp },
    } }]) };
  }

  // Note density is an explicit data action; card.focus remains camera-only.
  const prefixDensity = input.match(/^(?:请\s*)?(展开|收起|折叠)\s*(.+?)[。！!]?$/);
  const suffixDensity = input.match(/^(?:请\s*)?(?:把|将)\s*(.+?)\s*(展开|收起|折叠)[。！!]?$/);
  const density = prefixDensity ? { operation: prefixDensity[1], reference: prefixDensity[2]! }
    : suffixDensity ? { operation: suffixDensity[2], reference: suffixDensity[1]! } : null;
  if (density) {
    const operation = density.operation === "展开" ? "expand" : "collapse";
    const verb = operation === "expand" ? "展开" : "收起";
    const reference = density.reference.replace(/\s+/g, "");
    if (!noteReference.test(reference) && !implicitNoteReference.test(reference)) {
      return { kind: "unknown", message: "只支持展开或收起便笺，请完整指定一张便笺，例如「展开左边的便笺」。" };
    }
    const normalized = reference.replace(/便笺/g, "便签");
    const target = noteReference.test(reference) ? normalized : `${normalized}便签`;
    let resolution = resolveReference(target, { state: ctx.state, now: ctx.now });
    // A current focused Note can disambiguate a generic request; never choose the newest Note.
    if (resolution.kind === "ambiguous" && ctx.state.focus && !/左|右|中间|中央|第|刚才|最近/.test(reference)) {
      const focused = resolution.candidates.find(candidate => candidate.card.id === ctx.state.focus!.cardId);
      if (focused) resolution = { kind: "unique", card: focused.card, label: focused.label };
    }
    if (resolution.kind === "none") return { kind: "unknown", message: "没有找到对应的便笺，请重新指定。" };
    if (resolution.kind === "ambiguous") return {
      kind: "clarify", action: operation, candidates: resolution.candidates,
      prompt: `你想${verb}哪张便笺？`,
    };
    const action = clarifiedCardAction(operation, resolution.card);
    if (!action) return { kind: "unknown", message: "只能展开或收起便笺。" };
    return { kind: "envelope", actions: withAwaken(ctx, [action, { type: "canvas.fit" }]), spokenText: `已${verb}${resolution.label}`, description: `${verb}${resolution.label}` };
  }

  // delete by reference (checked before creates: 删掉倒计时 ≠ make one)
  const deleteMatch = input.match(/^(?:删除|删掉|删了|删|移除|去掉)\s*(.+)$/);
  if (deleteMatch) {
    const resolution = resolveReference(deleteMatch[1]!, {
      state: ctx.state,
      now: ctx.now,
    });
    if (resolution.kind === "none") {
      return {
        kind: "unknown",
        message: resolution.reason ?? "没有找到对应的卡片",
      };
    }
    if (resolution.kind === "ambiguous") {
      return {
        kind: "clarify",
        action: "delete",
        candidates: resolution.candidates,
        prompt: "你要删除哪一个？",
      };
    }
    return {
      kind: "envelope",
      actions: withAwaken(ctx, [
        { type: "card.delete", targetId: resolution.card.id },
      ]),
      spokenText: `已删除${resolution.label}`,
      description: `删除${resolution.label}`,
    };
  }

  // focus by reference
  const focusMatch = input.match(/^(?:放大|聚焦|高亮|选中|看一看|看下|看看|focus)\s*(.+)$/i);
  if (focusMatch) {
    const highlighting = /^(?:高亮|选中)/.test(input);
    const resolution = resolveReference(focusMatch[1]!, {
      state: ctx.state,
      now: ctx.now,
    });
    if (resolution.kind === "none") {
      return {
        kind: "unknown",
        message: resolution.reason ?? "没有找到对应的卡片",
      };
    }
    if (resolution.kind === "ambiguous") {
      return {
        kind: "clarify",
        action: highlighting ? "highlight" : "focus",
        candidates: resolution.candidates,
        prompt: "你想放大哪一个？",
      };
    }
    return {
      kind: "envelope",
      actions: withAwaken(ctx, [
        highlighting ? { type: "card.highlight", targetId: resolution.card.id, durationMs: 6000 } : { type: "card.focus", targetId: resolution.card.id },
      ]),
      spokenText: `已${highlighting ? "高亮" : "聚焦"}${resolution.label}`,
      description: `${highlighting ? "高亮" : "聚焦"}${resolution.label}`,
    };
  }

  // countdown: 十分钟倒计时 / 10分钟倒计时 / 倒计时 5 分 30 秒 / 创建倒计时
  const countdownMatch =
    input.match(new RegExp(`^(?:创建|新建|设|定|来一?个)?\\s*(.+?)\\s*倒计时$`)) ??
    input.match(/^倒计时\s*(.+)$/);
  if (countdownMatch) {
    const seconds = parseDurationSeconds(countdownMatch[1] ?? "");
    if (seconds) {
      const card = countdownCard(seconds, now);
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;
      const label = mins > 0 ? `${mins}分${secs > 0 ? `${secs}秒` : ""}` : `${secs}秒`;
      return {
        kind: "envelope",
        actions: withAwaken(ctx, [{ type: "card.create", card }]),
        spokenText: `${label}倒计时已就位`,
        description: `创建 ${label} 倒计时`,
      };
    }
    return { kind: "unknown", message: "没听清倒计时多久，例如「十分钟倒计时」" };
  }

  // todo: 加待办：a；b；c / 添加待办 买菜 / 待办：写报告，回邮件
  const todoMatch =
    input.match(/^(?:加|添加|新增|创建|列)(?:个|一条|几条|下)?\s*待办\s*[:：]?\s*(.+)$/) ??
    input.match(/^待办\s*[:：]\s*(.+)$/);
  if (todoMatch) {
    const items = todoMatch[1]!.split(/[;；,，、\n]+/);
    const card = todoCard(items, now);
    if (!card) {
      return { kind: "unknown", message: "待办为空或单条超过 160 字" };
    }
    const count = card.type === "TodoCard" ? card.displayProps.items.length : 0;
    return {
      kind: "envelope",
      actions: withAwaken(ctx, [{ type: "card.create", card }]),
      spokenText: `已记下 ${count} 条待办`,
      description: `创建待办（${count} 项）`,
    };
  }

  return {
    kind: "unknown",
    message:
      "当前无法连接决策服务。倒计时、待办、找卡和排布仍可使用；请检查 Control 的 AI 连接后重试这句话。",
  };
};

/** The browser already has exact targets; don't ask an LLM to rediscover them. */
export const fastLocalCommand = (text: string, ctx: CommandContext): CommandResult | null => {
  const result = parseCommand(text, ctx);
  if (result.kind === "unknown" && result.message.startsWith("没有找到") && /^(?:删除|删掉|删了|删|移除|去掉|高亮|选中|取消.+(?:提醒|倒计时))/.test(text)) return result;
  if (result.kind === "unknown" && /^(?:请)?(?:把|将)?(?:第[一二两三四五六七八九十\d]+张)?待办.*(?:完成|未完成)|^(?:暂停|继续|恢复).*(?:提醒|倒计时)/.test(text)) return result;
  if (result.kind === "undo" || result.kind === "clarify") return result;
  return result.kind === "envelope" && !result.actions.some(action => action.type === "card.create") ? result : null;
};
