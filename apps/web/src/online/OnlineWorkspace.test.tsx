// @vitest-environment jsdom
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelSpeech } from "@/ai/speech";
import { cancelVoiceInput } from "@/ai/voiceInput";
import { readTemplateDraft } from "@/control/draftTransfer";
import type { OnlineOnboardingProps } from "@/onboarding/OnlineOnboarding";
import { OnlineWorkspace, ONLINE_WELCOME_KEY, showOnlineWelcome } from "./OnlineWorkspace";

vi.mock("./mode", () => ({ ONLINE_BUILD: true }));
vi.mock("@/ai/speech", () => ({ cancelSpeech: vi.fn() }));
vi.mock("@/ai/voiceInput", () => ({ cancelVoiceInput: vi.fn() }));
vi.mock("@/onboarding/OnlineOnboarding", () => ({
  OnlineOnboarding: ({ onComplete, onCancel }: OnlineOnboardingProps) => <section data-test-guide>
    <button onClick={() => onComplete()}>完成引导</button>
    <button onClick={() => onComplete("TEST chosen draft")}>完成并带草稿</button>
    {onCancel && <button onClick={onCancel}>取消引导</button>}
  </section>,
}));

let root: Root, container: HTMLDivElement;
const mounted = vi.fn(), disposed = vi.fn();
function OwnerProbe() {
  const [draft, setDraft] = useState(readTemplateDraft);
  const [count, setCount] = useState(0);
  useEffect(() => { mounted(); return () => { disposed(); }; }, []);
  useEffect(() => {
    const receive = (event: Event) => setDraft((event as CustomEvent<string>).detail);
    window.addEventListener("vivic:template-draft", receive);
    return () => window.removeEventListener("vivic:template-draft", receive);
  }, []);
  return <section data-test-owner>
    <label>Owner draft<input aria-label="Owner draft" value={draft} onChange={event => setDraft(event.target.value)} /></label>
    <button onClick={() => setCount(value => value + 1)}>Owner count {count}</button>
  </section>;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear(); sessionStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // No backend, key, microphone, audio or canvas is used by this isolated owner.
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("TEST unexpected request"))));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
const render = () => act(async () => root.render(<OnlineWorkspace><OwnerProbe /></OnlineWorkspace>));
const button = (label: string) => [...container.querySelectorAll("button")].find(node => node.textContent === label)!;
const click = (label: string) => act(async () => button(label).click());
const ownerHost = () => container.querySelector<HTMLElement>(".online-workspace-host")!;
const draftInput = () => container.querySelector<HTMLInputElement>('[aria-label="Owner draft"]')!;
const changeDraft = (value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(draftInput(), value);
  draftInput().dispatchEvent(new Event("input", { bubbles: true }));
});

describe("online workspace gating and revisitable welcome", () => {
  it("does not mount the owner on a first visit, and completion records a marker before exposing it", async () => {
    await render();
    expect(container.querySelector("[data-test-guide]")).not.toBeNull();
    expect(container.querySelector("[data-test-owner]")).toBeNull();
    expect(button("取消引导")).toBeUndefined();
    expect(mounted).not.toHaveBeenCalled();
    await click("完成引导");
    expect(localStorage.getItem(ONLINE_WELCOME_KEY)).toBe("done");
    expect(container.querySelector("[data-test-guide]")).toBeNull();
    expect(ownerHost().hidden).toBe(false);
    expect(mounted).toHaveBeenCalledTimes(1); expect(disposed).not.toHaveBeenCalled();
    expect(readTemplateDraft()).toBe(""); expect(draftInput().value).toBe("");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("hands the explicitly chosen draft to the newly mounted owner without sending a request", async () => {
    const received = vi.fn(); window.addEventListener("vivic:template-draft", received);
    try {
      await render(); await click("完成并带草稿");
      expect(received).toHaveBeenCalledTimes(1);
      expect((received.mock.calls[0]![0] as CustomEvent<string>).detail).toBe("TEST chosen draft");
      expect(readTemplateDraft()).toBe("TEST chosen draft");
      expect(draftInput().value).toBe("TEST chosen draft");
      expect(localStorage.getItem(ONLINE_WELCOME_KEY)).toBe("done");
      expect(fetch).not.toHaveBeenCalled();
    } finally { window.removeEventListener("vivic:template-draft", received); }
  });

  it("reopens with the existing owner mounted and inert, cancels audio, then restores its draft and state on cancel", async () => {
    await render(); await click("完成引导");
    await changeDraft("TEST unsent owner text"); await click("Owner count 0");
    const existingOwner = container.querySelector("[data-test-owner]");
    await act(async () => showOnlineWelcome());
    expect(cancelSpeech).toHaveBeenCalledTimes(1); expect(cancelVoiceInput).toHaveBeenCalledTimes(1);
    expect(ownerHost().hidden).toBe(true); expect(ownerHost().hasAttribute("inert")).toBe(true);
    expect(container.querySelector("[data-test-owner]")).toBe(existingOwner);
    expect(mounted).toHaveBeenCalledTimes(1); expect(disposed).not.toHaveBeenCalled();
    expect(draftInput().value).toBe("TEST unsent owner text"); expect(button("Owner count 1")).toBeDefined();
    await click("取消引导");
    expect(container.querySelector("[data-test-guide]")).toBeNull();
    expect(ownerHost().hidden).toBe(false); expect(ownerHost().hasAttribute("inert")).toBe(false);
    expect(container.querySelector("[data-test-owner]")).toBe(existingOwner);
    expect(draftInput().value).toBe("TEST unsent owner text"); expect(button("Owner count 1")).toBeDefined();
    expect(mounted).toHaveBeenCalledTimes(1); expect(disposed).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("honors the completion marker on a return visit and can complete a revisited guide without losing owner state", async () => {
    localStorage.setItem(ONLINE_WELCOME_KEY, "done");
    await render();
    expect(container.querySelector("[data-test-guide]")).toBeNull(); expect(mounted).toHaveBeenCalledTimes(1);
    await changeDraft("TEST retained draft"); await click("Owner count 0");
    await act(async () => window.dispatchEvent(new Event("vivic:show-online-welcome")));
    await click("完成引导");
    expect(draftInput().value).toBe("TEST retained draft"); expect(button("Owner count 1")).toBeDefined();
    expect(mounted).toHaveBeenCalledTimes(1); expect(disposed).not.toHaveBeenCalled();
    expect(cancelSpeech).toHaveBeenCalledTimes(1); expect(cancelVoiceInput).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("still completes and retains the current owner when localStorage access is blocked", async () => {
    const unavailable = {
      getItem: vi.fn(() => { throw new DOMException("TEST blocked storage", "SecurityError"); }),
      setItem: vi.fn(() => { throw new DOMException("TEST blocked storage", "SecurityError"); }),
    };
    vi.stubGlobal("localStorage", unavailable);
    await render();
    expect(mounted).not.toHaveBeenCalled();
    await click("完成并带草稿");
    expect(unavailable.setItem).toHaveBeenCalledExactlyOnceWith(ONLINE_WELCOME_KEY, "done");
    expect(ownerHost().hidden).toBe(false); expect(draftInput().value).toBe("TEST chosen draft");
    await changeDraft("TEST current tab");
    await act(async () => showOnlineWelcome()); await click("取消引导");
    expect(ownerHost().hidden).toBe(false); expect(draftInput().value).toBe("TEST current tab");
    expect(mounted).toHaveBeenCalledTimes(1); expect(disposed).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
