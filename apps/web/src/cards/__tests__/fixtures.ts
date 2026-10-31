import type { CardRecord, SceneCardType } from "@/contracts";

/** Synthetic TEST / DEMO fixtures only. No request or live-data claim is made. */
const stamp = "2026-10-15T08:00:00.000Z";
const common = {
  variant: "minimal" as const,
  sourceData: { fixture: "TEST / DEMO", location: "TEST hidden location", detail: "TEST hidden source data" },
  sources: [{ title: "TEST / DEMO source", url: "https://example.com/test-data", fetchedAt: stamp, provider: "test-fixture", readFullPage: false }],
  layout: { x: 0, y: 0, width: 320, height: 240, pinned: false },
  metadata: { createdAt: stamp, updatedAt: stamp, aliases: ["TEST / DEMO"] },
};

export const testCards = {
  FileCard: { ...common, id: "TEST-file", type: "FileCard", displayProps: { fileId: "file_test", name: "TEST-notes.md", mediaType: "text/markdown", sizeBytes: 64, sha256: "a".repeat(64), previewText: "TEST read-only document", parseStatus: "ready" }, sourceData: {} },
  ExtensionCard: { ...common, id: "TEST-extension", type: "ExtensionCard", displayProps: { def: { id: "test.missing", version: "1.0.0", hash: "0".repeat(64) }, config: {}, data: {}, state: {} }, sourceData: {} },
  CountdownCard: { ...common, id: "TEST-countdown", type: "CountdownCard", displayProps: {}, sourceData: { targetAt: "2099-10-15T08:00:00.000Z" } },
  TodoCard: { ...common, id: "TEST-todo", type: "TodoCard", displayProps: { items: [{ id: "TEST-task", text: "TEST task", done: false }] } },
  SearchResultCard: { ...common, id: "TEST-search", type: "SearchResultCard", displayProps: { title: "TEST result", summary: "TEST synthetic result", sourceLabel: "TEST / DEMO" } },
  WeatherCard: { ...common, id: "TEST-weather", type: "WeatherCard", displayProps: { tempC: -3.5, conditionIcon: "snow" } },
  TableCard: { ...common, id: "TEST-table", type: "TableCard", displayProps: { columns: ["TEST item", "TEST value", "TEST state"], rows: [["TEST same", 0, false], ["TEST same", -5.25, null], ["TEST third", 8, true]] } },
  ChartCard: { ...common, id: "TEST-chart", type: "ChartCard", displayProps: { chartKind: "line", points: [{ x: "TEST A", y: -2 }, { x: "TEST B", y: 0 }, { x: "TEST C", y: 6 }], xLabel: "TEST sample", yLabel: "TEST units" } },
  NoteCard: { ...common, id: "TEST-note", type: "NoteCard", displayProps: { text: "TEST note\nTEST second line\nTEST third line\nTEST fourth line", bullets: ["TEST bullet one", "TEST bullet two"] } },
} satisfies Record<Exclude<CardRecord["type"], SceneOnlyType>, CardRecord>;

/** Scene-only card types have their own fixtures in cards/scene/fixtures.ts. */
type SceneOnlyType = Exclude<SceneCardType, "CountdownCard" | "TodoCard" | "ChartCard">;
