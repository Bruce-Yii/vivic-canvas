// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { CardRecordSchema, SCENES, type CardRecord } from "@/contracts";
import { CARD_VIEWS } from "../registry";
import { buildSceneFixtures } from "../scene/fixtures";
import { testCards } from "./fixtures";
import { buildDemoCards, RING_ORDER } from "@/landing/demoCards";
import { loadBuiltinOfficeDefinitions } from "../office/builtinOfficePackages";
import { extensionDefinitions } from "@/extensions/definitionStore";
import { createExtensionInstance } from "@/extensions/extensionInstance";
import { createMemoryDB } from "@/persistence/db";
import { createMemoryHub } from "@/sync/channel";
import { createMemoryLockProvider } from "@/sync/testing";
import { createControlHost } from "@/sync/controlHost";
import { createCanvasStore } from "@/state/canvasStore";
import { createVivicHostAdapter, type ExistingHost } from "@vivic/mobile-console-prototype/vivicHostAdapter";

afterEach(() => vi.unstubAllGlobals());

it("accounts for every website demonstration and every production renderer", () => {
  const demos = buildDemoCards();
  expect(RING_ORDER).toHaveLength(25);
  expect(new Set(RING_ORDER.map(key => demos[key].card.type)).size).toBe(24);
  expect(SCENES).toHaveLength(21);
  expect(Object.keys(CARD_VIEWS)).toHaveLength(27);
  const samples = [...Object.values(buildSceneFixtures()), ...Object.values(testCards)];
  expect(new Set(samples.map(card => card.type))).toEqual(new Set(Object.keys(CARD_VIEWS)));
  for (const key of RING_ORDER) expect(CARD_VIEWS[CardRecordSchema.parse(demos[key].card).type]).toBeDefined();
});

it("creates, updates, saves and restores all 27 real card types through the owner", async () => {
  vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("BroadcastChannel", undefined);
  const [definition] = await loadBuiltinOfficeDefinitions();
  await extensionDefinitions.install(definition!, definition!.hash);
  const byType = new Map<string, CardRecord>([...Object.values(testCards), ...Object.values(buildSceneFixtures())].map(card => [card.type, card]));
  byType.set("ExtensionCard", createExtensionInstance(definition!, definition!.examples[0]!));
  const cards = [...byType.values()].map(card => CardRecordSchema.parse(card));
  const db = createMemoryDB(), locks = createMemoryLockProvider(), hub = createMemoryHub();
  const store = createCanvasStore();
  const owner = createControlHost({ db, store, channel: hub.createChannel(), lockProvider: locks, reminderPollMs:1000000 });
  await owner.start();
  const canvasId = owner.getSnapshot().activeCanvasId!;
  try {
    for (const card of cards) {
      expect(owner.dispatch({ schemaVersion:"0.6", canvasId, requestId:`create-${card.type}`, actions:[{type:"card.create",card}] }).ok, card.type).toBe(true);
      expect(owner.setCardPinned(card.id, true).ok, card.type).toBe(true);
    }
    const version = owner.getSnapshot().canvases.find(canvas => canvas.id === canvasId)!.version;
    await owner.flush(canvasId, version);
    const saved = await db.getCanvas(canvasId);
    expect(Object.keys(saved!.cardsById)).toHaveLength(27);
    for (const card of cards) {
      const restored = CardRecordSchema.parse(saved!.cardsById[card.id]);
      expect(restored.displayProps, card.type).toEqual(card.displayProps);
      expect(restored.sourceData, card.type).toEqual(card.sourceData);
      expect(restored.layout.pinned, card.type).toBe(true);
    }
  } finally { owner.stop(); }
  const reloadedStore = createCanvasStore();
  const reopened = createControlHost({ db, store:reloadedStore, channel:hub.createChannel(), lockProvider:locks, reminderPollMs:1000000 });
  await reopened.start();
  try { expect(new Set(reloadedStore.getState().cards.map(card => card.record.type))).toEqual(new Set(Object.keys(CARD_VIEWS))); }
  finally { reopened.stop(); }
});

it("projects all website cards into the existing mobile whitelist without sending raw sources", () => {
  const demos = buildDemoCards();
  const host: ExistingHost = { getSnapshot:() => ({ready:true, ownerMode:"owner", ownerId:"TEST-owner", activeCanvasId:"TEST-space", canvases:[{id:"TEST-space",title:"TEST",version:1}]}), subscribe:() => () => {}, switchCanvas:() => {}, setCardPinned:() => ({ok:true}) };
  const adapter = createVivicHostAdapter({host,computerName:"TEST",shareCardPreviews:true,readCards:() => RING_ORDER.map(key => ({record:demos[key].card})),subscribeCards:() => () => {},submitText:async () => ({ok:true,message:"TEST"})});
  const projected = adapter.getSnapshot().cards;
  expect(projected).toHaveLength(25);
  for (const card of projected) { expect(card.preview,card.type).toBeDefined(); expect(card).not.toHaveProperty("sourceData"); expect(card).not.toHaveProperty("displayProps"); }
});
