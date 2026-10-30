import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ActionSchema, CardVariantSchema, HostOperationSchema, SCENES, TodoCardSchema, type Action, type HostOperation } from "@vivic/contracts";
import { hostOperationIssue } from "../decision/hostOperations.js";
import { awakenFor } from "./build.js";
import { defineCardContract, type BuiltinCardContract, type CardBuildContext } from "./types.js";

const itemIndex = z.int().min(0).max(29).describe("现有待办条目的零起始索引；省略时必须由宿主提供 itemId。");
const itemText = z.string().trim().min(1).max(160);
const scalar = z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()]);
const patchKey = z.string().min(1).max(80).refine(key =>
  !/^(?:id|targetId|itemId|targetIds|itemIds|selectedIds|relativeTo|layout|metadata|sourceData|sources|__proto__|prototype|constructor|.*At|.*Timestamp|timestamp)$/i.test(key),
"不能填写编号、布局、元数据或系统时间戳");
const displayPatch = z.record(patchKey, z.union([scalar, z.array(scalar).max(30)]))
  .refine(patch => Object.keys(patch).length > 0 && Object.keys(patch).length <= 20, "填写1到20个展示字段");

const EditSlotsSchema = z.union([
  z.strictObject({ mode: z.literal("todo"), operation: z.literal("append"), text: itemText }),
  z.strictObject({ mode: z.literal("todo"), operation: z.literal("update"), itemIndex: itemIndex.optional(), text: itemText.optional(), done: z.boolean().optional() })
    .refine(slots => slots.text !== undefined || slots.done !== undefined, "条目更新必须包含 text 或 done"),
  z.strictObject({ mode: z.literal("todo"), operation: z.literal("remove"), itemIndex: itemIndex.optional() }),
  z.strictObject({ mode: z.literal("todo"), operation: z.literal("title"), title: z.string().trim().min(1).max(80) }),
  z.strictObject({ mode: z.literal("note"), text: z.string().trim().min(1).max(500) }),
  z.strictObject({ mode: z.literal("note"), bullets: z.array(z.string().trim().min(1).max(180)).min(1).max(5) }),
  z.strictObject({ mode: z.literal("note"), variant: CardVariantSchema }),
  z.strictObject({ mode: z.literal("display"), displayProps: displayPatch }),
  z.strictObject({ mode: z.literal("countdown"), operation: z.enum(["pause", "resume"]) }),
]);

const ArrangeSlotsSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("move"), direction: z.enum(["left", "right", "up", "down"]) }),
  z.strictObject({ mode: z.literal("pin"), pinned: z.boolean() }),
  z.strictObject({ mode: z.literal("surface"), surface: z.enum(["user", "display"]) }),
  z.strictObject({ mode: z.literal("arrange") }),
  z.strictObject({ mode: z.literal("organize"), sort: z.enum(["manual", "due", "created", "updated", "priority", "type", "size"]),
    direction: z.enum(["asc", "desc"]), group: z.enum(["keep", "none", "type", "priority", "date"]) }),
]);

function target(context: CardBuildContext): CardBuildContext["cards"][number] {
  const matches = context.cards.filter(card => card.id === context.targetId);
  if (!context.targetId || matches.length !== 1) throw new Error("目标卡片不存在、重复或尚未由宿主选定");
  return matches[0]!;
}

function update(context: CardBuildContext, patch: Pick<Extract<Action, { type: "card.update" }>, "displayProps" | "variant">): Action[] {
  const card = target(context);
  if (patch.displayProps && card.contextSummary?.truncatedFields.some(field => Object.hasOwn(patch.displayProps!, field))) {
    throw new Error("目标字段仅有摘要，不能覆盖完整原文");
  }
  return awakenFor([ActionSchema.parse({ type: "card.update", targetId: card.id, ...patch })], context);
}

function host(operation: HostOperation, context: CardBuildContext): { hostOperation: HostOperation } {
  const hostOperation = HostOperationSchema.parse(operation);
  const issue = hostOperationIssue(hostOperation, context);
  if (issue) throw new Error(issue);
  // Host operations remain exclusive of actions/envelopes, including during standby.
  return { hostOperation };
}

const editContract = defineCardContract({
  id: "edit", name: "编辑卡片", cardType: "none",
  description: "只编辑宿主选定的目标。todo 的 append/text、update/text或done、remove、title 操作不填写编号；itemIndex从0开始，也可省略而使用宿主itemId。note的text、bullets、variant三选一。display只允许扁平标量字段或标量数组，父层仍须校验卡片类型和事实来源。countdown只支持pause/resume宿主操作。",
  examples: ["把待办第一项标记为完成", "给待办追加买牛奶", "把便笺展开", "暂停这个倒计时"],
  slots: EditSlotsSchema,
  build(slots, context) {
    const card = target(context);
    if (slots.mode === "countdown") {
      return host({ kind: slots.operation === "pause" ? "countdown.pause" : "countdown.resume", targetId: card.id }, context);
    }
    if (slots.mode === "note") {
      if (card.type !== "NoteCard") throw new Error("目标不是便笺");
      if ("variant" in slots) return update(context, { variant: slots.variant });
      return update(context, { displayProps: "text" in slots ? { text: slots.text } : { bullets: slots.bullets } });
    }
    if (slots.mode === "display") {
      if (!SCENES.some(scene => scene.cardType === card.type) || ["TodoCard", "CountdownCard"].includes(card.type)) {
        throw new Error("此目标必须使用专用编辑操作，或尚不支持展示字段编辑");
      }
      // Do not bypass actionExecutionIssue + sceneUpdateIssue in the caller.
      return update(context, { displayProps: slots.displayProps });
    }
    if (card.type !== "TodoCard") throw new Error("目标不是待办清单");
    if (slots.operation === "title") return update(context, { displayProps: { title: slots.title } });
    if (card.contextSummary?.truncatedFields.includes("items")) throw new Error("待办条目仅有摘要，不能重建清单");
    const { items } = TodoCardSchema.shape.displayProps.parse(card.displayProps);
    if (new Set(items.map(item => item.id)).size !== items.length) throw new Error("待办条目编号重复");
    if (slots.operation === "append") {
      if (items.length >= 30) throw new Error("待办最多30项，不能追加");
      const id = `item_${randomUUID()}`;
      if (items.some(item => item.id === id)) throw new Error("新条目编号冲突");
      return update(context, { displayProps: { items: [...items, { id, text: slots.text, done: false }] } });
    }
    const hostIndex = context.itemId === undefined ? undefined : items.findIndex(item => item.id === context.itemId);
    if (hostIndex === -1 || hostIndex !== undefined && slots.itemIndex !== undefined && slots.itemIndex !== hostIndex) {
      throw new Error("宿主条目不存在或与条目索引冲突");
    }
    const index = hostIndex ?? slots.itemIndex;
    if (index === undefined || index >= items.length) throw new Error("条目尚未选定或索引越界");
    if (slots.operation === "remove") {
      if (items.length === 1) throw new Error("不能删除最后一条待办，请由宿主确认删除整张卡片");
      return update(context, { displayProps: { items: items.filter((_, i) => i !== index) } });
    }
    return update(context, { displayProps: { items: items.map((item, i) => i === index
      ? { ...item, ...(slots.text !== undefined ? { text: slots.text } : {}), ...(slots.done !== undefined ? { done: slots.done } : {}) }
      : item) } });
  },
});

const arrangeContract = defineCardContract({
  id: "arrange", name: "布局与传送", cardType: "none",
  description: "mode为move/pin/surface/arrange/organize。move只填方向，不填坐标或relativeTo；pin填pinned；surface填user/display。arrange整理全画布；organize填写sort、direction、group，只打开整理预览。目标编号只由宿主提供。",
  examples: ["把这张卡向左移动", "固定这张卡", "传送到用户页", "按截止日期排序"],
  slots: ArrangeSlotsSchema,
  build(slots, context) {
    if (slots.mode === "arrange") return host({ kind: "canvas.arrange" }, context);
    if (slots.mode === "organize") return host({ kind: "canvas.organize.preview", sort: slots.sort, direction: slots.direction, group: slots.group }, context);
    const card = target(context);
    if (slots.mode === "move") return host({ kind: "card.move", targetId: card.id, direction: slots.direction }, context);
    if (slots.mode === "pin") return host({ kind: "card.pin", targetId: card.id, pinned: slots.pinned }, context);
    return host({ kind: "card.surface", targetId: card.id, surface: slots.surface }, context);
  },
});

const deleteContract = defineCardContract({
  id: "delete", name: "删除单张卡片", cardType: "none",
  description: "slots必须为空对象。仅删除宿主已解析、已确认的单个目标，不支持清空画布或模型指定删除范围。",
  examples: ["删除这张卡", "移除选中的便笺"], slots: z.strictObject({}),
  build: (_slots, context) => awakenFor([ActionSchema.parse({ type: "card.delete", targetId: target(context).id })], context),
});

export const operationContracts: Readonly<Record<string, BuiltinCardContract>> = Object.freeze({
  edit: editContract, arrange: arrangeContract, delete: deleteContract,
});
