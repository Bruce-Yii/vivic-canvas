import { CardRecordSchema, CountdownSourceDataSchema, SCENES, TodoCardSchema, NoteCardSchema, type Action } from "@vivic/contracts";
import type { CanvasContext } from "../schemas.js";

const CREATABLE = new Set(["CountdownCard", "TodoCard", "NoteCard"]);
/** Scene cards are only created through the scene builder (`cards`), never raw `actions`. */
const SCENE_ONLY = new Set<string>(SCENES.map(scene => scene.cardType).filter(type => !CREATABLE.has(type) && type !== "ChartCard"));
// Data cards are created by verified adapters, but every registered renderer
// supports safe focus/delete/highlight of an existing card.
const TARGETABLE = new Set([...CREATABLE, "SearchResultCard", "WeatherCard", "TableCard", "ChartCard", "ExtensionCard", ...SCENE_ONLY]);
/** Model edits re-validate the whole display schema; grounding is checked separately. */
const UPDATABLE_SCENE = new Set([...SCENE_ONLY, "ChartCard"]);
const displaySchemaOf = (type: string) => CardRecordSchema.options.find(option => option.shape.type.value === type)?.shape.displayProps;
type Target = Pick<CanvasContext["cards"][number], "type" | "displayProps" | "sourceDataSummary"> & { contextSummary?: { truncatedFields: string[] } };

/** Validate against the same sequential state the reducer will consume. `prebuilt`
 * holds ids of scene cards the server already built and validated this turn. */
export const actionExecutionIssue = (actions: Action[], ctx: CanvasContext, prebuilt: ReadonlySet<string> = new Set()): string | null => {
  const targets = new Map<string, Target>(ctx.cards.map((c) => [c.id, c]));
  const usedIds = new Set(targets.keys());
  for (const action of actions) {
    if (action.type === "card.subcard.set" || action.type === "card.subcard.delete") return "子卡片请通过控制端编辑并校验原行";
    if (action.type === "card.create" && prebuilt.has(action.card.id)) {
      if (usedIds.has(action.card.id)) return "新卡片 id 重复";
      usedIds.add(action.card.id);
      targets.set(action.card.id, { type: action.card.type, displayProps: action.card.displayProps, sourceDataSummary: action.card.sourceData });
    } else if (action.type === "card.create") {
      const { card } = action;
      if (SCENE_ONLY.has(card.type) || (card.type === "CountdownCard" && card.sourceData.event)) return "场景卡片必须通过 cards 输出 {scene_id, data}，不能在 actions 里直接创建";
      if (!CREATABLE.has(card.type)) return "尚未接入真实数据的卡片不能创建（Weather/Table/Chart/Search）";
      if (usedIds.has(card.id)) return "新卡片 id 重复";
      if (card.sources.length) return "没有联网数据源，不能虚构来源";
      if (card.type === "CountdownCard" && (card.sourceData.schedule || card.sourceData.condition || card.sourceData.conditionMetAt
        || card.sourceData.lastFiredAt || card.sourceData.lastDeliveredTargetAt)) return "计划提醒必须由明确规则适配器创建，通知状态由调度器管理";
      usedIds.add(card.id);
      targets.set(card.id, { type: card.type, displayProps: card.displayProps, sourceDataSummary: card.sourceData });
    } else if ("targetId" in action) {
      const target = targets.get(action.targetId);
      if (!target) return "目标卡片不存在或已删除，需澄清目标";
      if (!TARGETABLE.has(target.type)) return "目标卡片尚不可渲染";
      if (action.type === "card.delete") targets.delete(action.targetId);
      if (action.type === "card.highlight" && action.itemId) {
        const items = target.displayProps.items;
        if (target.type !== "TodoCard" || !Array.isArray(items) || !items.some((item) => item?.id === action.itemId)) {
          return "目标条目不存在";
        }
      }
      if (action.type === "card.update") {
        if (action.displayProps && target.contextSummary?.truncatedFields.some(key => Object.hasOwn(action.displayProps!, key))) return "目标字段仅有摘要，不能覆盖完整原文，请在卡片编辑器中修改";
        if (action.variant !== undefined) {
          if (target.type !== "NoteCard") return "只有便笺（NoteCard）可以更新 variant，其他卡片需澄清";
          if ((action.displayProps && Object.keys(action.displayProps).length) || (action.sourceData && Object.keys(action.sourceData).length)) {
            return "便笺展开/收起仅改变 variant，不能同时改写展示内容或原文";
          }
          // Density-only actions preserve displayProps and sourceData exactly, including full original text.
          continue;
        }
        if (UPDATABLE_SCENE.has(target.type)) {
          if (target.type === "TravelOffersCard" && (action.sourceData && Object.keys(action.sourceData).length
            || action.displayProps && Object.keys(action.displayProps).some(key => key !== "selectedIds" && key !== "notes"))) return "旅游服务结果与查询条件不能由模型改写，请重新查询";
          if (!action.displayProps || (action.sourceData && Object.keys(action.sourceData).length)) return "场景卡片只能更新 displayProps 字段";
          const display = { ...target.displayProps, ...action.displayProps };
          if (!displaySchemaOf(target.type)?.safeParse(display).success) return "更新字段不符合卡片类型";
          targets.set(action.targetId, { ...target, displayProps: display });
          continue;
        }
        if (!CREATABLE.has(target.type)) return "尚未接入真实数据的卡片不能修改数据";
        if (!action.displayProps && !action.sourceData) return "更新必须包含字段";
        // Match the reducer's shallow field merge, then revalidate the type's
        // complete display/source data, including unknown-field rejection.
        const display = { ...target.displayProps, ...action.displayProps };
        const source = { ...target.sourceDataSummary, ...action.sourceData };
        if (target.type === "CountdownCard") {
          if (action.sourceData && ["schedule", "condition", "conditionMetAt", "lastFiredAt", "lastDeliveredTargetAt"].some(key =>
            key in action.sourceData! && JSON.stringify(action.sourceData![key]) !== JSON.stringify(target.sourceDataSummary[key])))
            return "计划/通知状态不能由模型改写，请用控制端修改计划提醒";
          if (target.sourceDataSummary.schedule && action.sourceData && "targetAt" in action.sourceData) return "重复提醒请通过控制端调整或继续，不能猜测下次日期";
          if (action.sourceData && "notifiedAt" in action.sourceData && !("targetAt" in action.sourceData)) return "提醒通知状态由调度器管理";
          if (Object.keys(display).length || !CountdownSourceDataSchema.safeParse(source).success) return "倒计时字段不合法";
        } else {
          const schema = target.type === "TodoCard" ? TodoCardSchema.shape.displayProps : NoteCardSchema.shape.displayProps;
          if (!schema.safeParse(display).success || (action.sourceData && Object.keys(action.sourceData).length)) return "更新字段不符合卡片类型";
        }
        targets.set(action.targetId, { ...target, displayProps: display, sourceDataSummary: source });
      }
    } else if (!["stage.awaken", "stage.sleep", "canvas.fit", "canvas.restore"].includes(action.type)) {
      // canvas.switch/create cannot validate a target canvas with this request
      // context. Other effects are not in this planner's executable subset.
      return "动作不在当前规划器可执行范围";
    }
  }
  return null;
};

/** A batch creation must produce one camera move instead of hopping per card. */
export const normalizeBatchCamera = (actions: Action[]): Action[] => {
  const created = actions.filter((a) => a.type === "card.create");
  if (created.length <= 1) return actions;
  return [...actions.filter((a) => a.type !== "card.focus" && a.type !== "canvas.fit" && a.type !== "canvas.restore"), { type: "canvas.fit" }];
};

/** The due-time scheduler owns notification stamps. New/re-timed countdowns
 * must be eligible even if the model copied a stamp from canvas context. */
export const normalizeReminderStamps = (actions: Action[]): Action[] => actions.map((action) => {
  if (action.type === "card.create" && action.card.type === "CountdownCard") {
    const { notifiedAt: _notifiedAt, ...sourceData } = action.card.sourceData;
    return { ...action, card: { ...action.card, sourceData } };
  }
  if (action.type === "card.update" && action.sourceData && "targetAt" in action.sourceData) {
    return { ...action, sourceData: { ...action.sourceData, notifiedAt: null } };
  }
  return action;
});
