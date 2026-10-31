import { randomUUID } from "node:crypto";
import { ActionEnvelopeSchema, type Action } from "@vivic/contracts";
import type { CanvasContext } from "../schemas.js";
import type { DecisionManager } from "./manager.js";

export const DECISION_ACTIONS = ["fit", "restore", "focus", "delete", "expand", "collapse", "other"] as const;
export function acceptedDecision(text: string, probabilities: number[]): typeof DECISION_ACTIONS[number] | null {
  // Never execute destructive, negative, quoted or compound model decisions.
  if (/不|别|没|无须|如果|然后|并且|同时|顺便|再|先|和|以及|或者|也要|还要|文档里|例如|例子|引用|什么意思|解释|忽略|删除|删掉|移除|取消|\bnot\b|\bnever\b|[；;\n「」“”"']/i.test(text)) return null;
  const ranked = probabilities.map((p, index) => ({ p, index })).sort((a, b) => b.p - a.p);
  if (ranked.length !== 7 || ranked.some(row => !Number.isFinite(row.p) || row.p < 0 || row.p > 1)
    || Math.abs(probabilities.reduce((a, b) => a + b, 0) - 1) > .01
    || ranked[0]!.p < .8 || ranked[0]!.p - ranked[1]!.p < .25) return null;
  const action = DECISION_ACTIONS[ranked[0]!.index]!;
  if (action === "delete" || action === "other") return null;
  const vocabulary = { fit: /卡片|画布|一屏|全景|全局|整体|全部|所有/, restore: /恢复|原|之前|返回|退出|退回|回到|焦点/,
    focus: /看|放大|聚焦|关注|拉近|突出|重点/, expand: /展|全部|完整|全文|铺|细节|更多|摊|内容/, collapse: /收|简|缩|概要|叠|折|少|紧凑/ };
  return vocabulary[action].test(text) ? action : null;
}
export async function localDecisionIntent(text: string, ctx: CanvasContext, manager: Pick<DecisionManager, "score">, signal?: AbortSignal) {
  if (/第|上边|下边|中间|中央/.test(text)) return null;
  const probabilities = await manager.score(text, signal);
  if (!probabilities || signal?.aborted) return null;
  const decision = acceptedDecision(text, probabilities); if (!decision) return null;
  let actions: Action[], message: string;
  if (decision === "fit" || decision === "restore") {
    actions = [{ type: decision === "fit" ? "canvas.fit" : "canvas.restore" }]; message = decision === "fit" ? "已显示全部卡片" : "已恢复原视图";
  } else {
    let cards = ctx.cards.filter(card => decision === "expand" || decision === "collapse" ? card.type === "NoteCard"
      : /待办|任务/.test(text) ? card.type === "TodoCard" : /便笺|便签|笔记/.test(text) ? card.type === "NoteCard"
        : /倒计时|提醒/.test(text) ? card.type === "CountdownCard" : true);
    if (/左|右/.test(text) && cards.length) {
      const edge = /左/.test(text) ? Math.min(...cards.map(c => c.layout.x)) : Math.max(...cards.map(c => c.layout.x)); cards = cards.filter(c => c.layout.x === edge);
    } else if (/刚才|这张|那张|它/.test(text) && cards.length > 1) cards = cards.filter(c => c.id === ctx.focusHistory.at(-1));
    if (cards.length !== 1 || /全部|所有|一起/.test(text)) return { kind: "clarify" as const, usedProvider: "decision" as const, message: "请明确一张目标卡片，例如「聚焦左边的待办」；本地决策不会猜测歧义目标。" };
    actions = decision === "focus" ? [{ type: "card.focus", targetId: cards[0]!.id }]
      : [{ type: "card.update", targetId: cards[0]!.id, variant: decision === "expand" ? "expanded" : "minimal" }, { type: "canvas.fit" }];
    message = decision === "focus" ? "已聚焦卡片" : decision === "expand" ? "已展开便笺" : "已收起便笺";
  }
  return { kind: "envelope" as const, usedProvider: "decision" as const, envelope: ActionEnvelopeSchema.parse({ schemaVersion: "0.6", canvasId: ctx.canvasId,
    requestId: `decision_${randomUUID()}`, spokenText: message, actions: [...(ctx.stage === "STANDBY" ? [{ type: "stage.awaken" }] : []), ...actions] }) };
}
