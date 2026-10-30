import { z } from "zod";
import { CommonShape } from "./cardCommon";
import { IsoDateSchema } from "./sceneCards";

export const ProviderModeSchema = z.enum(["demo", "live"]);
export const TravelKindSchema = z.enum(["hotel", "flight", "poi"]);
/** Query facts only. dateText preserves an imprecise date without inventing a day. */
export const TravelQuerySchema = z.strictObject({
  kind: TravelKindSchema,
  destination: z.string().trim().min(1).max(80),
  origin: z.string().trim().min(1).max(80).optional(),
  startDate: IsoDateSchema.optional(),
  dateText: z.string().trim().min(1).max(80).optional(),
  nights: z.int().min(1).max(30).optional(),
  budget: z.number().finite().positive().max(10000000).optional(),
  partySize: z.int().min(1).max(50).optional(),
});
export type TravelQuery = z.infer<typeof TravelQuerySchema>;

export const TravelOfferSchema = z.strictObject({
  id: z.string().min(1).max(128), kind: TravelKindSchema,
  title: z.string().trim().min(1).max(200), subtitle: z.string().max(300).optional(),
  price: z.strictObject({ amount: z.number().finite().min(0), currency: z.string().regex(/^[A-Z]{3}$/) }).optional(),
  rating: z.number().finite().min(0).max(5).optional(),
  imageUrl: z.string().max(2048).regex(/^https:\/\/[^\s<>"']+$/).optional(),
  detailUrl: z.string().max(2048).regex(/^https:\/\/[^\s<>"']+$/).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(8),
});
export type TravelOffer = z.infer<typeof TravelOfferSchema>;

/** The only trusted adapter output. Tool text is data and never enters a planner prompt. */
export const ProviderResultSchema = <T extends z.ZodType, Q extends z.ZodType>(item: T, query: Q) => z.strictObject({
  provider: z.string().trim().min(1).max(80), tool: z.string().trim().min(1).max(80),
  requestId: z.string().min(1).max(128), fetchedAt: z.iso.datetime(), expiresAt: z.iso.datetime().optional(),
  mode: ProviderModeSchema, query, items: z.array(item).max(50),
  status: z.enum(["ok", "empty", "error"]),
}).refine(value => value.status === "ok" ? value.items.length > 0 : value.items.length === 0,
  "ok 需要结果；empty/error 不得带结果")
  .refine(value => !value.expiresAt || Date.parse(value.expiresAt) >= Date.parse(value.fetchedAt), "过期时间不得早于获取时间");
export interface ProviderResult<T, Q = Record<string, unknown>> {
  provider: string; tool: string; requestId: string; fetchedAt: string; expiresAt?: string;
  mode: "demo" | "live"; query: Q; items: T[]; status: "ok" | "empty" | "error";
}
export const TravelProviderResultSchema = ProviderResultSchema(TravelOfferSchema, TravelQuerySchema)
  .refine(value => new Set(value.items.map(item => item.id)).size === value.items.length, "结果 id 必须唯一")
  .refine(value => value.items.every(item => item.kind === value.query.kind), "结果品类与查询不符");

export const TravelOffersCardSchema = z.strictObject({
  ...CommonShape, type: z.literal("TravelOffersCard"),
  displayProps: z.strictObject({
    query: TravelQuerySchema, items: z.array(TravelOfferSchema).max(50), fetchedAt: z.iso.datetime(),
    mode: ProviderModeSchema, status: z.enum(["ok", "empty"]),
    selectedIds: z.array(z.string().min(1).max(128)).max(50), notes: z.string().max(2000),
  }).refine(value => new Set(value.items.map(item => item.id)).size === value.items.length
    && new Set(value.selectedIds).size === value.selectedIds.length
    && value.selectedIds.every(id => value.items.some(item => item.id === id)), "选择必须对应唯一的有效结果")
    .refine(value => value.status === "ok" ? value.items.length > 0 : value.items.length === 0, "结果状态不一致")
    .refine(value => value.items.every(item => item.kind === value.query.kind), "结果品类与查询不符"),
  sourceData: z.strictObject({ provider: z.string().min(1).max(80), tool: z.string().min(1).max(80),
    requestId: z.string().min(1).max(128), expiresAt: z.iso.datetime().optional() }),
});
export type TravelOffersCard = z.infer<typeof TravelOffersCardSchema>;
