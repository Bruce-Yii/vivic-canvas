// @vitest-environment jsdom
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsExperience } from "../SettingsExperience";
import { OnlineWorkspaceSuspended } from "@/online/OnlineWorkspace";

let root: Root, container: HTMLDivElement;
const mounted = vi.fn(), disposed = vi.fn(), back = vi.fn();
function StatefulPanel() {
  const [value, setValue] = useState(0);
  useEffect(() => { mounted(); return disposed; }, []);
  return <button data-test-panel onClick={() => setValue(value + 1)}>配置草稿 {value}</button>;
}
const render = (hidden = false, suspended = false) => root.render(<OnlineWorkspaceSuspended.Provider value={suspended}>
  <SettingsExperience hidden={hidden} onBack={back} notice={null}
    local={<StatefulPanel />} connections={<input aria-label="TEST key draft" defaultValue="" />}
    appearance={<p>背景</p>} voice={<p>语音</p>} notifications={<p>通知</p>}
    mobile={<p>配对</p>} data={<p>备份</p>} permissions={<p>位置</p>} />
</OnlineWorkspaceSuspended.Provider>);
const nav = (id: string) => container.querySelector<HTMLElement>('[data-settings-nav="' + id + '"]')!;
const group = (id: string) => container.querySelector<HTMLElement>('[data-settings-group="' + id + '"]')!;
const modal = () => container.querySelector<HTMLDialogElement>("dialog")!;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // jsdom has no native top layer. Real focus/inertness is checked in Playwright.
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  window.history.replaceState(null, "", "/");
  mounted.mockClear(); disposed.mockClear(); back.mockClear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); window.history.replaceState(null, "", "/"); vi.unstubAllGlobals(); });

describe("settings panel keeps live configuration", () => {
  it("keeps provider drafts and editor state through tabs, disclosure, close and reopen", async () => {
    await act(async () => render());
    expect(modal().open).toBe(true);
    expect(container.querySelectorAll(".se-nav [data-settings-nav]")).toHaveLength(3);
    const input = container.querySelector<HTMLInputElement>("input")!;
    input.value = "TEST unsaved configuration";
    const detail = container.querySelector<HTMLDetailsElement>('[data-settings-extra="local"]')!;
    detail.open = true;
    await act(async () => container.querySelector<HTMLButtonElement>("[data-test-panel]")!.click());
    detail.open = false;
    await act(async () => nav("preferences").click());
    expect(group("connections").hidden).toBe(true); expect(group("preferences").hidden).toBe(false);
    await act(async () => nav("connections").click());
    expect(detail.open).toBe(false);
    await act(async () => render(true));
    expect(modal().open).toBe(false);
    await act(async () => render(false));
    expect(modal().open).toBe(true);
    expect(mounted).toHaveBeenCalledTimes(1); expect(disposed).not.toHaveBeenCalled();
    expect(input.value).toBe("TEST unsaved configuration");
    expect(container.querySelector("[data-test-panel]")?.textContent).toBe("配置草稿 1");
  });

  it("maps existing preference and workspace links to the new groups", async () => {
    window.history.replaceState(null, "", "#settings-appearance");
    await act(async () => render());
    expect(group("preferences").hidden).toBe(false);
    await act(async () => {
      window.history.replaceState(null, "", "#settings-workspace");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(nav("data").getAttribute("aria-current")).toBe("page");
    expect(group("data").hidden).toBe(false); expect(group("preferences").hidden).toBe(true);
  });

  it("suspends the modal for onboarding without dropping the configuration draft", async () => {
    await act(async () => render());
    const input = container.querySelector<HTMLInputElement>("input")!;
    input.value = "TEST kept";
    await act(async () => render(false, true));
    expect(modal().open).toBe(false);
    await act(async () => render(false, false));
    expect(modal().open).toBe(true); expect(input.value).toBe("TEST kept");
    expect(mounted).toHaveBeenCalledTimes(1); expect(disposed).not.toHaveBeenCalled();
  });

  it("closes through Escape or its button without unmounting editors", async () => {
    await act(async () => render());
    const event = new Event("cancel", { cancelable: true });
    await act(async () => modal().dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true); expect(back).toHaveBeenCalledTimes(1);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="关闭设置"]')!.click());
    expect(back).toHaveBeenCalledTimes(2);
    expect(disposed).not.toHaveBeenCalled();
  });
});
