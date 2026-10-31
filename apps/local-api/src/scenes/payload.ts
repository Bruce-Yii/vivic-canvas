import { z } from "zod";
import { SCENE_CARD_TYPE, SceneIdSchema, TravelQuerySchema, type SceneId } from "@vivic/contracts";

/**
 * What the planner may return for a scene card: scene_id plus compact data.
 * No ids, layout, timestamps, markup or component names — the server builds
 * the CardRecord, and the scene registry alone decides its card_type.
 */
const text = (max: number) => z.string().trim().min(1).max(max);
const optional = (max: number) => z.string().trim().max(max).optional().transform(value => value || undefined);
const date = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "日期需为 YYYY-MM-DD");
const partialDate = z.string().trim().regex(/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/, "日期需为 YYYY、YYYY-MM 或 YYYY-MM-DD");
const time = z.string().trim().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "时间需为 HH:MM");
const url = z.string().trim().max(2048).regex(/^https:\/\/\S+$/, "链接必须是用户提供的 https 地址");
const number = z.number().finite();
/** Lists may come as plain strings or objects; both normalise to objects. */
const entry = <T extends z.ZodRawShape>(shape: T, key: keyof T & string) =>
  z.union([z.string().trim().min(1), z.strictObject(shape)]).transform(value => typeof value === "string" ? { [key]: value } : value);

const SceneData = {
  travel_offers: TravelQuerySchema,
  countdown: z.strictObject({ title: text(60), targetDate: date, targetTime: time.optional(), note: optional(120) }),
  academic_paper: z.strictObject({
    title: text(240), authors: z.array(text(80)).max(20).optional(), venue: optional(160), year: z.int().min(1000).max(2200).optional(),
    abstract: optional(2000), keyPoints: z.array(text(200)).max(6).optional(), doi: optional(200), url: url.optional(), tags: z.array(text(24)).max(6).optional(),
  }),
  photo_gallery: z.strictObject({ title: text(80), images: z.array(entry({ url, caption: optional(160) }, "url")).max(36).optional() }),
  weekly_schedule: z.strictObject({
    title: text(80), weekStart: date.optional(),
    events: z.array(z.strictObject({ day: z.int().min(1).max(7).optional(), date: date.optional(), start: time.optional(), end: time.optional(),
      title: text(80), location: optional(60) })).max(60),
  }),
  todo_list: z.strictObject({ title: optional(80), items: z.array(entry({ text: text(160), done: z.boolean().optional() }, "text")).min(1).max(30) }),
  project_roadmap: z.strictObject({
    title: text(80),
    phases: z.array(z.strictObject({ name: text(60), period: optional(40), status: z.enum(["done", "active", "planned"]).optional(), goal: optional(160),
      milestones: z.array(entry({ text: text(120), done: z.boolean().optional() }, "text")).max(10).optional() })).min(1).max(8),
  }),
  data_visualization: z.strictObject({
    title: optional(80), chartKind: z.enum(["line", "bar", "pie"]),
    points: z.array(z.strictObject({ x: z.union([z.string().trim().min(1).max(40), number]), y: number })).min(1).max(100),
    xLabel: optional(60), yLabel: optional(60),
  }),
  news_summary: z.strictObject({
    headline: text(200), source: optional(80), publishedAt: date.optional(), summary: text(800),
    keyPoints: z.array(text(200)).max(5).optional(), url: url.optional(), imageUrl: url.optional(),
  }),
  historical_timeline: z.strictObject({
    title: text(80), order: z.enum(["asc", "desc"]).optional(),
    events: z.array(z.strictObject({ date: partialDate, title: text(100), description: optional(300) })).min(1).max(40),
  }),
  quote_note: z.strictObject({ text: text(400), author: optional(60), source: optional(100), tag: optional(24) }),
  photo_story: z.strictObject({
    title: text(80),
    slides: z.array(z.strictObject({ heading: optional(60), text: text(300), imageUrl: url.optional() })).min(1).max(15),
  }),
  activity_feed: z.strictObject({
    title: text(80), live: z.boolean().optional(),
    items: z.array(z.strictObject({ kind: z.enum(["done", "update", "create", "comment", "alert", "event"]).optional(), text: text(160),
      at: z.iso.datetime({ offset: true }).optional(), time: optional(32) })).max(50).optional(),
  }),
  goal_progress: z.strictObject({ title: text(60), current: number.min(0), target: number.positive(), unit: optional(16), deadline: date.optional(), note: optional(120) }),
  habit_tracking: z.strictObject({ habit: text(60), checkins: z.array(date).max(800).optional(), weeklyGoal: z.int().min(1).max(7).optional(), startDate: date.optional() }),
  book_record: z.strictObject({
    title: text(160), author: optional(80), status: z.enum(["want", "reading", "paused", "finished"]).optional(),
    currentPage: z.int().min(0).max(100000).optional(), totalPages: z.int().min(1).max(100000).optional(), rating: z.int().min(1).max(5).optional(),
    coverUrl: url.optional(), notes: z.array(text(200)).max(8).optional(),
  }),
  monthly_calendar: z.strictObject({
    title: optional(60), month: z.string().trim().regex(/^\d{4}-\d{2}$/).optional(),
    events: z.array(z.strictObject({ date, title: text(60), time: time.optional() })).max(80),
  }),
  option_comparison: z.strictObject({
    title: text(80), options: z.array(entry({ name: text(40), note: optional(120) }, "name")).min(2).max(5),
    criteria: z.array(z.strictObject({ name: text(40), values: z.array(z.union([z.string().trim().max(80), number, z.null()])).min(2).max(5),
      better: z.enum(["higher", "lower"]).optional(), unit: optional(12) })).min(1).max(12),
    recommendation: optional(200), chosen: optional(40),
  }),
  web_bookmark: z.strictObject({ url, title: optional(200), siteName: optional(80), description: optional(400), tags: z.array(text(24)).max(6).optional() }),
  photo_memory: z.strictObject({ title: text(80), date: date.optional(), caption: optional(200), imageUrl: url.optional() }),
  single_notification: z.strictObject({
    title: text(80), body: optional(300), level: z.enum(["info", "success", "warning", "error"]).optional(),
    at: z.iso.datetime({ offset: true }).optional(), source: optional(40),
  }),
} satisfies Record<SceneId, z.ZodType>;

export type SceneDataOf<S extends SceneId> = z.output<(typeof SceneData)[S]>;

/** One scene card as the model emits it. card_type is optional but must match the registry. */
export const ScenePayloadSchema = z.strictObject({
  scene_id: SceneIdSchema,
  card_type: z.string().max(40).optional(),
  data: z.record(z.string(), z.unknown()),
});
export type ScenePayload = z.infer<typeof ScenePayloadSchema>;

export type ParsedScene = { [S in SceneId]: { scene: S; data: SceneDataOf<S> } }[SceneId];

const dataIssue = (scene: SceneId, error: z.ZodError): string => `${scene} 的 data 字段不合法（${error.issues.slice(0, 3).map(issue => {
  const field = issue.path.join(".") || "data";
  const message = issue.code === "invalid_type" ? `需要${issue.expected === "string" ? "单个字符串，不是数组或对象" : issue.expected}`
    : issue.code === "unrecognized_keys" ? "含未登记字段，请使用不带问号的真实键名"
      : issue.message.slice(0, 60);
  return `${field}：${message}`;
}).join("；")}）`;

/** A closed-registry hint is used only to report all repairable errors together. */
function repairHint(raw: unknown): string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "";
  const input = raw as Record<string, unknown>;
  const known = SceneIdSchema.safeParse(input.scene_id);
  const byType = Object.entries(SCENE_CARD_TYPE).find(([, type]) => type === input.card_type)?.[0];
  const fromType = SceneIdSchema.safeParse(byType ?? input.card_type);
  const scene = known.success ? known.data : fromType.success ? fromType.data : undefined;
  if (!scene) return "；scene_id是表内分类名，不是实例id，禁止拼接日期或随机编号";
  const fields = (SceneData[scene] as z.ZodType).safeParse(input.data);
  return `；此分类应为 scene_id=${scene}，card_type可省略或精确填写${SCENE_CARD_TYPE[scene]}${fields.success ? "" : `；${dataIssue(scene, fields.error)}`}`;
}

/** Structural validation with short, model-safe issue labels (never echo raw values). */
export function parseScenePayload(raw: unknown): { ok: true; value: ParsedScene } | { ok: false; issue: string } {
  const outer = ScenePayloadSchema.safeParse(raw);
  if (!outer.success) return { ok: false, issue: `cards 每项必须是 {scene_id, card_type?, data}，scene_id 必须是已登记场景之一${repairHint(raw)}` };
  const { scene_id: scene, card_type: cardType } = outer.data;
  if (cardType !== undefined && cardType !== SCENE_CARD_TYPE[scene]) {
    return { ok: false, issue: `scene_id ${scene} 只能对应 card_type ${SCENE_CARD_TYPE[scene]}${repairHint(raw)}` };
  }
  const data = (SceneData[scene] as z.ZodType).safeParse(outer.data.data);
  if (!data.success) {
    return { ok: false, issue: dataIssue(scene, data.error) };
  }
  return { ok: true, value: { scene, data: data.data } as ParsedScene };
}
