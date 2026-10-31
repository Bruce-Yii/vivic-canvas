// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileConsole } from "./MobileConsole";
import type { MobileClient, MobileState } from "@vivic/mobile-console-prototype/client";

const snapshot: NonNullable<MobileState["snapshot"]> = {
  computerName: "我的电脑", ownerAvailable: true, ownerEpoch: "owner-epoch", activeCanvasId: "canvas-1", version: 4,
  canvases: [{ id: "canvas-1", title: "今日计划", version: 4 }, { id: "canvas-2", title: "第二张画布", version: 2 }],
  cards: [{ id: "note-1", type: "NoteCard", title: "待整理的想法", pinned: false }],
};
let root: Root;
let container: HTMLDivElement;
let state: MobileState;
let client: MobileClient;
const button = (label: string) => Array.from(container.querySelectorAll("button")).find(item => item.getAttribute("aria-label") === label || item.textContent?.trim() === label || (label === "固定" && item.getAttribute("aria-label")?.startsWith("固定 ")))!;
const render = async () => { await act(async () => root.render(<MobileConsole client={client} initialRelayUrl="ws://127.0.0.1:8791/relay" />)); };
const input = async (selector: string, value: string) => {
  await act(async () => {
    const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
    const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const tab = (page: "chat" | "space") => container.querySelector<HTMLButtonElement>(`#mobile-tab-${page}`)!;
const visiblePage = () => container.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')?.id;
const touch = (target: Element, type: string, x: number, y: number, extraTouches = false) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const point = { identifier: 1, clientX: x, clientY: y };
  Object.defineProperties(event, {
    touches: { value: type === "touchend" ? [] : extraTouches ? [point, { ...point, identifier: 2 }] : [point] },
    changedTouches: { value: [point] },
  });
  target.dispatchEvent(event);
};
const swipe = async (target: Element, from: [number, number], to: [number, number], middle?: [number, number]) => {
  await act(async () => {
    touch(target, "touchstart", ...from);
    if (middle) touch(target, "touchmove", ...middle);
    touch(target, "touchend", ...to);
  });
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  state = { status: "connected", snapshot, requests: [], error: null, expiresAt: Date.now() + 60000 };
  client = {
    getSnapshot: () => state, subscribe: () => () => {}, pair: vi.fn(), reconnect: vi.fn(), disconnect: vi.fn(), revoke: vi.fn(),
    submit: vi.fn(() => "request-new"), cancel: vi.fn(), query: vi.fn(), refresh: vi.fn(),
  };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("mobile execution feedback", () => {
  it("moves one full card into chat only from the owner's updated snapshot and saved result, then sends it back", async () => {
    state.permissions = ["text.submit", "canvas.switch", "card.pin", "card.surface"];
    state.snapshot = { ...snapshot, cards: [{ ...snapshot.cards[0]!, surface: "display", pinned: true, preview: { kind: "text", body: "保持完整正文" }, subcards: [{ id: "detail", label: "便笺", text: "补充内容" }] }] };
    await render(); await act(async () => tab("space").click());
    await act(async () => button("移到聊天：待整理的想法").click());
    expect(client.submit).toHaveBeenCalledWith({ kind: "card.surface", cardId: "note-1", surface: "user" });
    expect(container.querySelectorAll('[data-mobile-card-id="note-1"]')).toHaveLength(1);
    expect(container.querySelector('#mobile-chat [data-mobile-card-id]')).toBeNull();
    state = { ...state, requests: [{ requestId: "request-new", canvasId: "canvas-1", operation: { kind: "card.surface", cardId: "note-1", surface: "user" }, status: "accepted", message: "等待电脑保存" }] };
    await render(); expect(visiblePage()).toBe("mobile-space");
    state = { ...state, snapshot: { ...state.snapshot!, version: 5, cards: [{ ...state.snapshot!.cards[0]!, surface: "user" }] }, requests: [{ ...state.requests[0]!, status: "succeeded", message: "已移到聊天并保存。" }] };
    await render();
    expect(visiblePage()).toBe("mobile-chat");
    expect(container.querySelector('#mobile-space [data-mobile-card-id]')).toBeNull();
    expect(container.querySelectorAll('[data-mobile-card-id="note-1"]')).toHaveLength(1);
    expect(container.querySelector('#mobile-chat [data-mobile-card-id]')!.textContent).toContain("保持完整正文");
    expect(button("取消固定 待整理的想法").getAttribute("aria-pressed")).toBe("true");
    await act(async () => button("移回 Space：待整理的想法").click());
    expect(client.submit).toHaveBeenLastCalledWith({ kind: "card.surface", cardId: "note-1", surface: "display" });
  });

  it("keeps portal unavailable for legacy grants and disables it on uncertain or offline connections", async () => {
    await render(); expect(button("移到聊天：待整理的想法")).toBeUndefined();
    state = { ...state, permissions: ["card.surface"], status: "offline" }; await render();
    expect(button("移到聊天：待整理的想法").disabled).toBe(true);
    state = { ...state, status: "connected", requests: [{ requestId: "unknown", canvasId: "canvas-1", operation: { kind: "card.surface", cardId: "note-1", surface: "user" }, status: "unknown", message: "未确认" }] }; await render();
    expect(button("移到聊天：待整理的想法").disabled).toBe(true);
    expect(client.submit).not.toHaveBeenCalled();
  });

  it("opens plain-text subcards in a bottom sheet and handles native back without changing the card", async () => {
    state.snapshot = { ...snapshot, cards: [{ ...snapshot.cards[0]!, subcards: [{ id: "detail", label: "第一行", text: "<img src=x onerror=alert(1)>" }] }] };
    await render(); await act(async () => tab("space").click());
    await act(async () => button("查看子卡片：待整理的想法").click());
    expect(container.querySelector('.mobile-subcards-sheet')!.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(container.querySelector('.mobile-subcards-sheet img')).toBeNull();
    const back = new Event("vivic:native-back", { cancelable: true }); await act(async () => window.dispatchEvent(back));
    expect(back.defaultPrevented).toBe(true); expect(container.querySelector('.mobile-subcards-sheet')).toBeNull();
    expect(visiblePage()).toBe("mobile-space"); expect(client.submit).not.toHaveBeenCalled();
  });
  it("does not present relay acceptance as computer execution", async () => {
    state.requests = [{ requestId: "request-1", canvasId: "canvas-1", operation: { kind: "text.submit", text: "记下我的想法" }, status: "accepted", message: "中继已送达，等待电脑执行确认。" }];
    await render();
    expect(container.textContent).toContain("中继已接收，等待电脑确认");
    expect(container.textContent).not.toContain("电脑已执行");
    expect(button("请求取消")).toBeDefined();
  });

  it("queries an uncertain write and blocks a new write instead of replaying", async () => {
    state.requests = [{ requestId: "request-1", canvasId: "canvas-1", operation: { kind: "text.submit", text: "创建便笺" }, status: "unknown", message: "执行结果未确认" }];
    await render();
    await input('[aria-label="发送给电脑的文字指令"]', "再创建一张");
    expect(container.querySelector<HTMLButtonElement>('[aria-label="发送指令"]')!.disabled).toBe(true);
    expect(button("固定").disabled).toBe(true);
    expect(container.querySelector<HTMLSelectElement>("#mobile-canvas")!.disabled).toBe(true);
    expect(button("重新发送")).toBeUndefined();
    await act(async () => button("查询执行结果").click());
    expect(client.query).toHaveBeenCalledWith("request-1");
    expect(client.submit).not.toHaveBeenCalled();
  });

  it("disables all write controls when the existing computer owner is unavailable", async () => {
    state.snapshot = { ...snapshot, ownerAvailable: false };
    await render();
    expect(container.textContent).toContain("电脑控制页不可用");
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="发送给电脑的文字指令"]')!.disabled).toBe(true);
    expect(button("固定").disabled).toBe(true);
    expect(container.querySelector<HTMLSelectElement>("#mobile-canvas")!.disabled).toBe(true);
    expect(client.submit).not.toHaveBeenCalled();
  });

  it("submits only whitelisted text and provides touch card pinning", async () => {
    await render();
    await input('[aria-label="发送给电脑的文字指令"]', "  记下明天的会议  ");
    await act(async () => container.querySelector("form.mobile-composer")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(client.submit).toHaveBeenCalledWith({ kind: "text.submit", text: "记下明天的会议" });
    await act(async () => tab("space").click());
    await act(async () => button("固定").click());
    expect(client.submit).toHaveBeenCalledWith({ kind: "card.pin", cardId: "note-1", pinned: true });
  });

  it("clears pairing input immediately and never stores the code", async () => {
    state = { ...state, status: "unpaired", snapshot: null };
    const storage = vi.spyOn(Storage.prototype, "setItem");
    await render();
    await input("#mobile-pair-code", "ABCD1234");
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(client.pair).toHaveBeenCalledWith("ws://127.0.0.1:8791/relay", "ABCD1234");
    expect(container.querySelector<HTMLInputElement>("#mobile-pair-code")!.value).toBe("");
    expect(storage).not.toHaveBeenCalled();
  });

  it("does not send an untrusted pairing URL to the client", async () => {
    state = { ...state, status: "unpaired", snapshot: null };
    await render();
    await input("#mobile-pair-code", "https://evil.example/#pair=0123456789ABCDEF");
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(container.querySelector('[role="alert"]')!.textContent).toContain("地址与此控制台不一致");
    expect(client.pair).not.toHaveBeenCalled();
  });

  it("offers a manual fallback when browser camera scanning is unavailable", async () => {
    state = { ...state, status: "unpaired", snapshot: null };
    await render();
    await act(async () => button("扫描电脑二维码").click());
    expect(container.textContent).toContain("此浏览器不支持内置扫码");
    await act(async () => button("返回输入配对码").click());
    expect(container.querySelector("dialog")).toBeNull();
    expect(client.pair).not.toHaveBeenCalled();
  });

  it("handles native back by closing settings without dropping the connection", async () => {
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="打开设置"]')!.click());
    const back = new Event("vivic:native-back", { cancelable: true });
    await act(async () => window.dispatchEvent(back));
    expect(back.defaultPrevented).toBe(true);
    expect(container.querySelector("#mobile-settings-title")).toBeNull();
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it("preserves multiline drafts through IME composition and sends only a confirmed Enter", async () => {
    await render();
    await input('[aria-label="发送给电脑的文字指令"]', "第一行\n第二行");
    const field = container.querySelector<HTMLTextAreaElement>('[aria-label="发送给电脑的文字指令"]')!;
    await act(async () => {
      field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(client.submit).not.toHaveBeenCalled();
    expect(field.value).toBe("第一行\n第二行");
    await act(async () => {
      field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(client.submit).not.toHaveBeenCalled();
    await act(async () => { field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    expect(client.submit).toHaveBeenCalledExactlyOnceWith({ kind: "text.submit", text: "第一行\n第二行" });
    expect(field.value).toBe("");
  });

  it("keeps the draft and each page's scroll position through two-page navigation and settings", async () => {
    await render();
    await input('[aria-label="发送给电脑的文字指令"]', "保留我的想法\n还有下一步");
    const field = container.querySelector<HTMLTextAreaElement>('[aria-label="发送给电脑的文字指令"]')!;
    const edited = field.value;
    const chat = container.querySelector<HTMLDivElement>(".mobile-chat-scroll")!;
    const space = container.querySelector<HTMLDivElement>(".mobile-space-scroll")!;
    Object.defineProperties(chat, { scrollHeight: { value: 1200 }, clientHeight: { value: 400 } });
    await act(async () => { chat.scrollTop = 140; chat.dispatchEvent(new Event("scroll")); });
    await act(async () => tab("space").click());
    await act(async () => { space.scrollTop = 220; space.dispatchEvent(new Event("scroll")); });
    await act(async () => tab("chat").click());
    expect(visiblePage()).toBe("mobile-chat");
    expect(chat.scrollTop).toBe(140);
    expect(container.querySelector('[aria-label="发送给电脑的文字指令"]')).toBe(field);
    expect(field.value).toBe(edited);
    await act(async () => tab("space").click());
    expect(space.scrollTop).toBe(220);
    await act(async () => button("打开设置").click());
    await act(async () => button("关闭设置").click());
    expect(visiblePage()).toBe("mobile-space");
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="发送给电脑的文字指令"]')!.value).toBe(edited);
    expect(client.submit).not.toHaveBeenCalled();
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it("keeps pairing usable when the keyboard opens, with no floating bottom navigation", async () => {
    state = { ...state, status: "unpaired", snapshot: null };
    const viewport = { height: 844, width: 390, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal("visualViewport", viewport);
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { fn(0); return 1; });
    await render();
    expect(container.querySelector(".mobile-bottom-nav")).toBeNull();
    await act(async () => {
      container.querySelector<HTMLInputElement>("#mobile-pair-code")!.focus();
      viewport.height = 420; window.dispatchEvent(new Event("resize"));
    });
    expect(container.querySelector(".mobile-bottom-nav")).toBeNull();
    expect(document.activeElement).toBe(container.querySelector("#mobile-pair-code"));
    expect(container.querySelector("[data-mobile-keyboard]")?.getAttribute("data-mobile-keyboard")).toBe("true");
    await act(async () => { viewport.height = 844; window.dispatchEvent(new Event("resize")); });
    expect(container.querySelector(".mobile-bottom-nav")).toBeNull();
    expect(client.pair).not.toHaveBeenCalled();
  });

  it("uses a right swipe from chat into Space and a left swipe back, without sending", async () => {
    await render();
    const views = container.querySelector(".mobile-views")!;
    expect(visiblePage()).toBe("mobile-chat");
    await swipe(views, [100, 200], [230, 210], [170, 205]);
    expect(visiblePage()).toBe("mobile-space");
    expect(tab("space").getAttribute("aria-selected")).toBe("true");
    await swipe(views, [240, 200], [100, 210], [170, 205]);
    expect(visiblePage()).toBe("mobile-chat");
    expect(client.submit).not.toHaveBeenCalled();
  });

  it("does not mistake vertical scrolling or a short drag for a page swipe", async () => {
    await render();
    const views = container.querySelector(".mobile-views")!;
    await swipe(views, [100, 100], [230, 185], [110, 160]);
    expect(visiblePage()).toBe("mobile-chat");
    await swipe(views, [100, 100], [145, 103]);
    expect(visiblePage()).toBe("mobile-chat");
    expect(client.submit).not.toHaveBeenCalled();
  });

  it("does not navigate from a form, an open sheet or a multi-touch gesture", async () => {
    await render();
    const views = container.querySelector(".mobile-views")!;
    const field = container.querySelector("textarea")!;
    await swipe(field, [100, 200], [230, 205]);
    expect(visiblePage()).toBe("mobile-chat");
    await act(async () => button("打开设置").click());
    await swipe(views, [100, 200], [230, 205]);
    expect(visiblePage()).toBe("mobile-chat");
    await act(async () => button("关闭设置").click());
    await act(async () => { touch(views, "touchstart", 100, 200); touch(views, "touchmove", 170, 205, true); touch(views, "touchend", 230, 205); });
    expect(visiblePage()).toBe("mobile-chat");
    expect(client.submit).not.toHaveBeenCalled();
  });

  it("renders actual Space card content and an explicit partial-sync notice, excluding user-page cards", async () => {
    state.snapshot = { ...snapshot, cardCount: 8, cardsTruncated: true, cards: [
      { ...snapshot.cards[0]!, surface: "display", preview: { kind: "text", body: "这是真实同步的卡片正文" } },
      { id: "user-only", title: "用户页专用卡片", type: "NoteCard", pinned: false, surface: "user", preview: { kind: "text", body: "不属于 Space" } },
    ] };
    await render();
    await act(async () => tab("space").click());
    const space = container.querySelector("#mobile-space")!;
    expect(space.textContent).toContain("这是真实同步的卡片正文");
    expect(space.textContent).toContain("手机当前显示部分卡片");
    expect(space.textContent).not.toContain("用户页专用卡片");
    expect(space.querySelectorAll("[data-mobile-card-preview]")).toHaveLength(1);
    expect(client.submit).not.toHaveBeenCalled();
  });

  it("offers exactly two main pages and limits the settings sheet to phone appearance and connection", async () => {
    await render();
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(container.querySelectorAll('[role="tabpanel"]')).toHaveLength(2);
    expect(container.querySelector(".mobile-bottom-nav")).toBeNull();
    expect(container.querySelector(".mobile-templates")).toBeNull();
    expect(container.querySelector(".mobile-device")).toBeNull();
    await act(async () => button("打开设置").click());
    const sheet = container.querySelector(".mobile-settings-sheet")!;
    expect(sheet.querySelector("#mobile-theme")).not.toBeNull();
    expect(sheet.querySelector("#mobile-text-size")).not.toBeNull();
    expect(sheet.querySelector('input[type="url"]')).toBeNull();
    expect(sheet.querySelector("#mobile-palette")).toBeNull();
    expect(sheet.textContent).toContain("其他设置请在电脑调整");
    expect(sheet.querySelectorAll(".mobile-session-actions > button")).toHaveLength(2);
    expect(container.querySelector(".mobile-context")).toBeNull();
    expect(container.querySelector(".mobile-space-card-actions")).toBeNull();
    expect(container.querySelector(".mobile-composer-caption")).toBeNull();
  });
});
