// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canvasStore } from "@/state/canvasStore";
import { createMemoryDB } from "@/persistence/db";
import { createControlHost, type ControlHost } from "@/sync/controlHost";
import { createMemoryHub, flushChannel } from "@/sync/channel";
import { createMemoryLockProvider } from "@/sync/testing";
import { BackgroundSettings } from "../BackgroundSettings";
import { viewForPath } from "../controlView";

let root: Root, container: HTMLDivElement, host: ControlHost;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  canvasStore.reset();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  host = createControlHost({ db: createMemoryDB(), channel: createMemoryHub().createChannel(), store: canvasStore,
    lockProvider: createMemoryLockProvider(), reminderPollMs: 1000000 });
  await host.start(); await flushChannel();
});
afterEach(async () => {
  await act(async () => root.unmount()); host.stop(); container.remove(); vi.unstubAllGlobals();
});
const render = (resolvedTheme: "light" | "dark" = "dark", disabled = false) =>
  act(async () => root.render(<BackgroundSettings host={host} resolvedTheme={resolvedTheme} disabled={disabled} />));
const palette = (id: string) => container.querySelector<HTMLButtonElement>(`[data-vivic-palette="${id}"]`)!;
const click = (button: HTMLElement) => act(async () => { button.click(); await flushChannel(); });

describe("BackgroundSettings", () => {
  it("offers the six dark and six light palettes, with 午夜蓝紫 selected by default", async () => {
    await render();
    expect(container.querySelectorAll('[role="group"][aria-label="深色配色"] [data-vivic-palette]')).toHaveLength(6);
    expect(container.querySelectorAll('[role="group"][aria-label="浅色配色"] [data-vivic-palette]')).toHaveLength(6);
    expect(palette("midnight").getAttribute("aria-pressed")).toBe("true");
    expect(palette("milk").getAttribute("aria-pressed")).toBe("true");
    expect(palette("midnight").dataset.vivicPaletteShown).toBe("true");
    expect(container.textContent).toContain("天空背景");
    expect(container.textContent).not.toMatch(/云雾光晕|丝绸柔光|漫游烟雾|晨曦极光|柔粒渐变/);
  });
  it("switches to the palette's appearance so the change is visible, and keeps 自动 when it already matches", async () => {
    await render();
    await click(palette("peach"));
    expect(host.getSnapshot().preferences).toMatchObject({ theme: "light", lightPalette: "peach" });
    await click(palette("ember"));
    expect(host.getSnapshot().preferences).toMatchObject({ theme: "dark", darkPalette: "ember", lightPalette: "peach" });
    expect(host.setPreferences({ theme: "auto" }).ok).toBe(true);
    await render("dark");
    await click(palette("ocean"));
    expect(host.getSnapshot().preferences).toMatchObject({ theme: "auto", darkPalette: "ocean" });
    await click(palette("mint"));
    expect(host.getSnapshot().preferences).toMatchObject({ theme: "light", lightPalette: "mint" });
  });
  it("is read-only without ownership", async () => {
    await render("dark", true);
    expect([...container.querySelectorAll("button")].every(button => button.disabled)).toBe(true);
  });
  it("saves the orb choice without changing the sky or appearance", async () => {
    await render();
    const before = host.getSnapshot().preferences;
    const button = container.querySelector<HTMLButtonElement>('[data-vivic-orb-palette="mint"]')!;
    await click(button);
    expect(host.getSnapshot().preferences).toEqual({ ...before, orbPalette: "mint" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(host.setPreferences({ orbPalette: "untrusted" } as never).ok).toBe(false);
  });
  it("synchronizes light intensity and pause without altering theme or orb", async () => {
    await render();
    const before = host.getSnapshot().preferences;
    await click(container.querySelector<HTMLButtonElement>('[data-vivic-motion-mode="vivid"]')!);
    expect(host.getSnapshot().preferences).toEqual({ ...before, ambientMotion: "vivid" });
    expect(host.setPreferences({ ambientIntensity: .8 }).ok).toBe(true);
    await render();
    expect(container.querySelector<HTMLInputElement>('[aria-label="光效强度"]')!.value).toBe("80");
    await click(container.querySelector<HTMLButtonElement>('[data-vivic-motion-mode="off"]')!);
    expect(container.querySelector<HTMLInputElement>('[aria-label="光效强度"]')!.disabled).toBe(true);
    expect(host.getSnapshot().preferences.ambientIntensity).toBe(.8);
    expect(host.setPreferences({ ambientIntensity: 1.01 }).ok).toBe(false);
  });
});

describe("viewForPath", () => {
  it("maps /control to settings and everything else served by Control to the user page", () => {
    expect(viewForPath("/control")).toBe("settings");
    expect(viewForPath("/control/")).toBe("settings");
    expect(viewForPath("/")).toBe("chat");
  });
});
