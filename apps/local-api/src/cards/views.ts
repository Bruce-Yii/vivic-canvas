import { z } from "zod";
import { ActionSchema, type Action } from "@vivic/contracts";
import { normalizeSimpleCommand } from "../intent/commandText.js";
import { awakenFor } from "./build.js";
import { defineCardContract, type CardBuildContext } from "./types.js";

const EmptySlotsSchema = z.strictObject({});

function targetAction(type: "card.focus" | "card.highlight", context: CardBuildContext): Action[] {
  const card = context.cards.find(card => card.id === context.targetId);
  if (!card) throw new Error("目标卡片不存在或尚未由程序选定");
  if (type === "card.highlight" && context.itemId !== undefined) {
    const items = card.displayProps.items;
    if (card.type !== "TodoCard" || !Array.isArray(items)
      || !items.some(item => item && typeof item === "object" && item.id === context.itemId)) {
      throw new Error("目标条目不存在或尚不支持条目高亮");
    }
  }
  const action = ActionSchema.parse({ type, targetId: card.id,
    ...(type === "card.highlight" && context.itemId !== undefined ? { itemId: context.itemId } : {}) });
  return awakenFor([action], context);
}

export const overviewContract = defineCardContract({
  id: "overview", name: "显示全部", description: "显示当前画布全部卡片，不更改布局。",
  examples: ["显示全部", "适应画布"], cardType: "none", slots: EmptySlotsSchema,
  parse: text => /^(显示全部|全部显示|看全部|适应画布|fit)$/i.test(normalizeSimpleCommand(text)) ? {} : null,
  build: (_slots, context) => awakenFor([{ type: "canvas.fit" }], context),
});

export const restoreContract = defineCardContract({
  id: "restore", name: "恢复视图", description: "恢复聚焦前的视图，不更改卡片。",
  examples: ["恢复原视图", "退出聚焦"], cardType: "none", slots: EmptySlotsSchema,
  parse: text => /^(恢复原视图|恢复刚才的画面|恢复视图|退出聚焦|取消聚焦|restore)$/i.test(normalizeSimpleCommand(text)) ? {} : null,
  build: (_slots, context) => awakenFor([{ type: "canvas.restore" }], context),
});

export const focusContract = defineCardContract({
  id: "focus", name: "聚焦卡片", description: "聚焦程序已经选定的卡片；无需填写目标编号。",
  examples: ["聚焦这张卡", "看看待办清单"], cardType: "none", slots: EmptySlotsSchema,
  build: (_slots, context) => targetAction("card.focus", context),
});

export const highlightContract = defineCardContract({
  id: "highlight", name: "高亮卡片", description: "高亮程序选定的卡片或待办条目；无需填写目标编号。",
  examples: ["高亮这张卡", "高亮第二条待办"], cardType: "none", slots: EmptySlotsSchema,
  build: (_slots, context) => targetAction("card.highlight", context),
});

export const undoContract = defineCardContract({
  id: "undo", name: "撤销", description: "由宿主撤销上一步内容或布局操作。",
  examples: ["撤销", "撤回刚才的操作"], cardType: "none", slots: EmptySlotsSchema,
  parse: text => /^(?:撤销|撤回)(?:上一步|刚才的操作|上次操作)?$/u.test(normalizeSimpleCommand(text)) ? {} : null,
  build: () => ({ hostOperation: { kind: "history.undo" } }),
});
