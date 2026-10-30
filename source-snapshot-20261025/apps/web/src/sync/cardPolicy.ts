import { CARD_FIELD_POLICY, CardRecordSchema, cardFieldPolicyIssue, type ActionEnvelope, type CardRecord } from "@/contracts";

/** Preflight the complete transaction before any canvas or card mutation. */
export function envelopeCardPolicyIssue(
  envelope: ActionEnvelope,
  current: readonly CardRecord[],
  validateExtension: (card: CardRecord) => { ok: true } | { ok: false; error: string },
  authority: "user" | "provider" = "user",
): string | null {
  const originals = new Map(current.map(card => [card.id, card]));
  const cards = new Map(originals);
  for (const action of envelope.actions) {
    if (action.type === "card.create") {
      const previous = originals.get(action.card.id) ?? cards.get(action.card.id);
      if (previous && CARD_FIELD_POLICY[previous.type]) {
        const issue = cardFieldPolicyIssue(previous, action.card, authority);
        if (issue) return issue;
      }
      const valid = validateExtension(action.card);
      if (!valid.ok) return valid.error;
      cards.set(action.card.id, action.card);
    } else if (action.type === "card.update") {
      const previous = cards.get(action.targetId);
      if (!previous || !CARD_FIELD_POLICY[previous.type]) continue;
      const candidate = CardRecordSchema.safeParse({ ...previous,
        variant: action.variant ?? previous.variant,
        displayProps: action.displayProps ? { ...previous.displayProps, ...action.displayProps } : previous.displayProps,
        sourceData: action.sourceData ? { ...previous.sourceData, ...action.sourceData } : previous.sourceData,
      });
      if (!candidate.success) return "卡片修改未通过字段校验。";
      const issue = cardFieldPolicyIssue(previous, candidate.data, authority);
      if (issue) return issue;
      const valid = validateExtension(candidate.data);
      if (!valid.ok) return valid.error;
      cards.set(action.targetId, candidate.data);
    } else if (action.type === "card.delete") cards.delete(action.targetId);
    else if (action.type === "cards.delete") action.targetIds.forEach(id => cards.delete(id));
  }
  return null;
}
