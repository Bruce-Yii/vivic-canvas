// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canvasStore } from "@/state/canvasStore";
import { createMemoryDB } from "@/persistence/db";
import { createControlHost, type ControlHost } from "@/sync/controlHost";
import { createMemoryHub, flushChannel } from "@/sync/channel";
import { createMemoryLockProvider } from "@/sync/testing";
import { CanvasSettings } from "../CanvasSettings";

let root: Root, container: HTMLDivElement, host: ControlHost;
const stops: Array<() => void> = [];
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  canvasStore.reset();
  canvasStore.setPreferences({ theme: "auto", reducedMotion: false, subtitles: true });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  const hub = createMemoryHub();
  host = createControlHost({ db: createMemoryDB(), channel: hub.createChannel(), store: canvasStore,
    lockProvider: createMemoryLockProvider(), reminderPollMs: 1000000 });
  stops.push(host.stop); await host.start();
  host.dispatch({ schemaVersion: "0.6", canvasId: host.getSnapshot().activeCanvasId, requestId: "seed",
    actions: [{ type: "card.create", card: { id: "a", type: "TodoCard", variant: "minimal", displayProps: { items: [{ id: "t", text: "Task", done: false }] },
      sourceData: {}, sources: [], layout: { x: 0, y: 0, width: 260, height: 120, pinned: false },
      metadata: { createdAt: "2026-10-15T00:00:00.000Z", updatedAt: "2026-10-15T00:00:00.000Z" } } }] });
  await flushChannel();
});
afterEach(async () => {
  await act(async () => root.unmount()); stops.splice(0).forEach(stop => stop());
  container.remove(); vi.unstubAllGlobals();
});
const render = (disabled = false, selectedCardId?: string) => act(async () => root.render(<CanvasSettings host={host} disabled={disabled} selectedCardId={selectedCardId} />));
const click = (button: HTMLElement) => act(async () => { button.click(); await flushChannel(); });
const setTime = (label: string, value: string) => act(async () => {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await flushChannel();
});

describe("CanvasSettings", () => {
  it("uses the owner APIs for theme, reduced motion, captions and pin", async () => {
    await render();
    await click([...container.querySelectorAll("button")].find(b => b.textContent === "深色")!);
    expect(host.getSnapshot().preferences.theme).toBe("dark");
    await click(container.querySelector<HTMLButtonElement>('#canvas-pref-reducedMotion')!);
    await click(container.querySelector<HTMLButtonElement>('#canvas-pref-subtitles')!);
    expect(host.getSnapshot().preferences).toEqual({ theme: "dark", reducedMotion: true, subtitles: false });
    await click(container.querySelector<HTMLButtonElement>('[data-vivic-pin="a"]')!);
    expect(canvasStore.getState().cards[0]!.record.layout.pinned).toBe(true);
    expect(container.querySelector('[data-vivic-pin="a"]')!.getAttribute("aria-pressed")).toBe("true");
  });
  it("disables every control while readonly or explicitly disabled", async () => {
    await render(true);
    expect([...container.querySelectorAll("button")].every(b => b.disabled)).toBe(true);
    expect([...container.querySelectorAll("input[type=time]")].every(input => (input as HTMLInputElement).disabled)).toBe(true);
    await act(async () => host.stop()); await render();
    expect([...container.querySelectorAll("button")].every(b => b.disabled)).toBe(true);
    expect([...container.querySelectorAll("input[type=time]")].every(input => (input as HTMLInputElement).disabled)).toBe(true);
  });
  it("shows accessible local time defaults without writing them, and saves explicit overnight edits through the owner", async () => {
    expect(host.getSnapshot().preferences.theme).toBe("auto");
    const update = vi.spyOn(host, "setPreferences");
    await render();
    expect(container.querySelector<HTMLInputElement>('input[aria-label="白天开始时间"]')?.value).toBe("07:00");
    expect(container.querySelector<HTMLInputElement>('input[aria-label="白天结束时间"]')?.value).toBe("19:00");
    expect(update).not.toHaveBeenCalled();
    expect(host.getSnapshot().preferences).toEqual({ theme: "auto", reducedMotion: false, subtitles: true });
    await setTime("白天开始时间", "22:15");
    await setTime("白天结束时间", "06:45");
    expect(update).toHaveBeenCalledWith({ dayStart: "22:15" });
    expect(update).toHaveBeenCalledWith({ dayEnd: "06:45" });
    expect(host.getSnapshot().preferences).toEqual({ theme: "auto", reducedMotion: false, subtitles: true, dayStart: "22:15", dayEnd: "06:45" });
    const calls = update.mock.calls.length;
    await setTime("白天开始时间", "");
    expect(update).toHaveBeenCalledTimes(calls);
    await click([...container.querySelectorAll("button")].find(button => button.textContent === "深色")!);
    expect(container.querySelector('input[type="time"]')).toBeNull();
    await click([...container.querySelectorAll("button")].find(button => button.textContent === "自动")!);
    expect(container.querySelector<HTMLInputElement>('input[aria-label="白天开始时间"]')?.value).toBe("22:15");
    expect(container.querySelector<HTMLInputElement>('input[aria-label="白天结束时间"]')?.value).toBe("06:45");
  });
  it("supports selected-card scope and gives feedback on rejected mutations", async () => {
    await render(false, "missing"); expect(container.querySelector('[data-vivic-pin]')).toBeNull();
    await render(false, "a");
    vi.spyOn(host, "setCardPinned").mockReturnValue({ ok: false, error: "readonly-not-owner" });
    await click(container.querySelector<HTMLButtonElement>('[data-vivic-pin="a"]')!);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("尚未保存");
    expect(canvasStore.getState().cards[0]!.record.layout.pinned).toBe(false);
  });
});
