// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { BackgroundLayer } from "../BackgroundLayer";

const preferences = vi.hoisted(() => ({ current: { reducedMotion: true } as Record<string, unknown> }));
vi.mock("@/state/canvasStore", () => ({ useDisplayPreferences: () => preferences.current,
  useVivicState: (selector: (state: unknown) => unknown) => selector({ stage: "WORKSPACE", activity: null, focus: null }) }));
vi.mock("motion/react", () => ({ useReducedMotion: () => false }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ""; });

it("the Hark sky requires no graphics context, including across theme switches and unmount", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext");
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  for (const theme of ["dark", "light", "dark"] as const) {
    await act(async () => root.render(<BackgroundLayer theme={theme} />));
    expect(host.querySelector("canvas")).toBeNull();
    expect(host.querySelector('[data-hark-sky="source-shader-frozen"]')?.getAttribute("data-theme")).toBe(theme);
    expect(host.querySelector('[data-vivic-layer="background"]')).not.toBeNull();
  }
  await act(async () => root.unmount());
  expect(getContext).not.toHaveBeenCalled();
});

it("retains synchronized palette and reduced-motion preferences without altering the source default sky", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  preferences.current = { reducedMotion: true };
  await act(async () => root.render(<BackgroundLayer theme="dark" />));
  const background = host.querySelector<HTMLElement>('[data-vivic-layer="background"]')!;
  expect(background.dataset.vivicAtmosphere).toBe("midnight");
  expect(background.dataset.reducedMotion).toBe("true");
  expect(host.querySelector<HTMLElement>(".hark-palette-tint")!.style.backgroundColor).toBe("transparent");
  preferences.current = { reducedMotion: false, lightPalette: "mint" };
  await act(async () => root.render(<BackgroundLayer theme="light" />));
  expect(background.dataset.vivicAtmosphere).toBe("mint");
  expect(background.hasAttribute("data-reduced-motion")).toBe(false);
  expect(host.querySelector<HTMLElement>(".hark-palette-tint")!.style.backgroundColor).not.toBe("transparent");
  await act(async () => root.unmount());
});
