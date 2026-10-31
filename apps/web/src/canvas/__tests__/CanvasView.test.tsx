// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactFlowProps } from "@xyflow/react";
import { canvasStore } from "@/state/canvasStore";
import { emptyVivicState } from "@/persistence/canvasRecord";
import { beginCanvasDrag, commitCanvasDrag, getDisplayStatus } from "@/sync/browserRuntime";
import { CanvasView } from "../CanvasView";

const flow = vi.hoisted(() => ({ props: {} as ReactFlowProps, camera: {
  fitView: vi.fn(), setCenter: vi.fn(), setViewport: vi.fn(), getViewport: vi.fn(),
} }));
vi.mock("@xyflow/react", () => ({
  ReactFlowProvider: ({ children }: { children: ReactNode }) => children,
  ReactFlow: (props: ReactFlowProps) => { flow.props = props; return null; },
  useReactFlow: () => flow.camera,
}));
vi.mock("@/cards/VivicCard", () => ({ VivicCard: () => null }));
vi.mock("@/sync/browserRuntime", () => ({ beginCanvasDrag: vi.fn(), commitCanvasDrag: vi.fn(), getDisplayStatus: vi.fn(() => null), subscribeDisplayStatus: vi.fn(() => () => {}),
  requestCardSurface: vi.fn(), requestCardFocus: vi.fn(), requestCanvasFit: vi.fn(), requestFocusRestore: vi.fn() }));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  canvasStore.reset(); canvasStore.setPreferences({ theme: "auto", reducedMotion: false, subtitles: true });
  canvasStore.loadState({ ...emptyVivicState(), stage: "WORKSPACE", cards: [{ record: {
    id: "a", type: "TodoCard", variant: "minimal", displayProps: { items: [{ id: "task", text: "task", done: false }] }, sourceData: {}, sources: [],
    layout: { x: 0, y: 0, width: 260, height: 120, pinned: false }, metadata: { createdAt: "2026-10-15T00:00:00.000Z", updatedAt: "2026-10-15T00:00:00.000Z" },
  } }] });
  vi.mocked(beginCanvasDrag).mockReturnValue({ canvasId: "c", ownerEpoch: "owner", version: 1,
    requestId: "drag", cardId: "a", from: { ...canvasStore.getState().cards[0]!.record.layout } });
  vi.mocked(commitCanvasDrag).mockReturnValue(true);
  vi.mocked(getDisplayStatus).mockReturnValue(null);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(<CanvasView />));
const start = () => act(async () => flow.props.onNodeDragStart?.({} as never, flow.props.nodes![0]!, flow.props.nodes!));
const move = () => act(async () => flow.props.onNodesChange?.([{ type: "position", id: "a", position: { x: 70, y: 80 }, dragging: true }]));
const stop = () => act(async () => flow.props.onNodeDragStop?.({} as never, { ...flow.props.nodes![0]!, position: { x: 70, y: 80 } }, flow.props.nodes!));

describe("CanvasView interaction boundary", () => {
  it("preserves this view's camera when a focused owner snapshot remounts the workspace", async () => {
    const viewport = { x: 458, y: 466, zoom: 0.7 };
    vi.mocked(getDisplayStatus).mockReturnValue({ viewKey: "camera-remount-owner:canvas" } as never);
    flow.camera.getViewport.mockReturnValue(viewport);
    await render();
    await act(async () => root.render(null));
    // The owner's shared state can still have its own zero viewport. This
    // window must retain the camera it actually showed before the remount.
    await act(async () => canvasStore.loadState({ ...canvasStore.getState(),
      viewport: { x: 0, y: 0, zoom: 1 },
      focus: { cardId: "a", prevViewport: { x: 0, y: 0, zoom: 1 } },
    }));
    await render();
    expect(flow.props.defaultViewport).toEqual(viewport);
    expect(flow.props.fitView).toBe(false);
    await act(async () => canvasStore.dispatch({ schemaVersion: "0.6", requestId: "remount-restore", canvasId: "c", actions: [{ type: "canvas.restore" }] }));
    expect(flow.camera.setViewport).toHaveBeenLastCalledWith(viewport, expect.objectContaining({ duration: 420 }));
    // An owner/canvas scope change must not inherit the previous window view.
    await act(async () => root.render(null));
    vi.mocked(getDisplayStatus).mockReturnValue({ viewKey: "camera-remount-other-owner:canvas" } as never);
    await render();
    expect(flow.props.defaultViewport).toBeUndefined();
    expect(flow.props.fitView).toBe(true);
  });
  it("restores this Display's camera after focus and lets show-all own its camera transition", async () => {
    const viewport = { x: 140, y: -60, zoom: 0.7 };
    flow.camera.getViewport.mockReturnValue(viewport);
    await render();
    const dispatch = (requestId: string, actions: Array<{ type: "card.focus"; targetId: string } | { type: "canvas.restore" | "canvas.fit" }>) =>
      act(async () => { canvasStore.dispatch({ schemaVersion: "0.6", requestId, canvasId: "c", actions }); });
    await dispatch("focus", [{ type: "card.focus", targetId: "a" }]);
    await dispatch("restore", [{ type: "canvas.restore" }]);
    expect(flow.camera.setViewport).toHaveBeenCalledWith(viewport, expect.objectContaining({ duration: 420 }));
    await dispatch("focus-again", [{ type: "card.focus", targetId: "a" }]);
    flow.camera.setViewport.mockClear();
    await dispatch("show-all", [{ type: "canvas.fit" }]);
    expect(flow.camera.fitView).toHaveBeenCalled();
    expect(flow.camera.setViewport).not.toHaveBeenCalled();
  });
  it("retains measured dimensions through drag previews without writing measurements to shared records", async () => {
    await render();
    await act(async () => flow.props.onNodesChange?.([{ type: "dimensions", id: "a", dimensions: { width: 260, height: 96 } }]));
    await start(); await move();
    expect(flow.props.nodes![0]!.measured).toEqual({ width: 260, height: 96 });
    expect(canvasStore.getState().cards[0]!.record.layout.height).toBe(120);
  });
  it("keeps drag previews outside the store and rolls back a dropped request", async () => {
    await render(); await start(); await move();
    expect(flow.props.nodes![0]!.position).toEqual({ x: 70, y: 80 });
    expect(canvasStore.getState().cards[0]!.record.layout.x).toBe(0);
    await stop(); expect(commitCanvasDrag).toHaveBeenCalledWith(expect.objectContaining({ cardId: "a" }), 70, 80);
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(flow.props.nodes![0]!.position).toEqual({ x: 0, y: 0 });
  });
  it("discards the active drag when an owner snapshot pins or removes its card", async () => {
    await render(); await start(); await move();
    await act(async () => canvasStore.loadState({ ...canvasStore.getState(), cards: canvasStore.getState().cards.map(c => ({ record: { ...c.record, layout: { ...c.record.layout, pinned: true } } })) }));
    expect(flow.props.nodes![0]!.draggable).toBe(false);
    expect(flow.props.nodes![0]!.position).toEqual({ x: 0, y: 0 });
    await stop(); expect(commitCanvasDrag).not.toHaveBeenCalled();
  });
  it("accepts no preview or commit without a live owner", async () => {
    vi.mocked(beginCanvasDrag).mockReturnValue(null);
    await render(); await start(); await move(); await stop();
    expect(flow.props.nodes![0]!.position).toEqual({ x: 0, y: 0 });
    expect(commitCanvasDrag).not.toHaveBeenCalled();
  });
  it("honors reduced camera motion, theme and a fit range that accommodates 60 cards", async () => {
    await act(async () => canvasStore.setPreferences({ theme: "dark", reducedMotion: true, subtitles: true }));
    await render();
    expect(flow.props.minZoom).toBe(0.05); expect(flow.props.fitViewOptions?.minZoom).toBe(0.05);
    expect(flow.props.colorMode).toBe("dark");
    await act(async () => canvasStore.dispatch({ schemaVersion: "0.6", requestId: "fit", canvasId: "c", actions: [{ type: "canvas.fit" }] }));
    expect(flow.camera.fitView).toHaveBeenCalledWith(expect.objectContaining({ minZoom: 0.05, duration: 0 }));
  });
});
