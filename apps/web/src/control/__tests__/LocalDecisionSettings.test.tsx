// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalDecisionSettings } from "../LocalDecisionSettings";

let root: Root, container: HTMLDivElement;
const kevStatus = { phase: "absent", enabled: false, model: "Kev-0.8B", bytes: 0, gpuBytes: 0, lastMs: null, error: null };
const providerStatus = { ...kevStatus, mode: "provider", phase: "cached", model: "受控决策服务" };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const render = (disabled = false) => act(async () => root.render(<LocalDecisionSettings disabled={disabled} />));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("LocalDecisionSettings", () => {
  it("preserves Kev prepare behavior and disables mutating controls in read-only mode", async () => {
    const fetch = vi.fn(async () => response(kevStatus));
    vi.stubGlobal("fetch", fetch);
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>("[data-vivic-decision-prepare]")!.click());
    expect(fetch).toHaveBeenCalledWith("/api/decision/prepare", { method: "POST" });
    await render(true);
    expect([...container.querySelectorAll("button")].every(button => button.disabled)).toBe(true);
  });

  it("uses provider enable/stop routes without exposing model downloads or claiming health", async () => {
    const fetch = vi.fn(async (url: string) => {
      return response(url === "/api/decision/enable" ? { ...providerStatus, phase: "ready", enabled: true } : providerStatus);
    });
    vi.stubGlobal("fetch", fetch);
    await render();
    expect(container.querySelector("h2")?.textContent).toBe("决策服务");
    expect(container.querySelector("[data-vivic-decision-prepare]")).toBeNull();
    expect(container.querySelector("[data-vivic-decision-clear]")).toBeNull();
    expect(container.textContent).not.toContain("Apple Silicon");
    expect(container.textContent).toContain("不确定时交给主模型");
    const enable = container.querySelector<HTMLButtonElement>("[data-vivic-decision-enable]")!;
    const stop = container.querySelector<HTMLButtonElement>("[data-vivic-decision-stop]")!;
    expect(enable.textContent).toBe("启用决策服务");
    expect(stop.textContent).toBe("停用决策服务");
    expect(enable.disabled).toBe(false);
    expect(stop.disabled).toBe(true);
    await act(async () => enable.click());
    expect(fetch).toHaveBeenCalledWith("/api/decision/enable", { method: "POST" });
    expect(container.querySelector("[data-vivic-decision-status]")?.textContent).toBe("受控决策服务 · 已启用（服务状态待请求确认）");
    expect(enable.disabled).toBe(true);
    expect(stop.disabled).toBe(false);
    await act(async () => stop.click());
    expect(fetch).toHaveBeenCalledWith("/api/decision/stop", { method: "POST" });
    expect(container.querySelector("[data-vivic-decision-status]")?.textContent).toBe("受控决策服务 · 未启用");
    expect(enable.disabled).toBe(false);
    expect(stop.disabled).toBe(true);
    expect(fetch.mock.calls.some(([url]) => url === "/api/decision/prepare" || url === "/api/decision/clear")).toBe(false);
  });

  it("keeps provider controls disabled for a read-only owner", async () => {
    const fetch = vi.fn(async (_url: string) => response({ ...providerStatus, phase: "ready", enabled: true }));
    vi.stubGlobal("fetch", fetch);
    await render(true);
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons).toHaveLength(2);
    expect(buttons.every(button => button.disabled)).toBe(true);
    await act(async () => buttons.forEach(button => button.click()));
    expect(fetch.mock.calls.every(([url]) => url.endsWith("/status"))).toBe(true);
  });

  it("shows the configured provider error instead of offering unrelated Kev downloads", async () => {
    const configurationError = "决策服务配置无效，已回退到原有指令流程。请检查地址、协议、服务类型和模型名称后重启。";
    const fetch = vi.fn(async () => response({ ...kevStatus, configurationError, error: configurationError }));
    vi.stubGlobal("fetch", fetch);
    await render();
    expect(container.querySelector("h2")?.textContent).toBe("决策服务");
    expect(container.querySelector("[data-vivic-decision-status]")?.textContent).toContain("配置无效");
    expect(container.querySelector("[data-vivic-decision-status]")?.textContent).not.toContain("Kev");
    expect(container.textContent).toContain(configurationError);
    expect(container.querySelector("[data-vivic-decision-prepare]")).toBeNull();
    expect(container.querySelector("[data-vivic-decision-clear]")).toBeNull();
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.every(button => button.disabled)).toBe(true);
    await act(async () => buttons.forEach(button => button.click()));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/decision/status", { cache: "no-store" });
  });

  it.each([
    { phase: "error", lastState: "error", label: "服务暂不可用，已转交原有流程" },
    { phase: "error", lastState: "timeout", label: "请求超时，已转交原有流程" },
    { phase: "ready", lastState: "deferred", label: "判断不确定或缺少评分，已转交原有流程" },
    { phase: "ready", lastState: "accepted", label: "最近判断已接纳，执行结果请查看对话" },
    { phase: "ready", lastState: "cancelled", label: "最近请求已取消" },
  ])("shows the observed provider outcome: $lastState", async ({ phase, lastState, label }) => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ ...providerStatus, phase, lastState, enabled: true, lastMs: 42 })));
    await render();
    expect(container.querySelector("[data-vivic-decision-status]")?.textContent).toBe(`受控决策服务 · ${label} · 最近 42ms`);
    expect(container.querySelector<HTMLButtonElement>("[data-vivic-decision-stop]")?.disabled).toBe(false);
  });

  it("replaces a failed request with the next polled outcome and honours an explicit stop", async () => {
    let status = { ...providerStatus, enabled: true, phase: "error", lastState: "timeout" };
    vi.stubGlobal("fetch", vi.fn(async () => response(status)));
    await render();
    expect(container.querySelector("[data-vivic-decision-status]")?.textContent).toContain("请求超时");
    status = { ...status, phase: "ready", lastState: "deferred" };
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(container.querySelector("[data-vivic-decision-status]")?.textContent).toContain("判断不确定或缺少评分");
    status = { ...status, enabled: false, phase: "cached", lastState: "disabled" };
    await act(async () => container.querySelector<HTMLButtonElement>("[data-vivic-decision-stop]")!.click());
    expect(container.querySelector("[data-vivic-decision-status]")?.textContent).toBe("受控决策服务 · 未启用");
  });

  it("reports a rejected enable request without reading the response error body", async () => {
    const fetch = vi.fn(async (url: string) => url.endsWith("/enable") ? response({ error: "TEST-private-upstream-detail" }, 503) : response(providerStatus));
    vi.stubGlobal("fetch", fetch);
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>("[data-vivic-decision-enable]")!.click());
    expect(container.textContent).toContain("决策服务暂不可达，请重试。");
    expect(container.textContent).not.toContain("TEST-private-upstream-detail");
    expect(container.querySelector<HTMLButtonElement>("[data-vivic-decision-enable]")?.disabled).toBe(false);
  });

  it("preserves cached Kev enable/stop controls when mode is omitted", async () => {
    const cachedKev = { ...kevStatus, phase: "cached" };
    const fetch = vi.fn(async (url: string) => {
      return response(url === "/api/decision/enable" ? { ...cachedKev, phase: "ready", enabled: true } : cachedKev);
    });
    vi.stubGlobal("fetch", fetch);
    await render();
    expect(container.querySelector("h2")?.textContent).toBe("决策模型");
    expect(container.querySelector("[data-vivic-decision-prepare]")).not.toBeNull();
    expect(container.querySelector("[data-vivic-decision-clear]")).not.toBeNull();
    expect(container.querySelector("[data-vivic-decision-status]")?.textContent).toBe("Kev-0.8B · 已准备，未启用");
    const enable = container.querySelector<HTMLButtonElement>("[data-vivic-decision-enable]")!;
    const stop = container.querySelector<HTMLButtonElement>("[data-vivic-decision-stop]")!;
    expect(enable.textContent).toBe("启用本地决策");
    expect(stop.textContent).toBe("停止并释放内存");
    await act(async () => enable.click());
    expect(fetch).toHaveBeenCalledWith("/api/decision/enable", { method: "POST" });
    expect(container.querySelector("[data-vivic-decision-status]")?.textContent).toBe("Kev-0.8B · 已启用");
    await act(async () => stop.click());
    expect(fetch).toHaveBeenCalledWith("/api/decision/stop", { method: "POST" });
    expect(container.querySelector("[data-vivic-decision-status]")?.textContent).toBe("Kev-0.8B · 已准备，未启用");
  });
});
