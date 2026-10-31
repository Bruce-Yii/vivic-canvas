// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CardActionsContext, CardModeContext } from "../scene/cardContext";
import { buildSceneFixtures } from "../scene/fixtures";
import { ProgressRingCardView } from "../scene/views/ProgressRingCardView";
import { BookCardView } from "../scene/views/BookCardView";
import { NotificationCardView } from "../scene/views/NotificationCardView";
import { TravelOffersCardView } from "../scene/views/TravelOffersCardView";
import { CardRecordSchema, type CardOfType } from "@/contracts";

let host: HTMLDivElement, root: Root;
const render = async (node: ReactNode, update = vi.fn(() => false), mode: "control" | "display" = "control") => {
  await act(async () => root.render(<CardModeContext.Provider value={mode}><CardActionsContext.Provider value={{ editable: true, update }}>{node}</CardActionsContext.Provider></CardModeContext.Provider>));
};
const input = async (label: string, value: string) => {
  const element = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
  await act(async () => {
    element.focus();
    Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => element.blur());
  return element;
};
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("card edit feedback and retained drafts", () => {
  it("keeps a rejected progress draft, retries the same number, and never turns blank input into zero", async () => {
    const card = buildSceneFixtures().goal_progress as CardOfType<"ProgressRingCard">;
    const update = vi.fn(() => false);
    await render(<ProgressRingCardView card={card} />, update);
    const field = await input("当前完成量", "27");
    expect(field.value).toBe("27"); expect(host.querySelector('[role="alert"]')?.textContent).toContain("没有保存");
    expect(update).toHaveBeenCalledWith(card.id, { displayProps: { current: 27 } });
    update.mockReturnValue(true);
    await act(async () => { field.focus(); field.blur(); });
    expect(host.querySelector('[role="alert"]')).toBeNull();
    update.mockClear();
    await input("当前完成量", "");
    expect(update).not.toHaveBeenCalled(); expect(host.textContent).toContain("请输入完成量");
  });
  it("keeps the book page draft when the owner rejects a write", async () => {
    const card = buildSceneFixtures().book_record as CardOfType<"BookCard">;
    await render(<BookCardView card={card} />);
    expect((await input("当前页码", "123")).value).toBe("123");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("没有保存");
  });
  it("reports rejected notification status without turning it into a timer", async () => {
    const card = buildSceneFixtures().single_notification as CardOfType<"NotificationCard">;
    const update = vi.fn(() => false);
    await render(<NotificationCardView card={card} />, update);
    await act(async () => host.querySelector<HTMLButtonElement>("[data-notice-done]")!.click());
    expect(update).toHaveBeenCalledWith(card.id, { displayProps: { status: "done" } });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("没有保存");
    expect(host.querySelector("[data-status]")?.getAttribute("data-status")).toBe("unread");
  });
  it("retains travel notes on rejection and replaces a failed offer image with a visible fallback", async () => {
    const original = buildSceneFixtures().travel_offers as CardOfType<"TravelOffersCard">;
    const card = CardRecordSchema.parse({ ...original, displayProps: { ...original.displayProps, items: original.displayProps.items.map(item => ({ ...item, imageUrl: "https://example.invalid/image.png" })) } }) as CardOfType<"TravelOffersCard">;
    const update = vi.fn(() => false);
    await render(<TravelOffersCardView card={card} />, update);
    expect((await input("旅游备注", "保留我的选择理由")).value).toBe("保留我的选择理由");
    expect(update).toHaveBeenCalledWith(card.id, { displayProps: { notes: "保留我的选择理由" } });
    expect(host.textContent).toContain("没有保存");
    await act(async () => host.querySelector("img")!.dispatchEvent(new Event("error")));
    expect(host.querySelector("[data-scene-image-placeholder=missing]")).not.toBeNull();
    expect(host.textContent).toContain("虚构样例");
  });
  it("never exposes edit fields on Display even with a writable actions context", async () => {
    const fixtures = buildSceneFixtures(), update = vi.fn(() => true);
    await render(<><ProgressRingCardView card={fixtures.goal_progress as CardOfType<"ProgressRingCard">} /><BookCardView card={fixtures.book_record as CardOfType<"BookCard">} /><NotificationCardView card={fixtures.single_notification as CardOfType<"NotificationCard">} /><TravelOffersCardView card={fixtures.travel_offers as CardOfType<"TravelOffersCard">} /></>, update, "display");
    expect(host.querySelector("input,textarea,select,[data-notice-tools],[data-progress-editor]")).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });
});
