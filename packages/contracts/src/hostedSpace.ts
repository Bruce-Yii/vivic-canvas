import { z } from "zod";
import { CardRecordSchema, CardVariantSchema, type CardRecord } from "./cardRecord";
import { sceneOfCard } from "./scenes";

const id = z.string().min(1).max(128);
export const HostedSpaceSummarySchema = z.strictObject({
  id, title: z.string().trim().min(1).max(120), version: z.int().min(0), updatedAt: z.iso.datetime(),
});
export const HostedReminderNoticeSchema = z.strictObject({
  id, canvasId: id, canvasTitle: z.string().min(1).max(120), cardId: id,
  text: z.string().min(1).max(160), targetAt: z.iso.datetime(), firedAt: z.iso.datetime(),
});
export const HostedSpaceSnapshotSchema = z.strictObject({
  space: HostedSpaceSummarySchema.extend({ cards: z.array(CardRecordSchema).max(1000) }),
  spaces: z.array(HostedSpaceSummarySchema), cursor: z.int().min(0),
  reminders: z.array(HostedReminderNoticeSchema).max(50),
});
export const HostedSpaceCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("note.create"), text: z.string().trim().min(1).max(500), title: z.string().trim().min(1).max(80).optional() }),
  z.strictObject({ type: z.literal("todo.create"), title: z.string().trim().min(1).max(80).optional(), items: z.array(z.string().trim().min(1).max(160)).min(1).max(30) }),
  z.strictObject({ type: z.literal("reminder.create"), text: z.string().trim().min(1).max(160), seconds: z.int().min(1).max(31536000) }),
  z.strictObject({ type: z.literal("card.update"), cardId: id, variant: CardVariantSchema.optional(),
    displayProps: z.record(z.string(), z.unknown()).optional(), sourceData: z.record(z.string(), z.unknown()).optional() }),
  z.strictObject({ type: z.literal("card.delete"), cardId: id }),
  z.strictObject({ type: z.literal("card.pin"), cardId: id, pinned: z.boolean() }),
  z.strictObject({ type: z.literal("card.move"), cardId: id, x: z.number().finite().min(-100000).max(100000), y: z.number().finite().min(-100000).max(100000) }),
  z.strictObject({ type: z.literal("card.surface"), cardId: id, surface: z.enum(["user", "display"]) }),
  z.strictObject({ type: z.literal("canvas.arrange") }),
  z.strictObject({ type: z.literal("canvas.clear") }),
  z.strictObject({ type: z.literal("canvas.rename"), title: z.string().trim().min(1).max(120) }),
  z.strictObject({ type: z.literal("history.undo") }),
  z.strictObject({ type: z.literal("history.redo") }),
]);
export const HostedSpaceCommandRequestSchema = z.strictObject({
  requestId: id, expectedVersion: z.int().min(0), command: HostedSpaceCommandSchema,
});
export const HostedSpaceReceiptSchema = z.strictObject({ requestId: id, status: z.literal("succeeded"), version: z.int().min(0) });
export type HostedSpaceSummary = z.infer<typeof HostedSpaceSummarySchema>;
export type HostedReminderNotice = z.infer<typeof HostedReminderNoticeSchema>;
export type HostedSpaceSnapshot = z.infer<typeof HostedSpaceSnapshotSchema>;
export type HostedSpaceCommand = z.infer<typeof HostedSpaceCommandSchema>;
export type HostedSpaceCommandRequest = z.infer<typeof HostedSpaceCommandRequestSchema>;
export type HostedSpaceReceipt = z.infer<typeof HostedSpaceReceiptSchema>;
export interface HostedSpaceCommandResult {
  ok: true; snapshot: HostedSpaceSnapshot; receipt: HostedSpaceReceipt; deduplicated?: boolean;
}

/** Shared conservative card bounds. Values match renderer padding 22/20px, body 16/28px and row gap 8px. */
export function hostedCardHeight(record: CardRecord): number {
  const width = Math.max(80, record.layout.width), inner = 42;
  if (sceneOfCard(record) !== null && record.type !== "TodoCard" && record.type !== "ChartCard") return Math.max(record.layout.height, 98);
  if (record.type === "CountdownCard") {
    const text = record.sourceData.reminderText, chars = Math.max(1, Math.floor((width - 168) / 18));
    return Math.max(record.layout.height, text ? inner + Math.max(56, Math.ceil(text.length / chars) * 27 + 20) : inner + Math.ceil(44 * 1.15) + 8);
  }
  if (record.type === "TodoCard") {
    const chars = Math.max(1, Math.floor((width - 112) / 16)), items = record.displayProps.items.slice(0, 5);
    const header = record.displayProps.title ? Math.max(1, Math.ceil(record.displayProps.title.length / Math.max(1, Math.floor((width - 120) / 17)))) * 23 + 20 : 0;
    return Math.max(record.layout.height, inner + header + (record.displayProps.items.length > items.length ? 28 : 0)
      + Math.max(0, items.length - 1) * 8 + items.reduce((sum, item) => sum + Math.max(1, Math.ceil(item.text.length / chars)) * 28, 0));
  }
  if (record.type === "NoteCard" && record.variant === "expanded") {
    const chars = Math.max(1, Math.floor((width - 84) / 16));
    const lines = [record.displayProps.text ?? "", ...(record.displayProps.bullets ?? [])].reduce((sum, text) =>
      sum + text.split("\n").reduce((count, line) => count + Math.max(1, Math.ceil(line.length / chars)), 0), 0);
    return Math.max(record.layout.height, inner + lines * 28 + (record.displayProps.bullets?.length ?? 0) * 8);
  }
  return Math.max(record.layout.height, record.type === "ChartCard" ? 186 + (record.displayProps.title ? 34 : 0) : record.type === "SearchResultCard" ? 122 : 98);
}
