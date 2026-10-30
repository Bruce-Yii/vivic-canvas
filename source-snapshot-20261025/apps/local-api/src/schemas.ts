import { z } from "zod";
import { ActionEnvelopeSchema, DecisionTaskRequestSchema, DecisionTaskStatusSchema, HostOperationSchema } from "@vivic/contracts";
import { SPEECH_VOICE_IDS } from "./voices.js";
import { ImageAttachmentsSchema } from "./images.js";
import { TimeZoneSchema } from "@vivic/contracts";
import { DevicePositionSchema } from "./data/deviceRegion.js";

/** Compact canvas context the control page sends with each intent request. */
export const CanvasContextSchema = z.strictObject({
  canvasId: z.string().min(1).max(128),
  version: z.int().min(0).optional(),
  selectedCardIds: z.array(z.string().min(1).max(128)).max(64).optional(),
  stage: z.enum(["STANDBY", "AWAKENING", "WORKSPACE"]),
  viewport: z.strictObject({ x: z.number(), y: z.number(), zoom: z.number() }),
  focusHistory: z.array(z.string().max(128)).max(20),
  timeZone: TimeZoneSchema.optional(),
  totalCardCount: z.int().min(0).max(100000).optional(),
  cards: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(128),
        type: z.string().min(1).max(60),
        aliases: z.array(z.string().max(80)).max(12).optional(),
        displayProps: z.record(z.string(), z.unknown()),
        sourceDataSummary: z.record(z.string(), z.unknown()),
        contextSummary: z.strictObject({ truncatedFields: z.array(z.string().min(1).max(128)).max(64) }).optional(),
        layout: z.strictObject({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite().positive().optional(), height: z.number().finite().positive().optional(), pinned: z.boolean().optional() }),
        surface: z.enum(["user", "display"]).optional(),
      }),
    )
    .max(64, "画布上下文最多包含 64 张卡片，请按聚焦、固定和最近使用筛选后重试。"),
});

export type CanvasContext = z.infer<typeof CanvasContextSchema>;

export const IntentRequestSchema = z.strictObject({
  task: DecisionTaskRequestSchema.optional(),
  text: z.string().min(1).max(500),
  canvasContext: CanvasContextSchema,
  attachments: ImageAttachmentsSchema.optional(),
  continuation: z.strictObject({ utterance: z.string().min(1).max(500), question: z.string().min(1).max(180) }).optional(),
  /** Sent by Control only for weather wording, rounded to ~1 km; never persisted by the API. */
  deviceLocation: DevicePositionSchema.optional(),
  /** Declarative definitions are untrusted data and revalidated/hash-checked by the planner. */
  extensionDefinitions: z.array(z.record(z.string(), z.unknown())).max(8).superRefine((definitions, ctx) => {
    const sizes = definitions.map(definition => new TextEncoder().encode(JSON.stringify(definition)).byteLength);
    if (sizes.some(size => size > 128 * 1024) || sizes.reduce((sum, size) => sum + size, 0) > 512 * 1024) {
      ctx.addIssue({ code: "custom", message: "启用的扩展定义过大，请减少启用数量。" });
    }
  }).optional(),
});

export const WeatherHereRequestSchema = z.strictObject({ deviceLocation: DevicePositionSchema.optional() });

export const ValidateKeyRequestSchema = z.strictObject({
  apiKey: z
    .string()
    .min(8)
    .max(256)
    .regex(/^\S+$/, "API Key 不应包含空白字符"),
});

/** Deliberately shorter than the provider's 1000-character limit. */
export const SpeechRequestSchema = z.strictObject({
  text: z.string().max(200)
    .regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*$/u, "只接受可见短句").trim().min(1),
  voice: z.enum(SPEECH_VOICE_IDS).optional(),
  speed: z.number().min(0.5).max(2).optional(),
  timestamps: z.boolean().optional(),
});

export const IntentResponseSchema = z.strictObject({
  kind: z.enum(["envelope", "host-operation", "clarify", "unknown", "error", "locale", "task"]),
  envelope: ActionEnvelopeSchema.optional(),
  hostOperation: HostOperationSchema.optional(),
  task: DecisionTaskStatusSchema.optional(),
  message: z.string().max(400).optional(),
  suggestions: z.array(z.string().min(1).max(100)).max(5).optional(),
  locale: z.strictObject({ name: z.string().min(1).max(80), admin1: z.string().max(80).optional(),
    country: z.string().max(80).optional(), basis: z.enum(["device", "network"]), answer: z.string().min(1).max(200) }).optional(),
  usedProvider: z.enum(["rules", "stepfun", "gpt", "rules-offline", "search", "decision"]).optional(),
}).superRefine((response, ctx) => {
  if (response.hostOperation && response.envelope || response.kind === "host-operation" && !response.hostOperation
    || response.hostOperation && response.kind !== "host-operation") ctx.addIssue({ code: "custom", message: "宿主操作与 ActionEnvelope 必须二选一。" });
});

export type IntentResponse = z.infer<typeof IntentResponseSchema>;
