import { describe, expect, it } from "vitest";
import {
  fromCanvasRecord,
  toCanvasRecord,
  emptyVivicState,
  recoverCanvasRecord,
  getCanvasRecovery,
} from "../canvasRecord";
import {
  fileToCanvasRecord,
  parseCanvasFile,
  toCanvasFile,
  MAX_CANVAS_FILE_BYTES,
} from "../canvasFile";
import { createMemoryDB } from "../db";
import { createCanvasStore } from "@/state/canvasStore";
import type { CardRecord } from "@/contracts";

const fixedNow = "2026-10-14T10:00:00.000Z";

const todoCard = (id: string): CardRecord => ({
  id,
  type: "TodoCard",
  variant: "minimal",
  displayProps: {
    items: [
      { id: `${id}-1`, text: "写报告", done: true },
      { id: `${id}-2`, text: "回邮件", done: false },
    ],
  },
  sourceData: {},
  sources: [],
  layout: { x: 0, y: 0, width: 288, height: 160, pinned: false },
  metadata: { createdAt: fixedNow, updatedAt: fixedNow, aliases: ["工作"] },
});

const buildStoreWithCards = () => {
  const store = createCanvasStore();
  store.dispatch({
    schemaVersion: "0.6",
    requestId: "r1",
    canvasId: "c1",
    actions: [
      { type: "stage.awaken" },
      { type: "card.create", card: todoCard("todo-1") },
      { type: "card.create", card: todoCard("todo-2") },
    ],
  });
  store.internal({ type: "stage.awakening.complete" });
  store.internal({ type: "canvas.viewport", viewport: { x: 12, y: 34, zoom: 1.2 } });
  store.dispatch({
    schemaVersion: "0.6",
    requestId: "r2",
    canvasId: "c1",
    actions: [{ type: "card.focus", targetId: "todo-1" }],
  });
  return store;
};

describe("canvas record round-trip", () => {
  it("store -> record -> store keeps cards, order, viewport, focus history", async () => {
    const store = buildStoreWithCards();
    const record = toCanvasRecord("c1", "演示画布", 7, store.getState());
    const db = createMemoryDB();
    await db.putCanvas(record);
    const loaded = await db.getCanvas("c1");
    expect(loaded).toBeDefined();

    const revived = createCanvasStore();
    revived.loadState(fromCanvasRecord(loaded!));
    const state = revived.getState();
    expect(state.stage).toBe("WORKSPACE"); // cards exist => restored awake
    expect(state.cards.map((c) => c.record.id)).toEqual(["todo-1", "todo-2"]);
    expect(state.viewport).toEqual({ x: 12, y: 34, zoom: 1.2 });
    expect(state.focusHistory).toContain("todo-1");
    expect(state.undoStack).toHaveLength(0);
  });

  it("empty canvas restores to STANDBY", () => {
    const revived = fromCanvasRecord({
      id: "c2",
      title: "空",
      version: 0,
      updatedAt: fixedNow,
      cardsById: {},
      cardOrder: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      focusHistory: [],
    });
    expect(revived.stage).toBe("STANDBY");
  });
});

describe("JSON export/import", () => {
  it("restores every card from a canvas larger than the old 200-card import limit", () => {
    const state = { ...emptyVivicState(), cards: Array.from({ length: 201 }, (_, i) => ({ record: todoCard(`card-${i}`) })) };
    const original = toCanvasRecord("large", "Large canvas", 2, state);
    const parsed = parseCanvasFile(JSON.stringify(toCanvasFile(original)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const restored = fileToCanvasRecord(parsed.file, "restored");
      expect(restored.cardOrder).toEqual(original.cardOrder);
      expect(restored.cardsById).toEqual(original.cardsById);
    }
  });

  it("rejects oversized UTF-8 input before parsing JSON", () => {
    const oversized = "画".repeat(Math.floor(MAX_CANVAS_FILE_BYTES / 3) + 1);
    expect(oversized.length).toBeLessThan(MAX_CANVAS_FILE_BYTES);
    expect(parseCanvasFile(oversized)).toEqual({ ok: false, error: "画布文件过大，最多支持 20 MiB 的 JSON 文件" });
    expect(parseCanvasFile("x".repeat(MAX_CANVAS_FILE_BYTES + 1))).toEqual({ ok: false, error: "画布文件过大，最多支持 20 MiB 的 JSON 文件" });
  });

  it("export file validates and re-imports with the same cards", () => {
    const store = buildStoreWithCards();
    const record = toCanvasRecord("c1", "演示画布", 3, store.getState());
    const file = toCanvasFile(record);
    const text = JSON.stringify(file);
    const parsed = parseCanvasFile(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const reimported = fileToCanvasRecord(parsed.file, "c9");
      expect(reimported.title).toBe("演示画布");
      expect(reimported.cardOrder).toEqual(["todo-1", "todo-2"]);
      expect(reimported.cardsById["todo-1"]?.metadata.aliases).toEqual(["工作"]);
      expect(reimported.version).toBe(0);
    }
  });

  it("rejects non-JSON and schema violations", () => {
    expect(parseCanvasFile("not json").ok).toBe(false);
    expect(parseCanvasFile("{}").ok).toBe(false);
    // Unknown card field must be rejected (B07).
    const bad = {
      schemaVersion: "0.6",
      app: "vivic",
      exportedAt: fixedNow,
      canvas: {
        title: "x",
        viewport: { x: 0, y: 0, zoom: 1 },
        focusHistory: [],
        cards: [
          {
            ...todoCard("t"),
            displayProps: { items: [{ id: "a", text: "x", done: false }], advice: "偷塞" },
          },
        ],
      },
    };
    expect(parseCanvasFile(JSON.stringify(bad)).ok).toBe(false);
    // Countdown with a description is contractually illegal.
    const badCountdown = {
      ...bad,
      canvas: {
        ...bad.canvas,
        cards: [
          {
            id: "cd",
            type: "CountdownCard",
            variant: "minimal",
            displayProps: { description: "距离结束" },
            sourceData: { targetAt: fixedNow },
            sources: [],
            layout: { x: 0, y: 0, width: 264, height: 96, pinned: false },
            metadata: { createdAt: fixedNow, updatedAt: fixedNow },
          },
        ],
      },
    };
    expect(parseCanvasFile(JSON.stringify(badCountdown)).ok).toBe(false);
  });
});

describe("memory db parity", () => {
  it("put/get/delete/list round-trip", async () => {
    const db = createMemoryDB();
    const record = toCanvasRecord("c1", "T", 0, emptyVivicState());
    await db.putCanvas(record);
    expect((await db.getCanvas("c1"))?.title).toBe("T");
    expect(await db.getAllCanvases()).toHaveLength(1);
    await db.setMeta("lastCanvasId", "c1");
    expect(await db.getMeta("lastCanvasId")).toBe("c1");
    await db.deleteCanvas("c1");
    expect(await db.getCanvas("c1")).toBeUndefined();
  });
});

describe("persisted canvas recovery", () => {
  it("migrates unversioned records and isolates invalid cards without losing valid neighbors", async () => {
    const good = todoCard("good");
    const bad = { ...todoCard("bad"), displayProps: { items: "corrupt" } };
    const unknown = { id: "future", type: "FutureCard", secretFreePayload: [1, 2, 3] };
    const raw = { ...toCanvasRecord("saved", "Original", 8, emptyVivicState()), schemaVersion: 99,
      futureCanvasField: { custom: true }, cardsById: { good, bad, future: unknown }, cardOrder: ["bad", "future", "good"] };
    const db = createMemoryDB([raw]);
    const recovered = (await db.getAllCanvases())[0]!;
    expect(recovered.cardOrder).toEqual(["good"]);
    expect(getCanvasRecovery(recovered)?.quarantinedCardCount).toBe(2);
    expect(recovered.recovery?.rawRecord).toEqual(raw);
    // A later autosave can only see valid live cards. The raw source survives it.
    const live = fromCanvasRecord(recovered);
    live.cards[0]!.record.layout.x = 100;
    await db.putCanvas(toCanvasRecord("saved", "Edited", 9, live));
    const saved = (await db.getCanvas("saved"))!;
    expect(saved.recovery?.rawRecord).toEqual(raw);
    expect(saved.recovery?.quarantinedCards).toEqual({ bad, future: unknown });
    expect(saved.cardsById.good?.layout.x).toBe(100);
    // Export/restore includes both the current valid state and preserved raw data.
    const parsed = parseCanvasFile(JSON.stringify(toCanvasFile(saved)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(fileToCanvasRecord(parsed.file, "restored").recovery).toEqual(saved.recovery);
  });

  it("recovers known card fields while keeping unsupported nested and canvas fields in the original", () => {
    const card = { ...todoCard("known"), newMetadata: true,
      displayProps: { ...todoCard("known").displayProps, futureDisplayField: { nested: true } } };
    const raw = { ...toCanvasRecord("saved", "T", 0, emptyVivicState()), cardsById: { known: card }, cardOrder: [], newCanvasField: 7 };
    const recovered = recoverCanvasRecord(raw)!;
    expect(recovered.cardOrder).toEqual(["known"]);
    expect(recovered.cardsById.known).toEqual(todoCard("known"));
    expect(recovered.recovery?.rawRecord).toEqual(raw);
    expect(recovered.recovery?.quarantinedCards).toEqual({});
  });

  it("falls back only damaged envelope fields and retains the raw source", () => {
    const raw = { id: "damaged", title: null, version: -1, updatedAt: false, viewport: {}, focusHistory: null,
      cardsById: { good: todoCard("good") }, cardOrder: ["good", "good"] };
    const record = recoverCanvasRecord(raw)!;
    expect(record.cardOrder).toEqual(["good"]);
    expect(record.title).toBe("已恢复的画布");
    expect(record.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(record.recovery?.rawRecord).toEqual(raw);
    expect(record.recovery?.issues.some(issue => issue.path === "title")).toBe(true);
  });

  it("preserves multiple package versions and clears them with an explicit app reset", async () => {
    const db = createMemoryDB();
    await db.saveCardDefinition({ key: "test@1#a", definition: { test: true }, enabled: true });
    await db.saveCardDefinition({ key: "test@2#b", definition: { test: false }, enabled: false });
    const loaded = await db.loadCardDefinitions();
    expect(loaded).toHaveLength(2);
    loaded[0]!.enabled = false;
    expect((await db.loadCardDefinitions())[0]!.enabled).toBe(true);
    await db.deleteCardDefinition("test@1#a");
    expect(await db.loadCardDefinitions()).toHaveLength(1);
    await db.reset(toCanvasRecord("fresh", "Fresh", 0, emptyVivicState()));
    expect(await db.loadCardDefinitions()).toEqual([]);
    expect((await db.getAllCanvases()).map(row => row.id)).toEqual(["fresh"]);
  });
});
