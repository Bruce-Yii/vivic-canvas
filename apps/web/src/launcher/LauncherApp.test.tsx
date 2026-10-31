// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LauncherApp from "./LauncherApp";
vi.mock("@/components/atmosphere/AtmosphereBackground", () => ({ AtmosphereBackground: () => null }));
const cached = { mode: "managed", phase: "cached", enabled: false, model: "Qwen", error: null, totalBytes: 530000000, downloadedBytes: 530000000 };
const response = (value: unknown) => new Response(JSON.stringify(value));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.useFakeTimers();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const button = (label: string) => [...container.querySelectorAll("button")].find(node => node.textContent?.trim() === label)!;
const render = () => act(async () => root.render(<LauncherApp />));
describe("local launcher truthfulness and recovery", () => {
  it("replaces the last ready result with disconnected status and recovers from polling", async () => {
    let online = true;
    vi.stubGlobal("fetch", vi.fn(async () => { if (!online) throw new Error("offline"); return response({ ...cached, phase: "ready", enabled: true }); }));
    await render(); expect(container.textContent).toContain("模型已就绪");
    online = false; await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(container.textContent).not.toContain("模型已就绪"); expect(container.textContent).toContain("状态待连接确认");
    expect(button("停止模型").disabled).toBe(true);
    online = true; await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(container.textContent).toContain("模型已就绪"); expect(button("停止模型").disabled).toBe(false);
  });
  it("ignores a stale poll that resolves after an acknowledged stop", async () => {
    let calls = 0, resolvePoll: ((value: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/stop")) return response({ ...cached, phase: "stopping" });
      if (++calls === 1) return response({ ...cached, phase: "ready", enabled: true });
      return new Promise<Response>(resolve => { resolvePoll = resolve; });
    }));
    await render(); await act(async () => vi.advanceTimersByTimeAsync(1500));
    await act(async () => button("停止模型").click());
    await act(async () => resolvePoll!(response({ ...cached, phase: "ready", enabled: true })));
    expect(container.textContent).toContain("正在停止并释放内存"); expect(container.textContent).not.toContain("模型已就绪");
  });
  it("prevents repeated starts and does not claim ready while warmup is pending", async () => {
    let resolveStart: ((value: Response) => void) | undefined;
    const fetch = vi.fn(async (url: string) => url.endsWith("/enable") ? new Promise<Response>(resolve => { resolveStart = resolve; }) : response(cached));
    vi.stubGlobal("fetch", fetch); await render();
    await act(async () => { button("启动模型").click(); button("启动模型").click(); });
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/enable"))).toHaveLength(1);
    await act(async () => resolveStart!(response({ ...cached, phase: "loading", enabled: true })));
    expect(container.textContent).toContain("正在加载并预热"); expect(container.textContent).not.toContain("模型已就绪");
  });
  it("reports download progress and keeps runtime controls after preparation", async () => {
    let status = { ...cached, phase: "downloading", downloadedBytes: 265000000, lastState: "disabled" };
    vi.stubGlobal("fetch", vi.fn(async () => response(status))); await render();
    expect(container.querySelector("progress")?.value).toBe(50); expect(button("取消准备").disabled).toBe(false);
    status = { ...status, phase: "ready", enabled: true, lastState: "deferred" };
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(container.textContent).toContain("模型已就绪");
    expect(container.querySelector('a[href="/"]')).not.toBeNull();
    expect(button("停止模型").disabled).toBe(false);
    expect(container.querySelector('[data-hark-task]')).toBeNull();
    expect(container.textContent).not.toContain("今天的优先清单");
    expect(container.querySelector('a[href="/display"]')).toBeNull();
  });
  it("never treats a configured provider as a verified local runtime", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ ...cached, mode: "provider", phase: "ready", enabled: true }))); await render();
    expect(container.textContent).toContain("健康状态以实际请求为准");
    expect(container.textContent).not.toContain("模型已就绪"); expect(button("准备模型")).toBeUndefined(); expect(button("清理缓存")).toBeUndefined();
  });
});
