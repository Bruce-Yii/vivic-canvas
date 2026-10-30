import { z } from "zod";
import { CardRecordSchema, CardVariantSchema, SubcardSchema } from "./cardRecord";

const id = z.string().min(1).max(128);

export const ActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("stage.awaken") }),
  z.strictObject({
    type: z.literal("card.create"),
    card: CardRecordSchema,
  }),
  z.strictObject({ type: z.literal("card.delete"), targetId: id }),
  z.strictObject({ type: z.literal("cards.delete"), targetIds: z.array(id).min(1).max(1000).refine(ids => new Set(ids).size === ids.length) }),
  z.strictObject({ type: z.literal("card.focus"), targetId: id }),
  z.strictObject({ type: z.literal("card.subcard.set"), targetId: id, subcard: SubcardSchema }),
  z.strictObject({ type: z.literal("card.subcard.delete"), targetId: id, subcardId: id }),
  z.strictObject({
    type: z.literal("card.highlight"),
    targetId: id,
    itemId: id.optional(),
    durationMs: z.int().min(150).max(10000).optional(),
  }),
  z.strictObject({
    type: z.literal("card.update"),
    targetId: id,
    variant: CardVariantSchema.optional(),
    displayProps: z.looseObject({}).optional(),
    sourceData: z.looseObject({}).optional(),
  }),
  z.strictObject({ type: z.literal("canvas.fit") }),
  z.strictObject({ type: z.literal("canvas.restore") }),
  z.strictObject({ type: z.literal("canvas.switch"), canvasId: id }),
  z.strictObject({
    type: z.literal("canvas.create"),
    canvasId: id,
    title: z.string().min(1).max(120),
  }),
  z.strictObject({
    type: z.literal("ambient.setPreset"),
    preset: z.enum(["grainient", "clouds", "clouds2"]),
    theme: z.enum(["auto", "light", "dark"]).optional(),
  }),
  z.strictObject({
    type: z.literal("subtitle.show"),
    text: z.string().max(120),
    priority: z.enum(["normal", "reminder"]).optional(),
    durationMs: z.int().min(300).max(12000).optional(),
  }),
  z.strictObject({ type: z.literal("subtitle.hide") }),
]);

export const ActionEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal("0.6"),
  requestId: z.string().min(1).max(128),
  canvasId: z.string().min(1).max(128),
  spokenText: z.string().max(180).optional(),
  actions: z.array(ActionSchema).min(1).max(12),
});

export type Action = z.infer<typeof ActionSchema>;
export type ActionEnvelope = z.infer<typeof ActionEnvelopeSchema>;
