import { z } from "zod";
import { CardRecordSchema } from "./cardRecord";

/**
 * Wire shape for the serialized runtime state that travels in sync snapshots
 * (control -> display) and lands in IndexedDB canvases. Every field is plain
 * JSON (no Dates/functions) so structured-clone and JSON round-trip are safe.
 */

export const ViewportSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
  zoom: z.number(),
});

/** Transient request feedback; never persisted with a canvas. */
export const ActivitySchema = z.strictObject({
  requestId: z.string().min(1).max(128),
  text: z.string().min(1).max(120),
  expiresAt: z.number(),
  phase: z.enum(["thinking", "preparing-speech", "speaking", "listening", "transcribing"]).optional(),
  speech: z.strictObject({
    amplitude: z.number().finite().min(0).max(1),
    wordStart: z.number().int().min(0).max(119).optional(),
    wordEnd: z.number().int().min(1).max(120).optional(),
  }).optional(),
}).refine(activity => !activity.speech || (activity.phase === "speaking"
  && ((activity.speech.wordStart === undefined && activity.speech.wordEnd === undefined)
    || (activity.speech.wordStart !== undefined && activity.speech.wordEnd !== undefined
      && activity.speech.wordStart < activity.speech.wordEnd && activity.speech.wordEnd <= activity.text.length))));

const CardStateSchema = z.strictObject({
  record: CardRecordSchema,
  exitingRequestId: z.string().min(1).max(128).optional(),
});

export const TargetChoiceSchema = z.strictObject({
  id: z.string().min(1).max(128),
  targets: z.array(z.string().min(1).max(128)).min(2).max(1000).refine(ids => new Set(ids).size === ids.length),
  expiresAt: z.number().finite(),
});

export const VivicStateSchema = z.strictObject({
  stage: z.enum(["STANDBY", "AWAKENING", "WORKSPACE"]),
  awakenedAt: z.number().nullable(),
  cards: z.array(CardStateSchema),
  undoStack: z
    .array(z.strictObject({ card: CardRecordSchema, index: z.number().int().min(0), groupId: z.string().max(128).optional() }))
    .max(50),
  pendingDeletes: z.record(
    z.string(),
    z.strictObject({ cardId: z.string().min(1), index: z.number().int().min(0) }),
  ),
  focus: z
    .strictObject({ cardId: z.string().min(1), prevViewport: ViewportSchema })
    .nullable(),
  focusHistory: z.array(z.string().min(1).max(128)).max(20),
  viewportSize: z
    .strictObject({ width: z.number(), height: z.number() })
    .nullable(),
  highlight: z
    .strictObject({
      id: z.string().min(1),
      cardId: z.string().min(1),
      itemId: z.string().min(1).optional(),
      durationMs: z.number(),
    })
    .nullable(),
  subtitle: z
    .strictObject({
      id: z.string().min(1),
      text: z.string().max(120),
      durationMs: z.number(),
      shownAt: z.number(),
      priority: z.enum(["normal", "reminder"]).optional(),
    })
    .nullable(),
  activity: ActivitySchema.nullable().default(null),
  targetChoice: TargetChoiceSchema.nullable().default(null),
  ambient: z.strictObject({
    preset: z.enum(["grainient", "clouds", "clouds2"]),
    theme: z.enum(["auto", "light", "dark"]),
  }),
  viewport: ViewportSchema,
  lastFitRequestId: z.string().min(1).nullable(),
  processedRequestIds: z.array(z.string().min(1).max(128)).max(500),
});

export type SerializedVivicState = z.infer<typeof VivicStateSchema>;
