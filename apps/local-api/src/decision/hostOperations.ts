import type { HostOperation } from "@vivic/contracts";
import type { CanvasContext } from "../schemas.js";

/** Context/precondition validation; coordinate/timestamp calculation stays in the real owner. */
export function hostOperationIssue(operation: HostOperation, context: CanvasContext): string | null {
  if (operation.kind === "history.undo" || operation.kind === "history.redo" || operation.kind === "canvas.arrange" || operation.kind === "ambient.control" || operation.kind === "canvas.organize.preview") return null;
  const target = context.cards.find(card => card.id === operation.targetId);
  if (!target) return "目标卡片已不存在或尚未加载，请重新选择。";
  if (operation.kind === "card.move") {
    if (target.layout.pinned !== false) return "卡片已固定或固定状态未确认，请先解除固定后移动。";
    if (operation.relativeTo && (operation.relativeTo === target.id || !context.cards.some(card => card.id === operation.relativeTo))) return "移动参照卡片不存在或与目标相同。";
  }
  if (operation.kind === "countdown.pause" || operation.kind === "countdown.resume") {
    const source = target.sourceDataSummary;
    if (target.type !== "CountdownCard" || source.event || source.schedule || source.condition) return "只支持普通计时与一次性提醒的暂停和恢复。";
    if (typeof source.targetAt !== "string" || !Number.isFinite(Date.parse(source.targetAt))) return "计时状态尚未完整加载。";
    if (operation.kind === "countdown.resume" && !source.pausedAt) return "这个计时当前没有暂停。";
    if (operation.kind === "countdown.pause" && source.pausedAt) return "这个计时已经暂停。";
  }
  return null;
}

/** Honest closed-form compatibility rules formerly handled by the browser, never model evidence. */
export function exactHostOperation(text: string): HostOperation | null {
  const normalized = text.trim().replace(/[。！!]$/, "");
  if (/^(?:请)?(?:撤销|撤回)(?:上一步|刚才的操作|上次操作)?$/.test(normalized)) return { kind: "history.undo" };
  if (/^(?:请)?(?:重做|恢复上次撤销)(?:上一步|上次操作)?$/.test(normalized)) return { kind: "history.redo" };
  const ambient: Record<string, HostOperation & { kind: "ambient.control" }> = {
    "光柔和一点": { kind: "ambient.control", mode: "soft" }, "光效柔和一点": { kind: "ambient.control", mode: "soft" },
    "进入演示状态": { kind: "ambient.control", mode: "vivid" }, "增强光效": { kind: "ambient.control", mode: "vivid" },
    "暂停背景动画": { kind: "ambient.control", mode: "off" }, "关闭光效": { kind: "ambient.control", mode: "off" },
    "换成暖色": { kind: "ambient.control", mode: "warm" }, "换成冷色": { kind: "ambient.control", mode: "cool" },
    "恢复背景动画": { kind: "ambient.control", mode: "reset" },
  };
  if (ambient[normalized.replace(/^请/, "")]) return ambient[normalized.replace(/^请/, "")]!;
  const sort = /^(?:请)?按(截止日期|时间日期|创建时间|更新时间|优先级|类型|大小|卡片面积)(?:排序|排列|整理)(?:卡片)?$/.exec(normalized);
  if (sort) return { kind: "canvas.organize.preview", sort: ({ 截止日期: "due", 时间日期: "due", 创建时间: "created", 更新时间: "updated", 优先级: "priority", 类型: "type", 大小: "size", 卡片面积: "size" } as const)[sort[1] as "截止日期"], direction: "asc", group: "keep" };
  const group = /^(?:请)?按(类型|优先级|日期)分区$/.exec(normalized);
  if (group) return { kind: "canvas.organize.preview", sort: "manual", direction: "asc", group: group[1] === "类型" ? "type" : group[1] === "日期" ? "date" : "priority" };
  if (/^(?:请)?(?:整理布局|整理画布|重新排布卡片|重新排列卡片|自动排版)$/.test(normalized)) return { kind: "canvas.arrange" };
  return null;
}

export const HOST_OPERATION_PROMPT = `\n可使用独立宿主操作输出 {"hostOperation":operation}，与actions/cards二选一；单次只执行一项。支持：
{"kind":"card.move","targetId":"已有ID","direction":"left|right|up|down","relativeTo":"可选已有参照ID"}；固定卡不能移动，不得自动解除固定。
{"kind":"card.pin","targetId":"已有ID","pinned":true或false}；{"kind":"card.surface","targetId":"已有ID","surface":"user|display"}；
{"kind":"history.undo"} 撤销内容/布局；{"kind":"history.redo"} 重做；{"kind":"canvas.arrange"} 整理布局；
{"kind":"ambient.control","mode":"soft|vivid|off|warm|cool|reset"} 调整柔光/演示光效/暂停光效/暖色/冷色/恢复光效，仅用户明确要求时执行。
{"kind":"canvas.organize.preview","sort":"manual|due|created|updated|priority|type|size","direction":"asc|desc","group":"keep|none|type|priority|date"} 打开整理预览，用户应用后才改布局；此步骤不代表已排序。不要猜测缺失的日期/优先级。
{"kind":"countdown.pause"或"countdown.resume","targetId":"已有计时ID"} 仅普通计时/一次提醒，日期/条件/重复不支持。
聚焦、展开全文、改尺寸是三种不同操作；含糊则clarify。全局/显示全部是canvas.fit。上述宿主操作不放进ActionEnvelope，不生成坐标/时间戳，不把引用或否定当执行授权。`;
