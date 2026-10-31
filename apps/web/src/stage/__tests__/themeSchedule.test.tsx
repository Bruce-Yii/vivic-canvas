// @vitest-environment jsdom
import { act, type CSSProperties, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canvasStore } from "@/state/canvasStore";
import { emptyVivicState } from "@/persistence/canvasRecord";
import { StageRoot } from "../StageRoot";

// Keep real StageRoot, CanvasView, schedule resolution and preference store.
// Replace GPU/motion/Flow rendering only; inspect the actual passed theme prop.
const camera = vi.hoisted(() => ({ fitView: vi.fn(), setCenter: vi.fn(), setViewport: vi.fn(), getViewport: () => ({ x: 0, y: 0, zoom: 1 }), viewportInitialized: true }));
vi.mock("@xyflow/react", () => ({
  ReactFlowProvider: ({ children }: { children: ReactNode }) => children,
  ReactFlow: ({ colorMode }: { colorMode: string }) => <div data-test-flow-theme={colorMode} />,
  useReactFlow: () => camera,
}));
vi.mock("@/cards/VivicCard", () => ({ VivicCard: () => null }));
vi.mock("@/sync/browserRuntime", () => ({ beginCanvasDrag: vi.fn(), commitCanvasDrag: vi.fn(), getDisplayStatus: vi.fn(() => null), subscribeDisplayStatus: vi.fn(() => () => {}),
  requestCardSurface: vi.fn(), requestCardFocus: vi.fn(), requestCanvasFit: vi.fn(), requestFocusRestore: vi.fn() }));
vi.mock("../BackgroundLayer", () => ({ BackgroundLayer: ({ theme }: { theme: string }) => <div data-test-background-theme={theme} /> }));
vi.mock("../AwakeningClock", () => ({ AwakeningClock: () => null }));
vi.mock("../OrbLayer", () => ({ OrbLayer: () => null }));
vi.mock("../SubtitleLayer", () => ({ SubtitleLayer: () => null }));
vi.mock("motion/react", () => ({
  MotionConfig: ({ children }: { children: ReactNode }) => children,
  useReducedMotion: () => false,
  motion: { div: ({ children, style }: { children?: ReactNode; style?: CSSProperties }) => <div style={style}>{children}</div> },
}));

let root: Root, container: HTMLDivElement, hidden: boolean;
const local = (hour: number, minute: number, second = 0, ms = 0, day = 15) => new Date(2026, 9, day, hour, minute, second, ms);
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(local(6, 59, 45, 250));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  canvasStore.reset();
  canvasStore.setPreferences({ theme: "auto", reducedMotion: false, subtitles: true });
  canvasStore.loadState({ ...emptyVivicState(), stage: "WORKSPACE" });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  const timers = vi.getTimerCount();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  expect(timers).toBe(0);
});
const render = () => act(async () => root.render(<StageRoot />));
const assertTheme = (theme: "light" | "dark") => {
  expect(container.querySelector("[data-vivic-theme]")?.getAttribute("data-vivic-theme")).toBe(theme);
  expect(container.querySelector("[data-test-background-theme]")?.getAttribute("data-test-background-theme")).toBe(theme);
  expect(container.querySelector("[data-test-flow-theme]")?.getAttribute("data-test-flow-theme")).toBe(theme);
};
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const visibility = () => act(async () => { document.dispatchEvent(new Event("visibilitychange")); });

describe("live local theme scheduling", () => {
  it("switches at the next actual minute boundary, with one shared theme for stage/background/ReactFlow", async () => {
    await render(); assertTheme("dark");
    expect(vi.getTimerCount()).toBe(1);
    await advance(14749); assertTheme("dark");
    await advance(1); assertTheme("light");
    vi.setSystemTime(local(18, 59, 59)); await visibility(); assertTheme("light");
    await advance(1000); assertTheme("dark");
  });

  it("supports overnight boundaries and immediately recomputes after a hidden window resumes", async () => {
    vi.setSystemTime(local(22, 14, 30));
    canvasStore.setPreferences({ theme: "auto", reducedMotion: false, subtitles: true, dayStart: "22:15", dayEnd: "06:45" });
    await render(); assertTheme("dark");
    await advance(30000); assertTheme("light");
    hidden = true; await visibility();
    expect(vi.getTimerCount()).toBe(0);
    vi.setSystemTime(local(6, 44, 59, 0, 16));
    hidden = false; await visibility(); assertTheme("light");
    await advance(1000); assertTheme("dark");
  });

  it("responds to schedule preference changes without waiting for a timer", async () => {
    vi.setSystemTime(local(10, 10));
    await render(); assertTheme("light");
    await act(async () => canvasStore.setPreferences({ theme: "auto", reducedMotion: false, subtitles: true, dayStart: "10:11", dayEnd: "12:00" }));
    assertTheme("dark");
    await advance(60000); assertTheme("light");
  });

  it("manual override disables the Auto clock and switching back uses current local time", async () => {
    canvasStore.setPreferences({ theme: "light", reducedMotion: false, subtitles: true });
    await render(); assertTheme("light");
    expect(vi.getTimerCount()).toBe(0);
    vi.setSystemTime(local(23, 0));
    await act(async () => canvasStore.setPreferences({ theme: "auto", reducedMotion: false, subtitles: true }));
    assertTheme("dark");
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => canvasStore.setPreferences({ theme: "dark", reducedMotion: false, subtitles: true }));
    assertTheme("dark");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("pageshow restoration recomputes a suspended clock and unmount removes its listeners", async () => {
    vi.setSystemTime(local(12, 0));
    await render(); assertTheme("light");
    vi.setSystemTime(local(23, 0));
    await act(async () => { window.dispatchEvent(new Event("pageshow")); });
    assertTheme("dark");
    await act(async () => root.render(null));
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("pageshow"));
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
