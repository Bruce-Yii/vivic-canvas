import { describe, expect, it, vi } from "vitest";
import { ActionEnvelopeSchema, type CardRecord } from "@vivic/contracts";
import { createDataClient } from "../src/data/index.js";
import { encodeProvenance, PROVENANCE_FIELD } from "../src/data/provenance.js";
import type { CanvasContext } from "../src/schemas.js";
import { emptyContext } from "./helpers.js";

const source = { title: "Recorded data source", url: "https://example.org/data", fetchedAt: "2026-10-15T07:00:00Z", provider: "test-source", readFullPage: false };
const original = { provenance: "test-source", originalQuery: "Explicit numeric data", attribution: { name: "Original author" }, recorded: [3, 5] };
const rows = [["苹果", 3], ["香蕉", 5]];
function table(id = "table-1", patch: Partial<CanvasContext["cards"][number]> = {}): CanvasContext["cards"][number] {
  return { id, type: "TableCard", aliases: [id], displayProps: { columns: ["水果", "数量"], rows },
    sourceDataSummary: { provenance: "user-input", originalText: "用表格记录：苹果3，香蕉5" }, layout: { x: 0, y: 0 }, ...patch };
}
function chart(id = "chart-1", patch: Partial<CanvasContext["cards"][number]> = {}): CanvasContext["cards"][number] {
  return { ...table(id), type: "ChartCard", displayProps: { chartKind: "bar", points: [{ x: "甲", y: -2 }, { x: "乙", y: 5 }],
    xLabel: "类别", yLabel: "温度°C" }, sourceDataSummary: { provenance: "external-context-summary" }, ...patch };
}
function setup(cards: CanvasContext["cards"] = [table()], focusHistory: string[] = []) {
  const fetchImpl = vi.fn(() => { throw new Error("Conversions must not call network or LLM"); });
  const client = createDataClient({ fetchImpl: fetchImpl as typeof fetch });
  const ctx = { ...emptyContext(cards), focusHistory };
  return { ctx, client, fetchImpl };
}
async function run(text: string, cards?: CanvasContext["cards"], focus?: string[]) {
  const h = setup(cards, focus);
  const result = await h.client.handleDataIntent(text, h.ctx);
  expect(h.fetchImpl).not.toHaveBeenCalled();
  if (result?.envelope) ActionEnvelopeSchema.parse(result.envelope);
  return result;
}
function created(result: Awaited<ReturnType<typeof run>>): CardRecord {
  const action = result?.envelope?.actions.find(action => action.type === "card.create");
  if (action?.type !== "card.create") throw new Error("Missing created card");
  return action.card;
}
// Reproduce the existing frontend's summary behavior, without changing its schema.
function summarize(card: CardRecord): CanvasContext["cards"][number] {
  return table(card.id, { type: card.type, displayProps: card.displayProps,
    sourceDataSummary: Object.fromEntries(Object.entries(card.sourceData).map(([key, value]) => [key,
      value === null || ["string", "number", "boolean"].includes(typeof value) ? value : Array.isArray(value) ? `[${value.length} items]` : "[object]"])),
    layout: { x: card.layout.x, y: card.layout.y } });
}

describe("safe conversions of existing data cards", () => {
  it.each([["柱状图", "bar"], ["折线图", "line"], ["饼图", "pie"]])("converts the only table to %s with exact values and user provenance", async (name, kind) => {
    const input = table(); const before = structuredClone(input);
    const result = await run(`把这张表格画成${name}`, [input]);
    const value = created(result);
    expect(value.type).toBe("ChartCard");
    expect(value.displayProps).toEqual({ chartKind: kind, points: [{ x: "苹果", y: 3 }, { x: "香蕉", y: 5 }], xLabel: "水果", yLabel: "数量" });
    expect(value.sources).toEqual([]);
    expect(value.sourceData).toMatchObject({ provenance: "user-input", provenanceCompleteness: "context-summary", dataTransform: { fromCardId: input.id } });
    expect(input).toEqual(before);
    expect(result?.envelope?.actions.some(action => action.type === "card.delete")).toBe(false);
  });

  it("requires a unique target among several tables and honors the latest focus only for a deictic reference", async () => {
    const cards = [table("a"), table("b"), chart("c")];
    expect(await run("把这张表格画成柱状图", cards)).toMatchObject({ kind: "clarify" });
    const focused = await run("把这张表格画成柱状图", cards, ["a", "b"]);
    expect(created(focused).sourceData).toMatchObject({ dataTransform: { fromCardId: "b" } });
    expect(await run("把表格画成柱状图", cards, ["b"])).toMatchObject({ kind: "clarify" });
    expect(await run("把这张表格画成柱状图", cards, ["b", "c"])).toMatchObject({ kind: "clarify" });
    expect(await run("把这张表格画成柱状图", cards, ["b", "deleted-id"])).toMatchObject({ kind: "clarify" });
    expect(created(await run("把第2张表格画成折线图", cards)).sourceData).toMatchObject({ dataTransform: { fromCardId: "b" } });
    expect(created(await run("把第二张表格画成折线图", cards)).sourceData).toMatchObject({ dataTransform: { fromCardId: "b" } });
    expect(created(await run("把「b」画成折线图", cards)).sourceData).toMatchObject({ dataTransform: { fromCardId: "b" } });
  });

  it("does not fall back to a different target when the explicitly chosen target has invalid data", async () => {
    const cards = [table("good"), table("bad", { displayProps: { columns: ["x", "y"], rows: [["a", null]] } })];
    expect(await run("把当前聚焦的表格画成折线图", cards, ["good", "bad"])).toMatchObject({ kind: "clarify" });
    expect(await run("把第9张表格画成折线图", cards)).toMatchObject({ kind: "clarify" });
    expect(await run("把「same」画成折线图", cards.map(card => ({ ...card, aliases: ["same"] })))).toMatchObject({ kind: "clarify" });
  });

  it("retains actual source refs and full provenance through the compact context string", async () => {
    const receipt = encodeProvenance({ sources: [source], sourceData: original })!;
    const card = created(await run("把这张表格画成柱状图", [table("external", {
      sourceDataSummary: { provenance: "test-source", attribution: "[object]", [PROVENANCE_FIELD]: receipt },
    })]));
    expect(card.sources).toEqual([source]);
    expect(card.sourceData).toMatchObject(original);
    expect(card.sourceData).not.toHaveProperty("provenanceCompleteness");
    const back = created(await run("把这张图表转成表格", [summarize(card)]));
    expect(back.sources).toEqual([source]);
    expect(back.sourceData).toMatchObject(original);
    expect(back.displayProps).toEqual({ columns: ["水果", "数量"], rows });
  });

  it("allows the real adapter's newly created numeric table to convert after the normal frontend summary", async () => {
    const first = setup([]);
    const result = await first.client.handleDataIntent("用表格记录：苹果3，香蕉5", first.ctx);
    const next = created(await run("把这张表格画成饼图", [summarize(created(result))]));
    expect(next.sourceData).toMatchObject({ provenance: "user-input", rows: [{ label: "苹果", value: 3 }, { label: "香蕉", value: 5 }] });
    expect(next.sources).toEqual([]);
  });

  it.each([{}, { provenance: "external-source" }, { provenance: "external-source", sources: "[1 items]" },
    { provenance: "user-input", [PROVENANCE_FIELD]: "broken" }, { provenance: "user-input", sources: [source] }])(
    "clarifies missing/malformed external provenance instead of dropping or fabricating sources", async summary => {
      expect(await run("把这张表格画成柱状图", [table("external", { sourceDataSummary: summary })])).toMatchObject({ kind: "clarify" });
    });

  it("updates an existing chart in place, preserving exact signed values, axes and original state provenance", async () => {
    const value = chart();
    const result = await run("把这张图表改成折线图", [value]);
    const updates = result?.envelope?.actions.filter(action => action.type === "card.update");
    expect(updates).toHaveLength(1);
    expect(updates![0]).toMatchObject({ targetId: value.id, displayProps: { chartKind: "line", points: value.displayProps.points,
      xLabel: "类别", yLabel: "温度°C" }, sourceData: { dataTransform: { fromCardId: value.id } } });
    expect(Object.keys(updates![0].sourceData!)).toEqual(["dataTransform"]);
    expect(result?.envelope?.actions.some(action => action.type === "card.create" || action.type === "card.delete")).toBe(false);
  });

  it.each(["把这张表格画成柱状图，然后删除旧卡", "先删除旧卡，再把这张表格画成柱状图",
    "把这张表格画成柱状图并清空画布", "把这张表格画成柱状图；删除这张表格"]) (
    "never partially converts mixed destructive instructions: %s", async text => {
      const result = await run(text);
      expect(result).toMatchObject({ kind: "clarify" }); expect(result).not.toHaveProperty("envelope");
    });

  it.each([[["a", -3], ["b", 5]], [["a", 0], ["b", 0]]])("refuses invalid pie values without applying absolute values", async values => {
    expect(await run("把这张表格画成饼图", [table("a", { displayProps: { columns: ["x", "y"], rows: values } })])).toMatchObject({ kind: "clarify" });
    expect(await run("把这张图表改成饼图", [chart()])).toMatchObject({ kind: "clarify" });
  });

  it.each([
    { columns: ["x", "y", "z"], rows: [["a", 3, 4]] }, { columns: ["x", "y"], rows: [["a", "3"]] },
    { columns: ["x", "y"], rows: [["a", null]] }, { columns: ["x", "y"], rows: [["a", 3], ["a", 5]] },
    { columns: ["x", "y"], rows: [["", 3]] }, { columns: ["x", "y"], rows: [["a", NaN]] },
    { columns: ["x", "y"], rows: [["a", Infinity]] }, { columns: ["x", "y"], rows: [["a", 3], ["b"]] },
    { columns: ["x", "y"], rows: [] },
  ])("never guesses a series, coerces text, fills nulls or aggregates duplicates", async displayProps => {
    expect(await run("把这张表格画成柱状图", [table("bad", { displayProps })])).toMatchObject({ kind: "clarify" });
  });

  it("preserves numerical x coordinates and rejects nonfinite chart points", async () => {
    const result = await run("把这张图表改成折线图", [chart("c", { displayProps: { chartKind: "bar", points: [{ x: 2024, y: -1.5 }, { x: 2025, y: 3 }] } })]);
    expect(result?.envelope?.actions[0]).toMatchObject({ type: "card.update", displayProps: { points: [{ x: 2024, y: -1.5 }, { x: 2025, y: 3 }] } });
    expect(await run("把这张图表改成折线图", [chart("c", { displayProps: { chartKind: "bar", points: [{ x: "a", y: null }] } })])).toMatchObject({ kind: "clarify" });
  });

  it("bounds provenance, rejects secrets/malformed refs and does not mutate the original metadata", () => {
    expect(encodeProvenance({ sources: [source], sourceData: { secret: "PRIVATE" } })).toBeNull();
    expect(encodeProvenance({ sources: [source], sourceData: { payload: "x".repeat(33 * 1024) } })).toBeNull();
    expect(encodeProvenance({ sources: [{ ...source, url: "file:///PRIVATE" }], sourceData: original })).toBeNull();
    expect(original).not.toHaveProperty(PROVENANCE_FIELD);
  });
});
