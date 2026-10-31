// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HarkCanvasBackdrop } from "@/components/hark/HarkCanvasBackdrop";
import { ambientMode, ambientStrength, emitSpaceFeedback } from "../spaceMotion";

vi.mock("motion/react", () => ({ useReducedMotion: () => false }));
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("keeps source sky when motion is paused, zero-intensity or reduced", async () => {
  for (const props of [{ motionMode: "off" as const }, { intensity: 0 }, { paused: true }]) {
    await act(async () => root.render(<HarkCanvasBackdrop theme="light" palette="milk" {...props} />));
    expect(host.querySelector('[data-hark-sky="source-shader-frozen"]')).not.toBeNull();
    expect(host.querySelector('[data-space-running="false"]')).not.toBeNull();
    await act(async () => emitSpaceFeedback({ kind: "saved" }));
    expect(host.querySelector('[data-space-receipt]')).toBeNull();
  }
  expect(host.querySelector("canvas")).toBeNull();
});

it("pauses while the document is hidden and resumes without reloading source assets", async () => {
  await act(async () => root.render(<HarkCanvasBackdrop theme="dark" palette="ocean" motionMode="vivid" />));
  const sky = host.querySelector('[data-hark-sky]');
  expect(host.querySelector('[data-space-running="true"]')).not.toBeNull();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(host.querySelector('[data-space-running="false"]')).not.toBeNull();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(host.querySelector('[data-space-running="true"]')).not.toBeNull();
  expect(host.querySelector('[data-hark-sky]')).toBe(sky);
});

it("shows a receipt only following an explicit successful-operation signal", async () => {
  await act(async () => root.render(<HarkCanvasBackdrop theme="light" palette="milk" phase="thinking" />));
  expect(host.querySelector('[data-space-phase="thinking"]')).not.toBeNull();
  expect(host.querySelector('[data-space-receipt]')).toBeNull();
  await act(async () => emitSpaceFeedback({ kind: "transfer", cardIds: ["a"] }));
  expect(host.querySelector('[data-space-receipt="transfer"]')).not.toBeNull();
  await act(async () => root.render(<HarkCanvasBackdrop theme="light" palette="milk" paused />));
  expect(host.querySelector('[data-space-receipt]')).toBeNull();
});

it("bounds intensity and provides stable defaults for older snapshots", () => {
  expect(ambientStrength(undefined)).toBe(.55);
  expect(ambientStrength(NaN)).toBe(.55);
  expect(ambientStrength(-3)).toBe(0);
  expect(ambientStrength(8)).toBe(1);
  expect(ambientMode(undefined)).toBe("subtle");
  expect(ambientMode("vivid")).toBe("vivid");
  expect(ambientMode("untrusted")).toBe("subtle");
});

it("honors a live OS reduced-motion change without reloading the page", async () => {
  const listeners = new Set<() => void>();
  const query = { matches: false, addEventListener: (_: string, fn: () => void) => listeners.add(fn), removeEventListener: (_: string, fn: () => void) => listeners.delete(fn) };
  vi.stubGlobal("matchMedia", () => query);
  await act(async () => root.render(<HarkCanvasBackdrop theme="light" palette="milk" motionMode="vivid" />));
  expect(host.querySelector('[data-space-running="true"]')).not.toBeNull();
  await act(async () => { query.matches = true; listeners.forEach(fn => fn()); });
  expect(host.querySelector('[data-reduced-motion="true"]')).not.toBeNull();
  expect(host.querySelector('[data-space-running="false"]')).not.toBeNull();
});
