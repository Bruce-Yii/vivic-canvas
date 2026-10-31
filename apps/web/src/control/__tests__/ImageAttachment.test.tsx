// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImageAttachment } from "../ImageAttachment";
import type { ImageAttachmentProps } from "../ImageAttachment";
import { installImageBrowserMocks, testImageFile } from "../../ai/__tests__/attachments.harness";

let root: Root, host: HTMLDivElement, browser: ReturnType<typeof installImageBrowserMocks>;
let props: ImageAttachmentProps;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  browser = installImageBrowserMocks(); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  props = { ownerKey: "TEST-canvas-a:epoch-1", onChange: vi.fn(), onProcessingChange: vi.fn() };
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
const render = async (changes: Partial<ImageAttachmentProps> = {}) => {
  props = { ...props, ...changes };
  await act(async () => root.render(<ImageAttachment {...props} />));
};
const choose = async (files: File[] = [testImageFile()]) => {
  const input = host.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, "files", { configurable: true, value: files });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 0)); });
};
const transfer = async (name: "paste" | "drop", files: File[]) => {
  const event = new Event(name, { bubbles: true, cancelable: true });
  Object.defineProperty(event, name === "paste" ? "clipboardData" : "dataTransfer", { value: { files, items: [] } });
  await act(async () => { host.querySelector('[role="group"]')!.dispatchEvent(event); await new Promise(resolve => setTimeout(resolve, 0)); });
  return event;
};

describe("ImageAttachment control-only component", () => {
  it("stores a local draft only, warns honestly about unavailable vision, and has no send action", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const broadcast = vi.fn(); vi.stubGlobal("BroadcastChannel", broadcast);
    const indexedDB = { open: vi.fn() }; vi.stubGlobal("indexedDB", indexedDB);
    await render();
    expect(browser.createObjectURL).not.toHaveBeenCalled();
    await choose();
    expect(props.onChange).toHaveBeenLastCalledWith(expect.objectContaining({ type: "image", mime: "image/png", data: expect.any(String) }));
    expect(host.querySelector("img")?.getAttribute("src")).toBe("blob:TEST-2");
    expect(host.textContent).toContain("没有可用的视觉模型");
    expect(host.querySelector('button[type="submit"]')).toBeNull();
    expect(fetch).not.toHaveBeenCalled(); expect(storage).not.toHaveBeenCalled(); expect(broadcast).not.toHaveBeenCalled(); expect(indexedDB.open).not.toHaveBeenCalled();
    expect(props.onProcessingChange).toHaveBeenLastCalledWith(false);
  });
  it.each(["paste", "drop"] as const)("accepts explicit %s files within the component only", async name => {
    await render({ visionAvailable: true });
    const event = await transfer(name, [testImageFile()]);
    expect(event.defaultPrevented).toBe(true);
    expect(host.querySelector("img")).not.toBeNull();
    expect(host.textContent).not.toContain("没有可用的视觉模型");
  });
  it("ignores text paste, rejects URL-only drop and multiple attachments with clear reasons", async () => {
    await render();
    expect((await transfer("paste", [])).defaultPrevented).toBe(false);
    await transfer("drop", []); expect(host.querySelector('[role="alert"]')?.textContent).toContain("不接受链接");
    await transfer("paste", [testImageFile(), testImageFile()]);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("1 张");
    expect(host.querySelector("img")).toBeNull();
  });
  it("releases old preview on replacement and all previews on explicit remove", async () => {
    await render(); await choose(); await choose();
    expect(browser.revokeObjectURL).toHaveBeenCalledWith("blob:TEST-2");
    await act(async () => (host.querySelector('[aria-label="取消图片附件"]') as HTMLButtonElement).click());
    expect(browser.revokeObjectURL).toHaveBeenCalledWith("blob:TEST-4");
    expect(host.querySelector("img")).toBeNull(); expect(props.onChange).toHaveBeenLastCalledWith(null);
  });
  it.each([{ ownerKey: "TEST-canvas-b:epoch-1" }, { ownerKey: "TEST-canvas-a:epoch-2" }, { resetKey: 1 }, { disabled: true }])("clears attachment on boundary change %j", async changes => {
    await render(); await choose(); await render(changes);
    expect(host.querySelector("img")).toBeNull(); expect(props.onChange).toHaveBeenLastCalledWith(null);
    expect(browser.revokeObjectURL).toHaveBeenCalledWith("blob:TEST-2");
  });
  it("prevents stale pending decode from publishing into a new owner", async () => {
    await render(); browser.state.mode = "pending"; await choose();
    const oldImage = browser.state.images[0], oldLoad = oldImage.onload;
    expect(host.textContent).toContain("正在本地处理");
    await render({ ownerKey: "TEST-canvas-b:epoch-1" });
    await act(async () => { oldLoad?.(); await Promise.resolve(); });
    expect(host.querySelector("img")).toBeNull(); expect(props.onChange).toHaveBeenLastCalledWith(null);
    expect(browser.revokeObjectURL).toHaveBeenCalledWith("blob:TEST-1");
  });
  it("cancels processing, clears busy state and rejects disabled interaction", async () => {
    await render(); browser.state.mode = "pending"; await choose();
    await act(async () => (host.querySelector('[aria-label="取消图片附件"]') as HTMLButtonElement).click());
    expect(host.querySelector('[role="group"]')?.getAttribute("aria-busy")).toBe("false");
    expect(browser.revokeObjectURL).toHaveBeenCalledWith("blob:TEST-1");
    await render({ disabled: true }); await transfer("paste", [testImageFile()]); await transfer("drop", [testImageFile()]);
    expect(browser.createObjectURL).toHaveBeenCalledOnce();
  });
  it("cleans up a ready draft and invalidates its parent reference on unmount", async () => {
    await render(); await choose();
    await act(async () => root.render(null));
    expect(browser.revokeObjectURL).toHaveBeenCalledWith("blob:TEST-2");
    expect(props.onChange).toHaveBeenLastCalledWith(null);
  });
  it("replaces an in-flight draft and ignores the first decoder's late completion", async () => {
    await render(); browser.state.mode = "pending"; await choose();
    const oldLoad = browser.state.images[0].onload;
    browser.state.mode = "load"; await choose();
    await act(async () => { oldLoad?.(); await Promise.resolve(); });
    expect(host.querySelector("img")?.getAttribute("src")).toBe("blob:TEST-3");
    expect(browser.revokeObjectURL.mock.calls).toEqual([["blob:TEST-1"], ["blob:TEST-2"]]);
    expect(props.onChange).toHaveBeenLastCalledWith(expect.objectContaining({ type: "image" }));
  });
  it("aborts pending processing on unmount without retaining a callback or URL", async () => {
    await render(); browser.state.mode = "pending"; await choose();
    await act(async () => root.render(null));
    expect(browser.state.images[0].onload).toBeNull();
    expect(browser.revokeObjectURL).toHaveBeenCalledWith("blob:TEST-1");
    expect(props.onChange).toHaveBeenLastCalledWith(null);
  });
});
