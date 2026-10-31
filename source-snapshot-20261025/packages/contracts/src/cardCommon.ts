import { z } from "zod";

/** Shapes shared by every card record, kept apart so scene cards can reuse them without a cycle. */
export const CardVariantSchema = z.enum(["minimal", "standard", "expanded"]);

export const EvidenceRefSchema = z.strictObject({
  title: z.string().max(500),
  kind: z.enum(["web", "service"]).optional(),
  url: z.string().regex(/^https?:\/\//).optional(),
  fetchedAt: z.iso.datetime(),
  provider: z.string().max(80),
  readFullPage: z.boolean(),
}).refine(value => value.kind === "service" || Boolean(value.url), "网页来源需要 URL");

export const cardId = z.string().min(1).max(128);

/** Row-bound notes are embedded in their parent, so delete/undo/export stay atomic. */
export const SubcardSchema = z.strictObject({
  id: cardId,
  itemId: cardId.optional(),
  anchor: z.string().max(128).optional(),
  text: z.string().trim().min(1).max(2000),
});
export type Subcard = z.infer<typeof SubcardSchema>;

/** Where a card lives: the shared Display canvas (default) or the user's own page. */
export const CardSurfaceSchema = z.enum(["display", "user"]);
export type CardSurface = z.infer<typeof CardSurfaceSchema>;

export const LayoutSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
  width: z.number().min(80),
  height: z.number().min(56),
  pinned: z.boolean(),
  /** Absent on every record written before the user page existed; means "display". */
  surface: CardSurfaceSchema.optional(),
  /** Where the user dropped the card on the user page (page pixels); x/y stay its canvas spot. */
  userPos: z.strictObject({ x: z.number().finite().min(-100000).max(100000), y: z.number().finite().min(-100000).max(100000) }).optional(),
});

export const MetadataSchema = z.strictObject({
  section: z.string().trim().min(1).max(60).optional(),
  priority: z.enum(["high", "normal", "low"]).optional(),
  dueDate: z.iso.date().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  aliases: z.array(z.string().max(80)).max(12).optional(),
  subcards: z.array(SubcardSchema).max(24).refine(items => new Set(items.map(item => item.id)).size === items.length).optional(),
});

export const CommonShape = {
  id: cardId,
  variant: CardVariantSchema,
  sources: z.array(EvidenceRefSchema).max(15),
  layout: LayoutSchema,
  metadata: MetadataSchema,
};

export const OpenSourceData = z.looseObject({});
