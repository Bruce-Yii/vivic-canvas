import { useVivicState } from "@/state/canvasStore";
export const TargetBadge = ({ cardId }: { cardId: string }) => {
  const choice = useVivicState(state => state.targetChoice);
  const cards = useVivicState(state => state.cards);
  if (!choice || choice.targets.some(id => !cards.some(c => c.record.id === id && !c.exitingRequestId))) return null;
  const index = choice.targets.indexOf(cardId);
  return index < 0 ? null : <span className="vivic-target-badge" data-vivic-target-number={index + 1} data-target-card-id={cardId} aria-label={`${index + 1}号卡片`}>{index + 1}</span>;
};
