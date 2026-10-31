import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openVivicDB } from "../db";
import { emptyVivicState, fromCanvasRecord, toCanvasRecord } from "../canvasRecord";
import { testCards } from "@/cards/__tests__/fixtures";

beforeEach(() => { vi.stubGlobal("indexedDB", new IDBFactory()); });
afterEach(() => { vi.unstubAllGlobals(); });

it("upgrades the actual v1 database, preserves raw cards through reload/autosave and adds definitions", async () => {
  const raw = { ...toCanvasRecord("legacy", "Saved", 2, emptyVivicState()), schemaVersion: 5,
    cardsById: { [testCards.NoteCard.id]: testCards.NoteCard, future: { id: "future", type: "FutureCard", data: { n: 7 } } },
    cardOrder: [testCards.NoteCard.id, "future"], custom: { preserve: true } };
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("vivic", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("canvases", { keyPath: "id" }).put(raw);
      request.result.createObjectStore("meta", { keyPath: "key" }).put({ key: "lastCanvasId", value: "legacy" });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => { request.result.close(); resolve(); };
  });
  const db = await openVivicDB();
  const recovered = (await db.getCanvas("legacy"))!;
  expect(recovered.cardOrder).toEqual([testCards.NoteCard.id]);
  expect(recovered.recovery?.rawRecord).toEqual(raw);
  await db.putCanvas(toCanvasRecord("legacy", "Edited", 3, fromCanvasRecord(recovered)));
  await db.saveCardDefinition({ key: "test@1#hash", enabled: true, definition: { example: true } });
  expect(await db.getMeta("lastCanvasId")).toBe("legacy");
  db.close();
  const reloaded = await openVivicDB();
  expect((await reloaded.getCanvas("legacy"))?.recovery?.rawRecord).toEqual(raw);
  expect(await reloaded.loadCardDefinitions()).toEqual([{ key: "test@1#hash", enabled: true, definition: { example: true } }]);
  await reloaded.reset(toCanvasRecord("fresh", "Fresh", 0, emptyVivicState()));
  expect(await reloaded.loadCardDefinitions()).toEqual([]);
  expect((await reloaded.getAllCanvases()).map(record => record.id)).toEqual(["fresh"]);
  reloaded.close();
});
