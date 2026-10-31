import { z } from "zod";
import { ActionEnvelopeSchema, VivicStateSchema } from "@/contracts";
import { ActivitySchema, CardSurfaceSchema, TargetChoiceSchema } from "@vivic/contracts";
import { DARK_PALETTE_IDS, LIGHT_PALETTE_IDS } from "@/components/atmosphere/palettes";
import { ORB_PALETTE_IDS } from "@/stage/orbPalette";

/**
 * BroadcastChannel('vivic:canvas:v1') message protocol — ARCHITECTURE §4.
 * Every message carries {type, canvasId, epoch, version, seq, requestId}.
 *  - hello: display announces presence; owner replies with snapshot
 *  - snapshot-request: display asks for full state of a canvas
 *  - snapshot: full serialized runtime state (VivicState) + title + version
 *  - patch: one validated ActionEnvelope as dispatched by the control owner
 *  - owner: ownership announcements (on/off/takeover heartbeat)
 *
 * `epoch` identifies one owner session; `seq` is a per-canvas in-epoch
 * sequence; `version` increments per applied patch on that canvas.
 */

export const SYNC_CHANNEL_NAME = "vivic:canvas:v1";

// Narrow, non-model interaction protocol; never accepts an ActionEnvelope.
export const CoordinateSchema = z.number().finite().min(-100000).max(100000);
export const LayoutBaselineSchema = z.strictObject({
  x: CoordinateSchema, y: CoordinateSchema,
  width: z.number().finite().positive(), height: z.number().finite().positive(),
  pinned: z.boolean(),
});
export const CanvasInteractionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("card.move"), cardId: z.string().min(1).max(128),
    from: LayoutBaselineSchema, x: CoordinateSchema, y: CoordinateSchema }),
  z.strictObject({ kind: z.literal("card.pin"), cardId: z.string().min(1).max(128),
    from: LayoutBaselineSchema, pinned: z.boolean() }),
  // Move a card between the Display canvas and the user page. A drop on the
  // canvas carries the drop point; without one the card is placed automatically.
  z.strictObject({ kind: z.literal("card.surface"), cardId: z.string().min(1).max(128),
    from: LayoutBaselineSchema, surface: CardSurfaceSchema, x: CoordinateSchema.optional(), y: CoordinateSchema.optional() })
    .refine(value => (value.x === undefined) === (value.y === undefined), "x 与 y 需同时提供"),
]);
export type CanvasInteraction = z.infer<typeof CanvasInteractionSchema>;
/** Narrow Display requests: canvas drags, cross-tab portals, and view controls.
 * The reader never receives pin, settings, or arbitrary ActionEnvelope authority. */
export const DisplayInteractionSchema = z.union([
  CanvasInteractionSchema.options[0],
  CanvasInteractionSchema.options[2],
  z.strictObject({ kind: z.literal("card.focus"), cardId: z.string().min(1).max(128), from: LayoutBaselineSchema }),
  z.strictObject({ kind: z.literal("canvas.fit") }),
  z.strictObject({ kind: z.literal("canvas.restore") }),
]);
export type DisplayInteraction = z.infer<typeof DisplayInteractionSchema>;
export const DisplayPreferencesSchema = z.strictObject({
  theme: z.enum(["auto", "light", "dark"]),
  reducedMotion: z.boolean(), subtitles: z.boolean(),
  ambientMotion: z.enum(["off", "subtle", "vivid"]).optional(),
  ambientIntensity: z.number().finite().min(0).max(1).optional(),
  dayStart: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional(),
  dayEnd: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional(),
  /** Background palette per appearance; absent means 午夜蓝紫 / 云朵蓝紫. The motion is fixed. */
  darkPalette: z.enum(DARK_PALETTE_IDS).optional(),
  lightPalette: z.enum(LIGHT_PALETTE_IDS).optional(),
  orbPalette: z.enum(ORB_PALETTE_IDS).optional(),
});
export type DisplayPreferences = z.infer<typeof DisplayPreferencesSchema>;
// New installs and resets follow the local daylight schedule by default.
export const DEFAULT_DISPLAY_PREFERENCES: DisplayPreferences = {
  theme: "auto", reducedMotion: false, subtitles: true,
};

const msgBase = {
  canvasId: z.string().max(128),
  epoch: z.string().min(1).max(64),
  version: z.number().int().min(0),
  seq: z.number().int().min(0),
  requestId: z.string().min(1).max(128),
};

export const SyncMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...msgBase, type: z.literal("space-feedback"), payload: z.strictObject({
    kind: z.enum(["saved", "transfer", "arrange", "undo", "redo"]), cardIds: z.array(z.string().min(1).max(128)).max(200).optional(),
  }) }),
  z.strictObject({ ...msgBase, type: z.literal("target-choice"), payload: z.strictObject({ choice: TargetChoiceSchema.nullable() }) }),
  z.strictObject({
    ...msgBase, type: z.literal("local-data-reset"), canvasId: z.string().min(1).max(128),
    payload: z.strictObject({ ownerId: z.string().min(1).max(64) }),
  }),
  z.strictObject({
    ...msgBase, type: z.literal("interaction"),
    payload: z.strictObject({ ownerEpoch: z.string().min(1).max(64),
      // Display submits only these explicit interactions to the elected owner.
      interaction: DisplayInteractionSchema }),
  }),
  z.strictObject({
    ...msgBase,
    type: z.literal("activity"),
    payload: z.strictObject({
      requestId: z.string().min(1).max(128),
      activity: ActivitySchema.nullable(),
    }),
  }),
  z.strictObject({
    ...msgBase,
    type: z.literal("hello"),
    payload: z.strictObject({ role: z.enum(["display", "control"]) }),
  }),
  z.strictObject({
    ...msgBase,
    type: z.literal("snapshot-request"),
    payload: z.strictObject({}),
  }),
  z.strictObject({
    ...msgBase,
    type: z.literal("snapshot"),
    payload: z.strictObject({
      title: z.string().min(1).max(120),
      version: z.number().int().min(0),
      vivicState: VivicStateSchema,
      preferences: DisplayPreferencesSchema.optional(),
      activeCanvasId: z.string().min(1).max(128).optional(),
      ownerId: z.string().min(1).max(64).optional(),
    }),
  }),
  z.strictObject({
    ...msgBase,
    type: z.literal("patch"),
    payload: z.strictObject({ envelope: ActionEnvelopeSchema }),
  }),
  z.strictObject({
    ...msgBase,
    type: z.literal("owner"),
    payload: z.strictObject({
      status: z.enum(["on", "off", "takeover"]),
      ownerId: z.string().min(1).max(64),
    }),
  }),
]);

export type SyncMessage = z.infer<typeof SyncMessageSchema>;

export const parseSyncMessage = (raw: unknown): SyncMessage | null => {
  const parsed = SyncMessageSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

/** Display "not pinned to a canvas" sentinel. */
export const ANY_CANVAS = "";
