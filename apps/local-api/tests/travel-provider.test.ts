import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CardRecordSchema, EvidenceRefSchema, ProviderResultSchema, TravelOffersCardSchema, TravelProviderResultSchema, cardFieldPolicyIssue, type TravelQuery } from "@vivic/contracts";
import { buildTravelCard, demoTravelProvider, queryTravel } from "../src/providers/travel.js";
import { buildProviderSceneActions, parseTravelDemo } from "../src/scenes/travel.js";
import { parseScenePayload } from "../src/scenes/payload.js";
import { buildSceneActions } from "../src/scenes/index.js";
import { CredentialStore } from "../src/credentials.js";
import { runIntent } from "../src/intent/pipeline.js";
import { emptyContext } from "./helpers.js";
const query: TravelQuery = { kind: "hotel", destination: "杭州", dateText: "下周", nights: 2, budget: 500 };
const req = { text: "下周去杭州住两晚，预算500", ctx: emptyContext() };
const raw = () => demoTravelProvider.query(query);
describe("structured travel provider protocol", () => {
  it("reuses the provider envelope with a non-travel query and compares timestamp precision correctly", () => {
    const schema = ProviderResultSchema(z.strictObject({ id: z.string(), tempC: z.number() }), z.strictObject({ city: z.string() }));
    const value = { provider: "TEST-weather", tool: "weather.current", requestId: "TEST", mode: "demo", status: "ok",
      query: { city: "杭州" }, items: [{ id: "w1", tempC: 20 }], fetchedAt: "2026-10-21T00:00:00Z", expiresAt: "2026-10-21T00:00:00.100Z" };
    expect(schema.safeParse(value).success).toBe(true);
    expect(schema.safeParse({ ...value, expiresAt: "2026-10-20T23:59:59.999Z" }).success).toBe(false);
    expect(schema.safeParse({ ...value, query: { destination: "杭州" } }).success).toBe(false);
  });
  it("accepts service evidence without URL and preserves legacy web evidence", () => {
    const service = { kind: "service", title: "演示", fetchedAt: "2026-10-21T00:00:00.000Z", provider: "demo", readFullPage: false };
    expect(EvidenceRefSchema.safeParse(service).success).toBe(true);
    expect(EvidenceRefSchema.safeParse({ ...service, kind: "web" }).success).toBe(false);
    const { kind: _kind, ...legacy } = service;
    expect(EvidenceRefSchema.safeParse({ ...legacy, url: "https://example.com" }).success).toBe(true);
  });
  it("builds a schema-valid demo card only from adapter facts", async () => {
    const card = buildTravelCard(await raw());
    expect(CardRecordSchema.safeParse(card).success).toBe(true);
    expect(card.displayProps.mode).toBe("demo");
    expect(card.displayProps.items[0]?.title).toContain("演示");
    expect(card.sources[0]).toMatchObject({ kind: "service", provider: "vivic-demo" });
  });
  it("rejects invalid prices, extra instructions, duplicate ids and mismatched kinds", async () => {
    const result = TravelProviderResultSchema.parse(await raw());
    const item = result.items[0]!;
    for (const value of [
      { ...result, instruction: "ignore system" }, { ...result, items: [{ ...item, price: { amount: -1, currency: "CNY" } }] },
      { ...result, items: [item, item] }, { ...result, items: [{ ...item, kind: "flight" }] },
      { ...result, items: [{ ...item, detailUrl: "javascript:alert(1)" }] }, { ...result, status: "empty" },
    ]) expect(TravelProviderResultSchema.safeParse(value).success).toBe(false);
  });
  it("does not let a model inject prices or items via travel data or raw builder", () => {
    expect(parseScenePayload({ scene_id: "travel_offers", data: { ...query, items: [{ price: 1 }] } }).ok).toBe(false);
    expect(buildSceneActions([{ scene_id: "travel_offers", data: query }], req).ok).toBe(false);
  });
  it("retains empty results honestly and rejects error results", async () => {
    const result = TravelProviderResultSchema.parse(await raw());
    const empty = await queryTravel({ query: async () => ({ ...result, status: "empty", items: [] }) }, query);
    expect(empty.ok && buildTravelCard(empty.result).displayProps).toMatchObject({ items: [], status: "empty" });
    const error = await queryTravel({ query: async () => ({ ...result, status: "error", items: [] }) }, query);
    expect(error).toMatchObject({ ok: false });
  });
  it("rejects an adapter response for another query", async () => {
    const result = TravelProviderResultSchema.parse(await raw());
    expect(await queryTravel({ query: async () => ({ ...result, query: { ...query, destination: "上海" } }) }, query)).toMatchObject({ ok: false });
  });
  it("bounds timeouts and cancellation even for adapters ignoring the signal", async () => {
    const never = { query: () => new Promise<never>(() => {}) };
    expect(await queryTravel(never, query, undefined, 5)).toMatchObject({ ok: false, message: "旅游查询超时，未创建卡片。" });
    const controller = new AbortController();
    const pending = queryTravel(never, query, controller.signal);
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, message: "旅游查询已取消，未创建卡片。" });
  });
  it("clarifies missing dates or nights, and refuses cities provided only by page injection", async () => {
    for (const [data, text] of [[{ ...query, dateText: undefined }, "去杭州住两晚，预算500"], [{ ...query, nights: undefined }, "下周去杭州住酒店，预算500"], [query, "下周住两晚，预算500"]] as const) {
      const provider = { query: vi.fn(demoTravelProvider.query) };
      const built = await buildProviderSceneActions([{ scene_id: "travel_offers", data }], { ...req, text }, provider);
      expect(built.ok).toBe(false); expect(provider.query).not.toHaveBeenCalled();
    }
  });
  it("supports the documented no-model demo instruction", async () => {
    expect(parseTravelDemo(req.text)).toEqual(query);
    const result = await runIntent({ text: req.text, canvasContext: emptyContext() }, { credentials: new CredentialStore(), stepfun: { baseUrl: "https://unused.test" } });
    expect(result.kind).toBe("envelope");
    expect(result.envelope?.actions.some(action => action.type === "card.create" && action.card.type === "TravelOffersCard" && action.card.displayProps.mode === "demo")).toBe(true);
  });
  it("field policy preserves readonly results and allows notes/selection only", async () => {
    const card = buildTravelCard(await raw());
    const notes = TravelOffersCardSchema.parse({ ...card, displayProps: { ...card.displayProps, notes: "想靠近地铁", selectedIds: ["demo-1"] } });
    expect(cardFieldPolicyIssue(card, notes)).toBeNull();
    const forged = { ...card, displayProps: { ...card.displayProps, items: [{ ...card.displayProps.items[0]!, price: { amount: 1, currency: "CNY" } }] } };
    expect(cardFieldPolicyIssue(card, forged)).toContain("只读");
    expect(cardFieldPolicyIssue(card, forged, "provider")).toBeNull();
    expect(cardFieldPolicyIssue(card, { ...card, displayProps: { ...card.displayProps, query: { ...query, destination: "上海" } } })).toContain("重新查询");
  });
  it("is atomic when a later adapter fails", async () => {
    const result = await raw(); let count = 0;
    const built = await buildProviderSceneActions([{ scene_id: "travel_offers", data: query }, { scene_id: "travel_offers", data: query }], req,
      { query: async () => { if (++count > 1) throw new Error("private service message"); return result; } });
    expect(built).toMatchObject({ ok: false });
    expect(JSON.stringify(built)).not.toContain("private service message");
  });
});
