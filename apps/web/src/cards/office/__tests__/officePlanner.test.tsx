// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parsePackageFiles, revalidateDefinition, validateInstance, type CardDefinition } from "@vivic/card-runtime";
import { CardRecordSchema, type CardOfType } from "@/contracts";
import { createExtensionInstance } from "@/extensions/extensionInstance";
import { extensionDefinitions, validateExtensionCard } from "@/extensions/definitionStore";
import { createMemoryDB } from "@/persistence/db";
import { createMemoryHub } from "@/sync/channel";
import { createMemoryLockProvider } from "@/sync/testing";
import { createControlHost } from "@/sync/controlHost";
import { createCanvasStore } from "@/state/canvasStore";
import { CardActionsContext, CardModeContext, type CardActions, type CardMode } from "../../scene/cardContext";
import { loadBuiltinOfficeDefinitions, officePlannerKind, type OfficePlannerKind } from "../builtinOfficePackages";
import { OfficePlannerCardView } from "../OfficePlannerCardView";

let container: HTMLDivElement, root: Root;
let definitions: CardDefinition[];
beforeAll(async () => { vi.stubGlobal("crypto", webcrypto); definitions = await loadBuiltinOfficeDefinitions(); });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("BroadcastChannel", undefined);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const render = async (node: ReactNode) => act(async () => root.render(node));
function view(card: CardOfType<"ExtensionCard">, definition: CardDefinition, kind: OfficePlannerKind, mode: CardMode, actions: CardActions) {
  return <CardModeContext.Provider value={mode}><CardActionsContext.Provider value={actions}><OfficePlannerCardView card={card} definition={definition} kind={kind} /></CardActionsContext.Provider></CardModeContext.Provider>;
}
const button = (label: string) => Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(node => node.textContent?.trim() === label)!;

describe("office package identity and safe model data", () => {
  it("derives exact hashes from all bundled JSON and rejects same-ID substitutions", async () => {
    expect(definitions).toHaveLength(3);
    for (const definition of definitions) {
      expect(officePlannerKind(await revalidateDefinition(JSON.parse(JSON.stringify(definition))))).toBeDefined();
      for (const example of definition.examples) expect(() => validateInstance(definition, example)).not.toThrow();
      const files = Object.fromEntries(Object.entries(definition.files).map(([file, value]) => [file, JSON.stringify(value)]));
      const changed = await parsePackageFiles({ ...files, "ui.json": JSON.stringify({ components: [{ component: "Header", text: "Same ID, unrelated package" }] }) });
      expect(officePlannerKind(changed)).toBeUndefined();
      expect(() => validateInstance(definition, { ...definition.examples[0]!, data: { origin: "live", provider: "lark" } })).toThrow();
    }
  });
  it.each(["tasks", "meeting", "week"] as const)("renders %s examples in both modes without enabling Display writes", async kind => {
    const definition = definitions.find(def => officePlannerKind(def) === kind)!;
    for (const example of definition.examples) {
      const card = createExtensionInstance(definition, example), update = vi.fn(() => true);
      await render(view(card, definition, kind, "display", { editable: true, update }));
      expect(container.textContent).toContain("DEMO · 虚构样例");
      expect(container.querySelector("input, textarea, select, button")).toBeNull();
      await render(view(card, definition, kind, "control", { editable: false, update }));
      expect(container.querySelector("button")).toBeNull();
      await render(view(card, definition, kind, "control", { editable: true, update }));
      expect(button("添加行动")).toBeDefined();
      expect(update).not.toHaveBeenCalled();
    }
  });
  it("treats task text as escaped content", async () => {
    const definition = definitions[0]!, card = createExtensionInstance(definition, definition.examples[0]!);
    card.displayProps.config.context = '<img src=x onerror="alert(1)">';
    await render(view(card, definition, "tasks", "display", { editable: false, update: () => false }));
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x");
  });
});

describe("office actions through the existing owner", () => {
  it("saves completion, reverses exactly one edit, rejects invalid updates and persists the restored card", async () => {
    const definition = definitions[0]!;
    await extensionDefinitions.install(definition, definition.hash);
    const db = createMemoryDB(), store = createCanvasStore();
    const owner = createControlHost({ db, store, channel: createMemoryHub().createChannel(), lockProvider: createMemoryLockProvider(), reminderPollMs: 1000000 });
    await owner.start();
    try {
      const canvasId = owner.getSnapshot().activeCanvasId!;
      const original = createExtensionInstance(definition, definition.examples[0]!);
      expect(owner.dispatch({ schemaVersion: "0.6", canvasId, requestId: "office-seed", actions: [{ type: "card.create", card: original }] }).ok).toBe(true);
      const current = () => {
        const record = store.getState().cards.find(entry => entry.record.id === original.id)!.record;
        if (record.type !== "ExtensionCard") throw new Error("Unexpected card type");
        return record;
      };
      let sequence = 0;
      const update: CardActions["update"] = (cardId, patch) => owner.dispatch({ schemaVersion: "0.6", canvasId, requestId: `office-edit-${++sequence}`, actions: [{ type: "card.update", targetId: cardId, ...patch }] }).ok;
      const draw = () => render(view(current(), definition, "tasks", "control", { editable: true, update }));
      await draw();
      await act(async () => container.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
      await draw();
      expect(container.querySelector('[role="checkbox"]')?.getAttribute("aria-checked")).toBe("true");
      expect(button("撤销上次编辑")).toBeDefined();
      await act(async () => button("撤销上次编辑").click()); await draw();
      expect(current().displayProps.state).toEqual(original.displayProps.state);
      const validBefore = structuredClone(current());
      expect(update(original.id, { displayProps: { state: { items: [{ id: "bad", title: "Invalid", status: "unknown" }] } } })).toBe(false);
      expect(update(original.id, { displayProps: { data: { origin: "user" } } })).toBe(false);
      expect(current()).toEqual(validBefore);
      expect(validateExtensionCard(current()).ok).toBe(true);
      expect(CardRecordSchema.safeParse(JSON.parse(JSON.stringify(current()))).success).toBe(true);
      await owner.flush(canvasId, owner.getSnapshot().canvases.find(canvas => canvas.id === canvasId)!.version);
      const restored = await db.getCanvas(canvasId);
      expect(restored?.cardsById[original.id]?.displayProps).toEqual(original.displayProps);
    } finally { owner.stop(); }
  });
  it("keeps failed edits visible and prevents stale undo from overwriting newer changes", async () => {
    const definition = definitions[0]!, card = createExtensionInstance(definition, definition.examples[0]!);
    await render(view(card, definition, "tasks", "control", { editable: true, update: () => false }));
    await act(async () => container.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("没有保存");
    expect(button("撤销上次编辑")).toBeUndefined();
    let current = card;
    const update: CardActions["update"] = (_, patch) => { current = CardRecordSchema.parse({ ...current, displayProps: { ...current.displayProps, ...patch.displayProps } }) as CardOfType<"ExtensionCard">; return true; };
    await render(view(current, definition, "tasks", "control", { editable: true, update }));
    await act(async () => container.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
    current = { ...current, displayProps: { ...current.displayProps, config: { ...current.displayProps.config, title: "另一窗口的新标题" } } };
    await render(view(current, definition, "tasks", "control", { editable: true, update }));
    expect(button("撤销上次编辑")).toBeUndefined();
  });
});
