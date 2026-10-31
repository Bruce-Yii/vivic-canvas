import { TodoCardSchema, type Action, type HostOperation } from "@vivic/contracts";
import type { CanvasContext } from "../schemas.js";
import { hostOperationIssue } from "../decision/hostOperations.js";
import { chineseNumber } from "./reminders.js";

/** Closed-form compatibility for the former browser-only commands. This is
 * used only when no planner is connected, never to override a rejected model
 * proposal. The task manager still requires owner execution and a receipt. */
export function offlineReference(text: string, context: CanvasContext): { actions?: Action[]; hostOperation?: HostOperation; message: string } | null {
  const input = text.trim().replace(/[。！!]$/, "");
  if (/不要|不用|别|不必|无需|然后|并且|同时|顺便|如果|解释|引用|[，,；;\n“”「」"']/u.test(input)) return null;
  const todoUpdate = input.match(/^(?:请)?(?:把|将)?(?:第([一二两三四五六七八九十\d]+)张)?待办(?:卡片)?(?:的)?第([一二两三四五六七八九十\d]+)项(?:标记为|设为|改为)?(完成|已完成|未完成|取消完成)$/);
  const todoHighlight = input.match(/^(?:请)?高亮(?:显示)?(?:第([一二两三四五六七八九十\d]+)张)?待办(?:卡片)?(?:的)?第([一二两三四五六七八九十\d]+)项$/)
    ?? input.match(/^(?:请)?(?:把|将)?(?:第([一二两三四五六七八九十\d]+)张)?待办(?:卡片)?(?:的)?第([一二两三四五六七八九十\d]+)项(?:高亮|高亮显示)$/);
  const todo = todoUpdate ?? todoHighlight;
  if (todo) {
    if ((context.totalCardCount ?? context.cards.length) > context.cards.length) return { message: "上下文不完整，不能按序号修改待办。" };
    const cards = context.cards.filter(card => card.type === "TodoCard");
    const ordinal = todo[1] ? chineseNumber(todo[1]) : cards.length === 1 ? 1 : null;
    const itemOrdinal = chineseNumber(todo[2]!);
    const card = ordinal && Number.isInteger(ordinal) ? cards[ordinal - 1] : undefined;
    const parsed = TodoCardSchema.shape.displayProps.safeParse(card?.displayProps);
    if (!card || card.contextSummary?.truncatedFields.includes("items") || !parsed.success || !itemOrdinal || !Number.isInteger(itemOrdinal) || !parsed.data.items[itemOrdinal - 1]) return { message: "请明确第几张待办及有效的第几项；未修改卡片。" };
    if (todoHighlight) return { actions: [{ type: "card.highlight", targetId: card.id, itemId: parsed.data.items[itemOrdinal - 1]!.id, durationMs: 6000 }], message: `已高亮待办第${itemOrdinal}项` };
    const done = todoUpdate![3] === "完成" || todoUpdate![3] === "已完成";
    return { actions: [{ type: "card.update", targetId: card.id, displayProps: { items: parsed.data.items.map((item, index) => index === itemOrdinal - 1 ? { ...item, done } : item) } }], message: `已将待办第${itemOrdinal}项标记为${done ? "完成" : "未完成"}` };
  }
  const match = input.match(/^(?:请)?(聚焦|放大|高亮|删除|删掉|移除|展开|收起|折叠|暂停|继续|恢复)\s*(.+)$/u);
  if (!match) return null;
  const [, verb, reference] = match;
  const ref = reference!.trim();
  const typed = ref.match(/^(?:(这张|这个|那张|那个|左边|右边|当前聚焦)(?:的)?)?(倒计时|提醒|待办|便笺|便签|笔记|卡片|卡)$/u);
  const implicit = /^(这个|那个|这张|那张|它|当前聚焦的卡片)$/u.test(ref);
  const timerName = ref.match(/^(.+?)(?:的)?(?:提醒|倒计时)$/)?.[1];
  const names = context.cards.filter(card => card.id === ref || card.aliases?.includes(ref)
    || card.displayProps.title === ref || card.sourceDataSummary.reminderText === ref
    || timerName && card.type === "CountdownCard" && (card.sourceDataSummary.reminderText === timerName || card.aliases?.includes(timerName)));
  if (!typed && !implicit && !names.length) return null;
  if ((context.totalCardCount ?? context.cards.length) > context.cards.length) return { message: "画布上下文不完整，请先聚焦目标或在卡片上直接操作。" };
  const type = typed?.[2];
  const kind = type === "倒计时" || type === "提醒" ? "CountdownCard" : type === "待办" ? "TodoCard"
    : type && ["便笺", "便签", "笔记"].includes(type) ? "NoteCard" : undefined;
  let cards = names.length ? names : context.cards.filter(card => !kind || card.type === kind);
  if (typed?.[1] === "左边" || typed?.[1] === "右边") {
    const edge = (typed[1] === "左边" ? Math.min : Math.max)(...cards.map(card => card.layout.x));
    cards = cards.filter(card => card.layout.x === edge);
  } else if (ref.startsWith("当前聚焦") || ref === "它") {
    cards = cards.filter(card => card.id === context.focusHistory.at(-1));
  }
  if (cards.length !== 1) return { message: cards.length ? "有多张匹配卡片，请选择明确的目标。" : "没有找到这张卡片，请重新选择。" };
  const card = cards[0]!;
  if (["暂停", "继续", "恢复"].includes(verb!)) {
    const hostOperation: HostOperation = { kind: verb === "暂停" ? "countdown.pause" : "countdown.resume", targetId: card.id };
    const issue = hostOperationIssue(hostOperation, context);
    return issue ? { message: issue } : { hostOperation, message: verb === "暂停" ? "已暂停提醒" : "已继续提醒" };
  }
  let action: Action;
  if (verb === "展开" || verb === "收起" || verb === "折叠") {
    if (card.type !== "NoteCard") return { message: "展开与收起只适用于便笺；查看其他卡片可以使用聚焦。" };
    action = { type: "card.update", targetId: card.id, variant: verb === "展开" ? "expanded" : "minimal" };
  } else if (verb === "高亮") action = { type: "card.highlight", targetId: card.id, durationMs: 6000 };
  else action = { type: ["删除", "删掉", "移除"].includes(verb!) ? "card.delete" : "card.focus", targetId: card.id };
  const message = action.type === "card.delete" ? "已删除卡片，可撤销" : action.type === "card.focus" ? "已聚焦卡片"
    : action.type === "card.highlight" ? "已高亮卡片" : verb === "展开" ? "已展开便笺" : "已收起便笺";
  return { actions: [...(context.stage === "STANDBY" && action.type !== "card.delete" ? [{ type: "stage.awaken" } as const] : []), action], message };
}
