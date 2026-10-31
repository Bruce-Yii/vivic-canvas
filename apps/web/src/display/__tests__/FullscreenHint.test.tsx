// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FullscreenHint } from "../FullscreenHint";

let root: Root, container: HTMLDivElement, currentFullscreen: Element | null;
let request: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  currentFullscreen = null;
  Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: true });
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => currentFullscreen });
  request = vi.fn(async () => {
    currentFullscreen = document.documentElement;
    document.dispatchEvent(new Event("fullscreenchange"));
  });
  Object.defineProperty(document.documentElement, "requestFullscreen", { configurable: true, value: request });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  Reflect.deleteProperty(document, "fullscreenEnabled"); Reflect.deleteProperty(document, "fullscreenElement");
  Reflect.deleteProperty(document.documentElement, "requestFullscreen"); vi.unstubAllGlobals();
});
const render = () => act(async () => root.render(<FullscreenHint />));
const button = (text: string) => Array.from(container.querySelectorAll("button")).find(item => item.textContent === text)!;

describe("Vivic Space fullscreen entry", () => {
  it("waits for a click, hides its hint only after entering fullscreen, and returns after exit", async () => {
    await render(); expect(request).not.toHaveBeenCalled();
    await act(async () => button("点击隐藏顶部栏").click());
    expect(request).toHaveBeenCalledExactlyOnceWith({ navigationUI: "hide" });
    expect(container.querySelector("[data-vivic-fullscreen-hint]")).toBeNull();
    await act(async () => { currentFullscreen = null; document.dispatchEvent(new Event("fullscreenchange")); });
    expect(button("点击隐藏顶部栏")).toBeDefined();
  });
  it("keeps a failed request visible and lets the user dismiss the hint", async () => {
    request.mockRejectedValue(new Error("TEST blocked")); await render();
    await act(async () => button("点击隐藏顶部栏").click());
    expect(container.querySelector("[data-vivic-fullscreen-error]")?.textContent).toContain("暂时无法隐藏顶部栏");
    expect(button("点击隐藏顶部栏").disabled).toBe(false);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="关闭全屏提示"]')!.click());
    expect(container.textContent).toBe("");
  });
  it("provides a dismissible manual fallback when fullscreen is unsupported", async () => {
    Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: false });
    await render(); expect(container.textContent).toContain("浏览器的全屏功能");
    expect(request).not.toHaveBeenCalled();
    expect(button("点击隐藏顶部栏")).toBeUndefined();
  });
  it("does not cover a page that is already fullscreen", async () => {
    currentFullscreen = document.documentElement; await render();
    expect(container.textContent).toBe(""); expect(request).not.toHaveBeenCalled();
  });
});
