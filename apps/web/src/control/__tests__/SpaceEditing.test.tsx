// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canvasStore } from "@/state/canvasStore";
import { createMemoryDB } from "@/persistence/db";
import { createControlHost, type ControlHost } from "@/sync/controlHost";
import { createMemoryHub, flushChannel } from "@/sync/channel";
import { createMemoryLockProvider } from "@/sync/testing";
import { CanvasManager } from "../CanvasManager";
import { RemindersSection } from "../RemindersSection";
import { SpaceTools } from "../SpaceTools";

// These tests exercise owner mutations and save results. Native dialog focus,
// card rendering and the source surfaces are covered by browser verification.
vi.mock("../ControlDialogContent", () => ({ ControlDialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("../CardSubcardsSection", () => ({ CardSubcardsSection: () => null }));
vi.mock("@/extensions/ExtensionManager", () => ({ ExtensionManager: () => null }));

let root: Root, container: HTMLDivElement, host: ControlHost;
const button = (label: string, scope: ParentNode = document) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === label)!;
const click = (label: string, scope?: ParentNode) => act(async () => { button(label, scope).click(); });
const input = (label: string, value: string) => act(async () => {
  const field = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
});
const submit = () => act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  canvasStore.reset();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  host = createControlHost({ db: createMemoryDB(), channel: createMemoryHub().createChannel(), store: canvasStore,
    lockProvider: createMemoryLockProvider(), reminderPollMs: 1000000 });
  await host.start();
});
afterEach(async () => {
  await act(async () => root.unmount()); host.stop(); container.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("Space editors preserve explicit choices and confirmed outcomes", () => {
  it("cancels a rename with Escape and saves only a nonempty bounded title", async () => {
    const snapshot = host.getSnapshot(), id = snapshot.activeCanvasId!;
    const original = snapshot.canvases.find(canvas => canvas.id === id)!.title;
    await act(async () => root.render(<CanvasManager host={host} canvases={snapshot.canvases} activeCanvasId={id} readonly={false} />));
    await click("重命名"); await input("画布名称", "   ");
    expect(button("保存").disabled).toBe(true);
    await input("画布名称", "未保存的名字");
    const field = container.querySelector<HTMLInputElement>('input[aria-label="画布名称"]')!;
    expect(field.maxLength).toBe(120);
    await act(async () => { field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(host.getSnapshot().canvases.find(canvas => canvas.id === id)!.title).toBe(original);
    await click("重命名");
    expect(container.querySelector<HTMLInputElement>("input")!.value).toBe(original);
    await input("画布名称", "  工作 Space  "); await submit();
    expect(host.getSnapshot().canvases.find(canvas => canvas.id === id)!.title).toBe("工作 Space");
  });

  it("requires an explicit reminder delay and keeps the edited draft after a rejected save", async () => {
    const id = host.getSnapshot().activeCanvasId!;
    const created = host.dispatch({ schemaVersion: "0.6", canvasId: id, requestId: "seed-reminder", actions: [{ type: "card.create", card: {
      id: "reminder-edit", type: "CountdownCard", variant: "minimal", displayProps: {},
      sourceData: { startedAt: new Date().toISOString(), targetAt: new Date(Date.now() + 3600000).toISOString(), reminderText: "原提醒" },
      sources: [], layout: { x: 0, y: 0, width: 264, height: 96, pinned: false },
      metadata: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    } }] });
    expect(created.ok).toBe(true);
    await flushChannel();
    await act(async () => root.render(<RemindersSection host={host} readonly={false} hidePreferences />));
    await click("修改");
    expect(container.querySelector<HTMLInputElement>('[aria-label="提醒延后分钟"]')!.value).toBe("");
    const dispatch = vi.spyOn(host, "dispatch");
    await input("提醒内容", "保留这份草稿"); await submit();
    expect(dispatch).not.toHaveBeenCalled();
    await input("提醒延后分钟", "2");
    dispatch.mockReturnValueOnce({ ok: false, error: "readonly-not-owner" });
    await submit();
    expect(container.querySelector<HTMLInputElement>('[aria-label="提醒内容"]')!.value).toBe("保留这份草稿");
    expect(container.textContent).toContain("提醒尚未修改");
    await submit();
    expect(container.querySelector("form")).toBeNull();
    const record = canvasStore.getState().cards.find(card => card.record.id === "reminder-edit")!.record;
    expect(record.type === "CountdownCard" && record.sourceData.reminderText).toBe("保留这份草稿");
  });

  it("does not clear another canvas if the active Space changes after confirmation opens", async () => {
    const clear = vi.spyOn(host, "clearActiveCanvas");
    await act(async () => root.render(<SpaceTools host={host} onBeforeClear={() => {}} />));
    await click("Space"); await click("清空此画布");
    await act(async () => { host.switchCanvas(host.createCanvas("另一个 Space")); });
    await click("清空", document.querySelector('[role="alertdialog"]')!);
    expect(clear).not.toHaveBeenCalled();
    expect(container.textContent).toContain("画布或控制权已变化，未清空");
  });

  it.each([false, true])("reports clear completion only after persistence settles (failure=%s)", async failure => {
    let resolve!: () => void, reject!: (error: Error) => void;
    const pending = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const flushToMemory = host.flush;
    const flush = vi.spyOn(host, "flush").mockImplementation(async (canvasId, version) => {
      await pending; await flushToMemory(canvasId, version);
    });
    const before = host.getSnapshot(), id = before.activeCanvasId!;
    const version = before.canvases.find(canvas => canvas.id === id)!.version;
    await act(async () => root.render(<SpaceTools host={host} onBeforeClear={() => {}} />));
    await click("Space"); await click("清空此画布");
    await click("清空", document.querySelector('[role="alertdialog"]')!);
    expect(flush).toHaveBeenCalledWith(id, expect.any(Number));
    expect(flush.mock.calls[0]![1]).toBeGreaterThan(version);
    expect(container.textContent).not.toContain("已清空并保存当前画布");
    expect(button("正在清空…").disabled).toBe(true);
    await act(async () => { if (failure) reject(new Error("save unavailable")); else resolve(); });
    expect(container.textContent).toContain(failure ? "清空结果待确认" : "已清空并保存当前画布");
  });
});
