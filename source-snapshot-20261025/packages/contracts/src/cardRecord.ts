import { z } from "zod";
import { ReminderConditionSchema, ReminderScheduleSchema, TimeZoneSchema } from "./reminderSchedule";
import { CardVariantSchema, CommonShape, EvidenceRefSchema, OpenSourceData } from "./cardCommon";
import { ClockTimeSchema, IsoDateSchema, SCENE_CARD_SCHEMAS } from "./sceneCards";
import { TravelOffersCardSchema } from "./providers";
import { ExtensionCardDisplayPropsSchema } from "./extensionCard";
import { FileCardSchema } from "./files";

export const ExtensionCardSchema = z.strictObject({ ...CommonShape, type: z.literal("ExtensionCard"),
  displayProps: ExtensionCardDisplayPropsSchema, sourceData: z.strictObject({}) });
export type ExtensionCard = z.infer<typeof ExtensionCardSchema>;

export { CardSurfaceSchema, CardVariantSchema, EvidenceRefSchema, LayoutSchema, MetadataSchema, SubcardSchema, type CardSurface, type Subcard } from "./cardCommon";

/** A calendar date (optionally timed) the user counts down to, e.g. a birthday. */
export const CountdownEventSchema = z.strictObject({
  title: z.string().trim().min(1).max(60),
  date: IsoDateSchema,
  time: ClockTimeSchema.optional(),
  note: z.string().trim().min(1).max(120).optional(),
});

export const CountdownSourceDataSchema = z.strictObject({
  targetAt: z.iso.datetime(),
  startedAt: z.iso.datetime().optional(),
  pausedAt: z.iso.datetime().nullable().optional(),
  /** Validated task text for the reminder list, Control and due announcement. */
  reminderText: z.string().min(1).max(160).optional(),
  notifiedAt: z.iso.datetime().nullable().optional(),
  schedule: ReminderScheduleSchema.nullable().optional(),
  condition: ReminderConditionSchema.nullable().optional(),
  conditionMetAt: z.iso.datetime().nullable().optional(),
  lastDeliveredTargetAt: z.iso.datetime().nullable().optional(),
  lastFiredAt: z.iso.datetime().nullable().optional(),
  timeZone: TimeZoneSchema.optional(),
  /** Date-countdown mode: never scheduled, notified or merged into the reminder list. */
  event: CountdownEventSchema.optional(),
}).refine(value => !(value.schedule && value.condition), "重复计划与完成条件不能同时存在。")
  .refine(value => !value.event || (Boolean(value.timeZone) && !value.reminderText && !value.schedule && !value.condition && !value.pausedAt),
    "日期倒计时需要时区，且不能同时是提醒、重复计划、条件或暂停的计时器。");

export const CountdownCardSchema = z.strictObject({
  ...CommonShape,
  type: z.literal("CountdownCard"),
  // Pure timers render digits; named reminders use sourceData.reminderText in
  // the shared reminder list; date countdowns use sourceData.event. No
  // arbitrary title/footer/advice display fields.
  displayProps: z.strictObject({}),
  sourceData: CountdownSourceDataSchema,
});

export const TodoItemSchema = z.strictObject({
  id: z.string().min(1).max(128),
  text: z.string().min(1).max(160),
  done: z.boolean(),
});

export const TodoCardSchema = z.strictObject({
  ...CommonShape,
  type: z.literal("TodoCard"),
  displayProps: z.strictObject({
    title: z.string().trim().min(1).max(80).optional(),
    items: z.array(TodoItemSchema).min(1).max(30),
  }),
  sourceData: OpenSourceData,
});

export const WeatherCardSchema = z.strictObject({
  ...CommonShape,
  type: z.literal("WeatherCard"),
  displayProps: z.strictObject({
    tempC: z.number().min(-100).max(65),
    conditionIcon: z.enum([
      "sun",
      "cloud",
      "rain",
      "snow",
      "wind",
      "fog",
      "storm",
      "night",
    ]),
  }),
  sourceData: OpenSourceData,
});

export const NoteCardSchema = z.strictObject({
  ...CommonShape,
  type: z.literal("NoteCard"),
  displayProps: z
    .strictObject({
      text: z.string().max(500).optional(),
      bullets: z.array(z.string().max(180)).max(5).optional(),
    })
    .refine((v) => v.text !== undefined || v.bullets !== undefined, {
      message: "NoteCard needs text or bullets",
    }),
  sourceData: OpenSourceData,
});

export const SearchResultCardSchema = z.strictObject({
  ...CommonShape,
  type: z.literal("SearchResultCard"),
  displayProps: z.strictObject({
    title: z.string().min(1).max(140),
    summary: z.string().max(240),
    sourceLabel: z.string().max(70),
  }),
  sourceData: OpenSourceData,
  sources: z.array(EvidenceRefSchema).min(1).max(15),
});

export const TableCardSchema = z.strictObject({
  ...CommonShape,
  type: z.literal("TableCard"),
  displayProps: z.strictObject({
    columns: z.array(z.string().max(80)).min(1).max(8),
    rows: z
      .array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).min(1).max(8))
      .max(100),
  }),
  sourceData: OpenSourceData,
});

export const ChartPointSchema = z.strictObject({
  x: z.union([z.string(), z.number()]),
  y: z.number(),
});

export const ChartCardSchema = z.strictObject({
  ...CommonShape,
  type: z.literal("ChartCard"),
  displayProps: z.strictObject({
    title: z.string().trim().min(1).max(80).optional(),
    chartKind: z.enum(["line", "bar", "pie"]),
    points: z.array(ChartPointSchema).min(1).max(100),
    xLabel: z.string().max(60).optional(),
    yLabel: z.string().max(60).optional(),
  }),
  sourceData: OpenSourceData,
});

export const CardRecordSchema = z.discriminatedUnion("type", [
  CountdownCardSchema,
  TodoCardSchema,
  WeatherCardSchema,
  NoteCardSchema,
  SearchResultCardSchema,
  TableCardSchema,
  ChartCardSchema,
  TravelOffersCardSchema,
  ExtensionCardSchema,
  FileCardSchema,
  ...SCENE_CARD_SCHEMAS,
]);

export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
export type CardVariant = z.infer<typeof CardVariantSchema>;
export type TodoItem = z.infer<typeof TodoItemSchema>;
export type CountdownCard = z.infer<typeof CountdownCardSchema>;
export type CountdownEvent = z.infer<typeof CountdownEventSchema>;
export type TodoCard = z.infer<typeof TodoCardSchema>;
export type SearchResultCard = z.infer<typeof SearchResultCardSchema>;
export type ChartCard = z.infer<typeof ChartCardSchema>;
export type CardRecord = z.infer<typeof CardRecordSchema>;
export type CardType = CardRecord["type"];
export type CardOfType<T extends CardType> = Extract<CardRecord, { type: T }>;

/** A CountdownCard counting down to a calendar date rather than a timer/reminder. */
export const isDateCountdown = (card: CardRecord): card is CountdownCard & { sourceData: { event: CountdownEvent } } =>
  card.type === "CountdownCard" && Boolean(card.sourceData.event);

/** Cards moved onto the user page are not part of the Display canvas. */
export const onUserSurface = (card: CardRecord): boolean => card.layout.surface === "user";
