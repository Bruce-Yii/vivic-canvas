// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CardRecordSchema, SCENE_CARD_TYPE, SCENE_IDS, SCENES, sceneOfCard, type CardRecord, type CardType } from "@/contracts";
import { VivicCard } from "../VivicCard";
import { CARD_VIEWS } from "../registry";
import { fixedContentHeight } from "../sizing";
import { CardActionsContext, CardModeContext, type CardActions } from "../scene/cardContext";
import { buildEdgeFixtures, buildSceneFixtures } from "../scene/fixtures";
import { createMemoryDB } from "@/persistence/db";
import { createMemoryHub, flushChannel } from "@/sync/channel";
import { createControlHost } from "@/sync/controlHost";
import { createMemoryLockProvider } from "@/sync/testing";
import { createCanvasStore } from "@/state/canvasStore";

class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
let host: HTMLDivElement;
let root: Root;
const render = async (node: ReactNode) => {
  await act(async () => {
    root.render(node);
    // Keep actual lazy-module resolution within React's test transaction.
    await Promise.all([import("../ChartCardView"), import("../scene/views/TravelOffersCardView"), import("@/extensions/ExtensionCardView")]);
  });
  expect(host.textContent).not.toContain("正在加载卡片…");
};
const control = (node: ReactNode, actions: CardActions) => <CardModeContext.Provider value="control"><CardActionsContext.Provider value={actions}>{node}</CardActionsContext.Provider></CardModeContext.Provider>;

beforeAll(async () => {
  await Promise.all([import("../ChartCardView"), import("../scene/views/TravelOffersCardView"), import("@/extensions/ExtensionCardView")]);
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("scene card registry", () => {
  it("has exactly one renderer for each of the 21 scene card types and the extension host", () => {
    for (const scene of SCENES) {
      const view = CARD_VIEWS[scene.cardType as CardType];
      expect(typeof view === "function" || (typeof view === "object" && view !== null
        && Reflect.get(view, "$$typeof") === Symbol.for("react.lazy"))).toBe(true);
    }
    expect(Object.keys(CARD_VIEWS)).toHaveLength(27);
  });
  it("ships schema-valid sample data whose scene round-trips through the registry", () => {
    const fixtures = buildSceneFixtures();
    for (const scene of SCENE_IDS) {
      const card = CardRecordSchema.parse(fixtures[scene]);
      expect(card.type).toBe(SCENE_CARD_TYPE[scene]);
      expect(sceneOfCard(card)).toBe(scene);
    }
    for (const { card } of buildEdgeFixtures()) expect(CardRecordSchema.safeParse(card).success).toBe(true);
  });
});

describe("every scene card renders in both modes", () => {
  const all = (): Array<{ label: string; card: CardRecord }> => [
    ...Object.entries(buildSceneFixtures()).map(([label, card]) => ({ label, card })),
    ...buildEdgeFixtures(),
  ];
  it.each(all())("display: $label", async ({ card }) => {
    const errors = vi.spyOn(console, "error");
    await render(<div className="vivic-card"><VivicCard record={card} height={fixedContentHeight(card)} /></div>);
    expect(host.querySelector("[data-card-render-error]")).toBeNull();
    expect(host.textContent!.length).toBeGreaterThan(0);
    // The stage shows content, not editing: no text fields or file pickers.
    expect(host.querySelector("input:not([type=checkbox]):not([type=file]), textarea, select")).toBeNull();
    expect(errors).not.toHaveBeenCalled();
  });
  it.each(all())("user page: $label", async ({ card }) => {
    const errors = vi.spyOn(console, "error");
    await render(control(<VivicCard record={card} />, { editable: true, update: () => true, remove: () => true, addPhotos: async () => [] }));
    expect(host.querySelector("[data-card-render-error]")).toBeNull();
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("contained failures and real edits", () => {
  it("a card that throws while rendering shows a fallback instead of blanking the page", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken = { ...buildSceneFixtures().goal_progress, displayProps: null } as unknown as CardRecord;
    await render(<><VivicCard record={broken} /><VivicCard record={buildSceneFixtures().quote_note} /></>);
    expect(host.querySelector("[data-card-render-error=ProgressRingCard]")?.textContent).toContain("暂时无法显示");
    expect(host.textContent).toContain("好的想法");
  });

  it("ticking a todo on the user page goes through the owner and reaches the Display state", async () => {
    const hub = createMemoryHub(), store = createCanvasStore();
    const owner = createControlHost({ db: createMemoryDB(), store, channel: hub.createChannel(), lockProvider: createMemoryLockProvider(), reminderPollMs: 1000000 });
    await owner.start();
    const canvasId = owner.getSnapshot().activeCanvasId!;
    const todo = buildSceneFixtures().todo_list;
    owner.dispatch({ schemaVersion: "0.6", canvasId, requestId: "seed", actions: [{ type: "card.create", card: todo }] });
    const update: CardActions["update"] = (cardId, patch) => owner.dispatch({ schemaVersion: "0.6", canvasId, requestId: `edit-${Math.random()}`,
      actions: [{ type: "card.update", targetId: cardId, ...patch }] }).ok;
    const current = () => store.getState().cards.find(entry => entry.record.id === todo.id)!.record as Extract<CardRecord, { type: "TodoCard" }>;
    await render(control(<VivicCard record={current()} />, { editable: true, update }));
    const toggle = host.querySelector<HTMLButtonElement>('[data-vivic-todo-toggle="item-3"]')!;
    await act(async () => toggle.click());
    expect(current().displayProps.items.find(item => item.id === "item-3")?.done).toBe(true);
    await flushChannel();
    owner.stop();
  });

  it("the Display todo stays read-only and summarises hidden rows", async () => {
    const todo = { ...buildSceneFixtures().todo_list, displayProps: { title: "很多事", items: Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, text: `任务 ${i}`, done: i < 3 })) } } as CardRecord;
    await render(<VivicCard record={todo} />);
    expect(host.querySelectorAll("[data-vivic-todo-row]")).toHaveLength(5);
    expect(host.querySelector("[data-vivic-todo-progress]")?.textContent).toBe("3/8");
    expect(host.querySelector("[data-vivic-todo-more]")?.textContent).toContain("还有 3 项");
    expect(host.querySelector("[data-vivic-todo-toggle]")).toBeNull();
  });
});
