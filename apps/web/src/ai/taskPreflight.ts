import { ActionEnvelopeSchema, CardRecordSchema, cardFieldPolicyIssue, type ActionEnvelope, type CardRecord } from "@vivic/contracts";

/** Validate every target and merged card before allowing the transaction to start. */
export function taskPreflight(envelope: ActionEnvelope, records: readonly CardRecord[]): string | null {
  const parsed = ActionEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) return "任务操作未通过校验，原内容已保留。";
  const cards = new Map(records.map(card => [card.id, card]));
  // A delete is deferred by the reducer. Reusing that ID in the same batch
  // would replace an exiting record and break both the receipt and undo group.
  const usedIds = new Set(cards.keys());
  for (const action of parsed.data.actions) {
    if (action.type === "canvas.switch" || action.type === "canvas.create") return "请先在 Space 中切换或创建空间，再继续任务。";
    if (action.type === "card.subcard.set" || action.type === "card.subcard.delete") return "子卡片请在卡片编辑器中修改，任务不能代为编辑。";
    if (action.type === "subtitle.show" && !action.text.trim()) return "显示文字不能为空。";
    if (action.type === "card.create") {
      if (usedIds.has(action.card.id)) return "新卡片编号与已有卡片冲突。";
      usedIds.add(action.card.id);
      cards.set(action.card.id, action.card);
    } else if (action.type === "cards.delete") {
      if (action.targetIds.some(id => !cards.has(id))) return "部分删除目标已变化。";
      action.targetIds.forEach(id => cards.delete(id));
    } else if ("targetId" in action) {
      const card = cards.get(action.targetId);
      if (!card) return "目标卡片已变化或不存在。";
      if (action.type === "card.delete") cards.delete(card.id);
      else if (action.type === "card.focus" && card.layout.surface === "user") return "请先将卡片放到展示窗口，再聚焦。";
      else if (action.type === "card.highlight" && action.itemId !== undefined) {
        // Match the API's supported item highlight; arbitrary subcard/row
        // identifiers are not an additional task capability.
        if (card.type !== "TodoCard" || !card.displayProps.items.some(item => item.id === action.itemId)) return "要高亮的待办条目已变化或不存在。";
      }
      else if (action.type === "card.update") {
        const hasDisplay = Object.keys(action.displayProps ?? {}).length > 0;
        const hasSource = Object.keys(action.sourceData ?? {}).length > 0;
        if (action.variant !== undefined) {
          if (card.type !== "NoteCard") return "只有便笺支持展开或收起，其他卡片请调整尺寸。";
          if (hasDisplay || hasSource) return "展开或收起不能同时改写卡片内容。";
        } else if (!hasDisplay && !hasSource) return "没有可更新的卡片内容。";
        const merged = CardRecordSchema.safeParse({ ...card, variant: action.variant ?? card.variant,
          layout: action.variant !== undefined && action.variant !== card.variant
            ? { ...card.layout, height: action.variant === "standard" ? 192 : 128 } : card.layout,
          displayProps: { ...card.displayProps, ...action.displayProps }, sourceData: { ...card.sourceData, ...action.sourceData } });
        if (!merged.success) return "卡片修改未通过校验，原内容已保留。";
        const policyIssue = cardFieldPolicyIssue(card, merged.data);
        if (policyIssue) return policyIssue;
        cards.set(card.id, merged.data);
      }
    }
  }
  return null;
}
