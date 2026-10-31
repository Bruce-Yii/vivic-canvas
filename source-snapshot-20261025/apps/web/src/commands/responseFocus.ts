import type { Action } from "@/contracts";
import type { VivicState } from "@/state/canvasStore";
import { reminderVisible } from "@/canvas/reminderPresentation";

/** Direct user responses bring a single affected card into view. Background
 * scheduling never passes here; explicit highlight/camera instructions win. */
export function focusResponseActions(actions: Action[], state: VivicState): Action[] {
  const creates = actions.filter(a => a.type === "card.create");
  const quiet = new Set(creates.flatMap(a => a.type === "card.create" && (!reminderVisible({ record: a.card }) || a.card.type === "CountdownCard" && !a.card.sourceData.event && Boolean(a.card.sourceData.schedule || a.card.sourceData.timeZone || a.card.sourceData.condition)) ? [a.card.id] : []));
  actions = actions.filter(a => !(a.type === "card.focus" && quiet.has(a.targetId)) && !(a.type === "canvas.fit" && creates.length > 0 && creates.length === quiet.size));
  if (creates.length === 1 && quiet.size === 1) return actions;
  if (actions.length >= 12 || actions.some(a => ["card.focus", "card.highlight", "canvas.restore"].includes(a.type))) return actions;
  const affected = actions.flatMap(a => a.type === "card.create" ? [a.card.id] : a.type === "card.update" ? [a.targetId] : []);
  const ids = [...new Set(affected)];
  if (ids.length !== 1) return actions;
  const id = ids[0]!;
  const create = actions.find(a => a.type === "card.create" && a.card.id === id);
  if (!create && actions.some(a => a.type === "canvas.fit")) return actions;
  const response = create ? actions.filter(a => a.type !== "canvas.fit") : actions;
  const record = create?.type === "card.create" ? create.card : state.cards.find(c => c.record.id === id)?.record;
  if (!record || record.layout.surface === "user" || !reminderVisible({ record })) return response;
  return [...response, { type: "card.focus", targetId: id }];
}
