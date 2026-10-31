import { CardRecordSchema, cardTargets, sameCardTarget } from "@vivic/contracts";
import type { SubcardPreview } from "@vivic/mobile-console-prototype/protocol";

/** Resolve row anchors against today's visible content; never forward raw metadata. */
export function projectMobileSubcards(record: unknown): SubcardPreview[] {
  const parsed = CardRecordSchema.safeParse(record);
  if (!parsed.success) return [];
  const targets = cardTargets(parsed.data);
  return (parsed.data.metadata.subcards ?? []).flatMap(note => {
    const target = targets.find(item => sameCardTarget(item, note));
    return target ? [{ id: note.id, label: target.label.slice(0, 160), text: note.text }] : [];
  });
}
