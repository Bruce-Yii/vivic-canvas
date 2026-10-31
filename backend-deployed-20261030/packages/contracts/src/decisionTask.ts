import { z } from "zod";

const id = z.string().min(1).max(128);
/** Host-only interactions. These never expand the legacy model ActionEnvelope. */
export const HostOperationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("card.move"), targetId: id, relativeTo: id.optional(), direction: z.enum(["left", "right", "up", "down"]) }),
  z.strictObject({ kind: z.literal("card.pin"), targetId: id, pinned: z.boolean() }),
  z.strictObject({ kind: z.literal("card.surface"), targetId: id, surface: z.enum(["user", "display"]) }),
  z.strictObject({ kind: z.literal("history.undo") }),
  z.strictObject({ kind: z.literal("history.redo") }),
  z.strictObject({ kind: z.literal("ambient.control"), mode: z.enum(["soft", "vivid", "off", "warm", "cool", "reset"]) }),
  z.strictObject({ kind: z.literal("canvas.organize.preview"), sort: z.enum(["manual", "due", "created", "updated", "priority", "type", "size"]),
    direction: z.enum(["asc", "desc"]), group: z.enum(["keep", "none", "type", "priority", "date"]) }),
  z.strictObject({ kind: z.literal("canvas.arrange") }),
  z.strictObject({ kind: z.literal("countdown.pause"), targetId: id }),
  z.strictObject({ kind: z.literal("countdown.resume"), targetId: id }),
]);
export type HostOperation = z.infer<typeof HostOperationSchema>;
export const DecisionExecutionReceiptSchema = z.strictObject({
  executionId: id, status: z.enum(["succeeded", "failed"]),
  createdCardIds: z.array(id).max(12).optional(), error: z.string().max(240).optional(),
});
export type DecisionExecutionReceipt = z.infer<typeof DecisionExecutionReceiptSchema>;
export const DecisionTaskRequestSchema = z.strictObject({
  id, receipt: DecisionExecutionReceiptSchema.optional(), cancel: z.literal(true).optional(),
});
export type DecisionTaskRequest = z.infer<typeof DecisionTaskRequestSchema>;
export const DecisionTaskStatusSchema = z.strictObject({
  protocolVersion: z.literal("vivic-decision-v2"), id, step: z.int().min(0),
  status: z.enum(["awaiting_execution", "awaiting_clarification", "completed", "cancelled", "failed"]),
  executionId: id.optional(), canvasVersion: z.int().min(0).optional(),
  decision: z.enum(["native-v2", "legacy-fallback"]), reason: z.string().max(120).optional(),
  /** Numbering is frozen at the time the question was asked. */
  clarification: z.strictObject({ question: z.string().max(180), candidates: z.array(z.strictObject({ number: z.int().positive(), id, label: z.string().max(120) })).max(64) }).optional(),
});
export type DecisionTaskStatus = z.infer<typeof DecisionTaskStatusSchema>;
