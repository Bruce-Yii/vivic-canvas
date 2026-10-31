// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProvidersStatus, validateStepfunKey, type ProvidersStatusResponse } from "@/ai/api";
import { selectLlmProvider } from "@/ai/providers";
import { OnlineOnboarding, ONLINE_STARTER_DRAFT, type OnlineOnboardingProps } from "./OnlineOnboarding";

vi.mock("@/ai/api", () => ({ getProvidersStatus: vi.fn(), validateStepfunKey: vi.fn() }));
vi.mock("@/ai/providers", () => ({ selectLlmProvider: vi.fn() }));

const status = (connected: boolean, activeProvider: "stepfun" | "gpt" = "stepfun"): ProvidersStatusResponse => ({
  activeProvider, providers: [{ name: activeProvider, connected, capabilities: [], defaultModel: "TEST-model" }], degradations: [],
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
let root: Root, container: HTMLDivElement, props: OnlineOnboardingProps;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(getProvidersStatus).mockResolvedValue(status(false));
  vi.mocked(validateStepfunKey).mockResolvedValue({ ok: false, connected: false });
  vi.mocked(selectLlmProvider).mockResolvedValue({ ok: true });
  props = { onComplete: vi.fn(), onCancel: vi.fn() };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(<OnlineOnboarding {...props} />));
const button = (label: string) => [...container.querySelectorAll("button")].find(node => node.textContent?.trim() === label)!;
const click = (label: string) => act(async () => button(label).click());
const keyInput = () => container.querySelector<HTMLInputElement>('input[type="password"]')!;
const input = (value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(keyInput(), value);
  keyInput().dispatchEvent(new Event("input", { bubbles: true }));
});
const connect = () => act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });

describe("online onboarding through user events, with all provider requests mocked", () => {
  it("does not contact a provider on the intro, and the optional example is visibly a demo", async () => {
    await render();
    expect(getProvidersStatus).not.toHaveBeenCalled();
    expect(validateStepfunKey).not.toHaveBeenCalled();
    expect(container.querySelector('[data-onboarding-example]')).toBeNull();
    await click("查看示例");
    expect(container.querySelector('[data-onboarding-example]')?.textContent).toContain("示例卡片 · 不会加入你的 Space");
    expect(props.onComplete).not.toHaveBeenCalled();
    expect(validateStepfunKey).not.toHaveBeenCalled();
  });

  it("allows skipping the example, then enters explicitly limited basic mode without sending anything", async () => {
    await render(); await click("继续");
    expect(getProvidersStatus).toHaveBeenCalledTimes(1);
    expect(container.querySelector("h1")?.textContent).toBe("连接在线服务");
    await click("先体验基础功能");
    expect(container.textContent).toContain("内置文字指令");
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    await click("开始聊天");
    expect(props.onComplete).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(selectLlmProvider).not.toHaveBeenCalled();
  });

  it.each(["stepfun", "gpt"] as const)("recognizes an existing active %s connection and only hands a chosen draft to its owner", async provider => {
    vi.mocked(getProvidersStatus).mockResolvedValue(status(true, provider));
    await render(); await click("继续");
    expect(container.textContent).toContain(provider === "stepfun" ? "已连接 StepFun" : "已连接 GPT");
    await click("继续");
    expect(props.onComplete).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => { button("开始聊天").click(); button("开始聊天").click(); });
    expect(props.onComplete).toHaveBeenCalledExactlyOnceWith(ONLINE_STARTER_DRAFT);
    expect(validateStepfunKey).not.toHaveBeenCalled();
    expect(selectLlmProvider).not.toHaveBeenCalled();
  });

  it("does not silently add a draft when the optional first instruction is unchecked", async () => {
    vi.mocked(getProvidersStatus).mockResolvedValue(status(true));
    await render(); await click("继续"); await click("继续"); await click("开始聊天");
    expect(props.onComplete).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("clears the password immediately, rejects an unsuccessful probe and never echoes server errors", async () => {
    vi.mocked(validateStepfunKey).mockResolvedValue({ ok: false, connected: false, error: "TEST-secret-never-display" });
    await render(); await click("继续"); await input("TEST-secret-never-display");
    await connect();
    expect(validateStepfunKey).toHaveBeenCalledExactlyOnceWith("TEST-secret-never-display");
    expect(keyInput().value).toBe("");
    expect(container.textContent).toContain("连接验证未通过");
    expect(container.innerHTML).not.toContain("TEST-secret-never-display");
    expect(selectLlmProvider).not.toHaveBeenCalled();
    expect(props.onComplete).not.toHaveBeenCalled();
  });

  it("waits for validation, provider selection and confirmed active status before offering connected Continue", async () => {
    const probe = deferred<{ ok: boolean; connected: boolean }>();
    vi.mocked(validateStepfunKey).mockReturnValue(probe.promise);
    vi.mocked(getProvidersStatus).mockResolvedValueOnce(status(false, "gpt")).mockResolvedValue(status(true));
    await render(); await click("继续"); await input("TEST-probe");
    await act(async () => { button("验证并连接").click(); button("验证并连接").click(); });
    expect(validateStepfunKey).toHaveBeenCalledTimes(1);
    expect(keyInput().value).toBe("");
    expect(container.textContent).toContain("正在验证模型能否响应");
    expect(button("继续")).toBeUndefined();
    await act(async () => probe.resolve({ ok: true, connected: true }));
    expect(selectLlmProvider).toHaveBeenCalledExactlyOnceWith("stepfun");
    expect(getProvidersStatus).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("已连接 StepFun");
    expect(button("继续").disabled).toBe(false);
  });

  it("does not treat a successful probe as connected when the active provider status is still disconnected", async () => {
    vi.mocked(validateStepfunKey).mockResolvedValue({ ok: true, connected: true });
    await render(); await click("继续"); await input("TEST-probe"); await connect();
    expect(container.textContent).toContain("连接状态尚未确认");
    expect(container.textContent).not.toContain("已连接");
    expect(button("继续")).toBeUndefined();
  });

  it("keeps the flow recoverable if provider selection fails after a successful probe", async () => {
    vi.mocked(validateStepfunKey).mockResolvedValue({ ok: true, connected: true });
    vi.mocked(selectLlmProvider).mockResolvedValue({ ok: false });
    await render(); await click("继续"); await input("TEST-probe"); await connect();
    expect(container.textContent).toContain("服务切换失败");
    expect(getProvidersStatus).toHaveBeenCalledTimes(1);
    expect(keyInput().value).toBe("");
    expect(button("先体验基础功能").disabled).toBe(false);
  });

  it("shows an offline retry path and clears a password even when the request rejects", async () => {
    vi.mocked(validateStepfunKey).mockRejectedValue(new Error("TEST offline"));
    await render(); await click("继续"); await input("TEST-probe"); await connect();
    expect(keyInput().value).toBe(""); expect(container.textContent).toContain("在线服务暂时不可达");
    vi.mocked(getProvidersStatus).mockResolvedValue(status(true)); await click("检查连接");
    expect(container.textContent).toContain("已连接 StepFun");
  });

  it("ignores a late connection after cancel, without selecting a provider, completing or retaining a key", async () => {
    const probe = deferred<{ ok: boolean; connected: boolean }>(); vi.mocked(validateStepfunKey).mockReturnValue(probe.promise);
    await render(); await click("继续"); await input("TEST-probe"); await connect();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="关闭新手引导"]')!.click());
    expect(props.onCancel).toHaveBeenCalledTimes(1); expect(keyInput().value).toBe("");
    await act(async () => probe.resolve({ ok: true, connected: true }));
    expect(selectLlmProvider).not.toHaveBeenCalled(); expect(props.onComplete).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("已连接");
  });

  it("ignores a late status after returning, then freshly checks on re-entry", async () => {
    const check = deferred<ProvidersStatusResponse>(); vi.mocked(getProvidersStatus).mockReturnValueOnce(check.promise);
    await render(); await click("继续"); await click("返回");
    await act(async () => check.resolve(status(true)));
    expect(container.querySelector("h1")?.textContent).toBe("聊天与 Space");
    await click("继续");
    expect(getProvidersStatus).toHaveBeenCalledTimes(2); expect(container.textContent).not.toContain("已连接");
  });

  it("invalidates in-flight work when its owner disables the flow", async () => {
    const probe = deferred<{ ok: boolean; connected: boolean }>(); vi.mocked(validateStepfunKey).mockReturnValue(probe.promise);
    await render(); await click("继续"); await input("TEST-probe"); await connect();
    props.disabled = true; await render();
    await act(async () => probe.resolve({ ok: true, connected: true }));
    expect(selectLlmProvider).not.toHaveBeenCalled(); expect(props.onComplete).not.toHaveBeenCalled();
    expect(keyInput().value).toBe("");
    expect(button("先体验基础功能").disabled).toBe(true);
  });

  it("does not select a provider after the flow is unmounted, and moves keyboard focus to each step heading", async () => {
    const probe = deferred<{ ok: boolean; connected: boolean }>(); vi.mocked(validateStepfunKey).mockReturnValue(probe.promise);
    await render(); await click("继续");
    expect(document.activeElement).toBe(container.querySelector("h1"));
    await input("TEST-probe"); await connect();
    await act(async () => root.render(null));
    await act(async () => probe.resolve({ ok: true, connected: true }));
    expect(selectLlmProvider).not.toHaveBeenCalled(); expect(props.onComplete).not.toHaveBeenCalled();
  });
});
