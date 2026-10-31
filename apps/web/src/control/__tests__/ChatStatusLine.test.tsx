// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatStatusLine } from "../ChatStatusLine";

let root: Root, container: HTMLDivElement;
const render = (text: string | null, visible: boolean, busy: boolean, onCancel = vi.fn()) => root.render(
  <ChatStatusLine text={text} visible={visible} busy={busy} onCancel={onCancel} />,
);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("single visible status slot", () => {
  it("renders one status line and carries the only cancel affordance next to it", async () => {
    const onCancel = vi.fn();
    await act(async () => render("我先找一下相关卡片", true, true, onCancel));
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    const status = container.querySelector<HTMLElement>('[data-vivic-command-feedback]')!;
    expect(status.textContent).toContain("我先找一下相关卡片");
    expect(status.hasAttribute("data-visible")).toBe(true);
    const cancel = status.querySelector<HTMLButtonElement>('[data-vivic-command-cancel]')!;
    await act(async () => cancel.click());
    expect(onCancel).toHaveBeenCalledOnce();
    // The composer no longer owns a second "正在处理… N 秒" row.
    expect(container.querySelector("[data-vivic-wait-seconds]")).toBeNull();
    expect(container.textContent).not.toContain("正在处理…");
  });

  it("shows no status and no cancel when idle", async () => {
    await act(async () => render(null, false, false));
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('[data-vivic-command-cancel]')).toBeNull();
  });

  it("keeps the text but drops the cancel affordance after the request settles", async () => {
    await act(async () => render("我先确认要删哪张", true, false));
    expect(container.querySelector('[role="status"]')?.textContent).toContain("我先确认要删哪张");
    expect(container.querySelector('[data-vivic-command-cancel]')).toBeNull();
  });

  it("keeps the composer free of a second busy/wait row", () => {
    const source = readFileSync(resolve(process.cwd(), "src/control/ChatComposer.tsx"), "utf8");
    expect(source).not.toContain("正在处理…");
    expect(source).not.toContain("data-vivic-wait-seconds");
    expect(source).not.toContain("elapsed");
  });
});
