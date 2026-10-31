// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProvidersStatusResponse } from "@/ai/api";
import { AiSection } from "../AiSection";
import { CARD_TYPE_LABELS } from "@/contracts";
import { getSpeechSnapshot, setSpeechEnabled } from "@/ai/speech";

// TEST status replies only; no backend, key, microphone or audio output.
let root: Root, container: HTMLDivElement;
let status: ProvidersStatusResponse;
const stepfun = (connected: boolean) => ({ name: "stepfun" as const, connected, capabilities: [], ...(connected ? { defaultModel: "step-3.5-flash", models: ["step-3.5-flash"] } : {}) });
const gpt = (connected: boolean) => ({ name: "gpt" as const, connected, capabilities: [], ...(connected ? { defaultModel: "gpt-test" } : {}) });
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/providers/status"
    ? Response.json(status) : Response.json({ voices: [] })));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  setSpeechEnabled(false);
  container.remove(); vi.unstubAllGlobals();
});
const refresh = () => act(async () => { window.dispatchEvent(new Event("focus")); await new Promise(resolve => setTimeout(resolve, 0)); });
const note = () => container.querySelector("[data-vivic-ai-note]")?.textContent ?? "";
const badge = () => container.querySelector("[data-vivic-ai-badge]")?.textContent ?? "";

describe("AI connection panel across backend restarts", () => {
  it("preserves explicit local feedback opt-in while the cloud connection is unavailable", async () => {
    status = { activeProvider: "stepfun", providers: [stepfun(false), gpt(false)], degradations: [] };
    await act(async () => root.render(<AiSection />)); await refresh();
    await act(async () => setSpeechEnabled(true));
    await refresh();
    expect(getSpeechSnapshot().enabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>("[data-vivic-tts-toggle]")?.checked).toBe(true);
    vi.mocked(fetch).mockRejectedValue(new Error("TEST offline")); await refresh();
    expect(getSpeechSnapshot().enabled).toBe(true);
  });
  it("explains that a restart cleared the in-memory StepFun key", async () => {
    status = { activeProvider: "stepfun", instance: "TEST-a", providers: [stepfun(true), gpt(false)], degradations: [] };
    await act(async () => root.render(<AiSection />)); await refresh();
    expect(badge()).toContain("已连接");
    status = { activeProvider: "stepfun", instance: "TEST-b", providers: [stepfun(false), gpt(false)], degradations: [] };
    await refresh();
    expect(note()).toContain("本地服务刚刚重启");
    status = { activeProvider: "stepfun", instance: "TEST-b", providers: [stepfun(true), gpt(false)], degradations: [] };
    await refresh();
    expect(note()).not.toContain("重启");
  });

  it("a disconnect on the same backend is not reported as a restart", async () => {
    status = { activeProvider: "stepfun", instance: "TEST-a", providers: [stepfun(true), gpt(false)], degradations: [] };
    await act(async () => root.render(<AiSection />)); await refresh();
    status = { activeProvider: "stepfun", instance: "TEST-a", providers: [stepfun(false), gpt(false)], degradations: [] };
    await refresh();
    expect(note()).not.toContain("重启");
  });

  it("shows the GPT restore in progress instead of 未连接", async () => {
    status = { activeProvider: "gpt", instance: "TEST-a", restoring: "gpt", providers: [stepfun(false), gpt(false)], degradations: [] };
    await act(async () => root.render(<AiSection />)); await refresh();
    expect(badge()).toBe("正在恢复 GPT 连接…");
    status = { activeProvider: "gpt", instance: "TEST-a", providers: [stepfun(false), gpt(true)], degradations: [] };
    await refresh();
    expect(badge()).toContain("已连接 · gpt-test");
  });

  it("shows every registered card once and follows the selected provider's connection", async () => {
    status = { activeProvider: "stepfun", providers: [stepfun(true), gpt(false)], degradations: [] };
    await act(async () => root.render(<AiSection />)); await refresh();
    const cards = Array.from(container.querySelectorAll("[data-vivic-available-card]"));
    expect(cards.map(card => card.getAttribute("data-vivic-available-card")).sort()).toEqual(Object.keys(CARD_TYPE_LABELS).sort());
    expect(container.querySelector('[data-vivic-available-card="ProgressRingCard"]')?.getAttribute("data-availability")).toBe("ready");
    expect(container.querySelector('[data-vivic-available-card="WeatherCard"]')?.textContent).toContain("需联网");
    expect(container.querySelector('[data-vivic-available-card="TableCard"]')?.textContent).toContain("需提供数据");
    status = { activeProvider: "gpt", providers: [stepfun(true), gpt(false)], degradations: [] };
    await refresh();
    expect(container.querySelector('[data-vivic-available-card="ProgressRingCard"]')?.getAttribute("data-availability")).toBe("requires-model");
    expect(container.querySelector('[data-vivic-available-card="TodoCard"]')?.getAttribute("data-availability")).toBe("ready");
    status = { activeProvider: "gpt", providers: [stepfun(false), gpt(true)], degradations: [] };
    await refresh();
    expect(container.querySelector("[data-vivic-card-model-status]")?.textContent).toContain("gpt-test");
    expect(container.querySelector('[data-vivic-available-card="ProgressRingCard"]')?.getAttribute("data-availability")).toBe("ready");
  });

  it("keeps local cards available when the backend goes offline and does not advertise model or data service availability", async () => {
    status = { activeProvider: "stepfun", providers: [stepfun(true), gpt(false)], degradations: [] };
    await act(async () => root.render(<AiSection />)); await refresh();
    vi.mocked(fetch).mockRejectedValue(new Error("TEST offline")); await refresh();
    expect([...container.querySelectorAll('[data-vivic-available-card][data-availability="ready"]')].map(card => card.getAttribute("data-vivic-available-card")).sort())
      .toEqual(["CountdownCard", "FileCard", "NoteCard", "TodoCard"]);
    expect(container.querySelector('[data-vivic-available-card="ProgressRingCard"]')?.getAttribute("data-availability")).toBe("requires-model");
    expect(container.querySelector('[data-vivic-available-card="ChartCard"]')?.getAttribute("data-availability")).toBe("requires-backend");
  });
});
