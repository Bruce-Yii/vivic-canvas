/**
 * Model-platform settings panel tests.
 * @vitest-environment jsdom
 */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelPlatformSettings } from "../ModelPlatformSettings";

/** React tracks its own value setter, so set the DOM value then dispatch the event. */
const setValue = async (input: HTMLInputElement | HTMLSelectElement, value: string) => {
  await act(async () => {
    const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
};

const settle = async () => {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};

const PRESETS = [
  { id: "custom", name: "自定义（OpenAI 兼容）", protocol: "openai-compatible",
    baseUrl: "http://127.0.0.1:8080/v1", supportsModelsEndpoint: true, auth: "bearer",
    defaultModels: [], description: "任意 OpenAI 兼容端点" },
  { id: "stepfun-v1", name: "StepFun API（普通 /v1）", protocol: "stepfun-v1",
    baseUrl: "https://api.stepfun.com/v1", supportsModelsEndpoint: true, auth: "bearer",
    defaultModels: ["step-3.5-flash"], defaultModel: "step-3.5-flash", description: "阶跃普通 API" },
  { id: "ollama", name: "Ollama（本地）", protocol: "openai-compatible",
    baseUrl: "http://127.0.0.1:11434/v1", supportsModelsEndpoint: true, auth: "none", defaultModels: [] },
];

interface RouteMap { [key: string]: () => Response }

/** Minimal fetch router: matches by exact URL or URL suffix. */
const fetchRouter = (routes: RouteMap) => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    for (const [key, handler] of Object.entries(routes)) {
      if (url === key || url.endsWith(key)) return handler();
    }
    return new Response(JSON.stringify({ ok: false, error: "not stubbed" }), { status: 404 });
  }) as typeof fetch;
  return { impl, calls };
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("ModelPlatformSettings", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const render = async (element: React.ReactElement) => {
    await act(async () => { root.render(element); });
    await settle();
  };

  const q = <T extends Element>(testId: string): T | null =>
    container.querySelector<T>(`[data-testid="${testId}"]`);

  it("renders presets from the backend and an empty saved list", async () => {
    const { impl } = fetchRouter({
      "/api/providers": () => json({ ok: true, providers: [] }),
      "/api/providers/presets": () => json({ ok: true, presets: PRESETS }),
    });
    vi.stubGlobal("fetch", impl);

    await render(<ModelPlatformSettings />);

    const select = q<HTMLSelectElement>("provider-preset-select")!;
    expect(select).toBeTruthy();
    expect(select.options.length).toBe(PRESETS.length);
    expect(container.textContent).toContain("StepFun API（普通 /v1）");
    expect(q("provider-list-empty")).toBeTruthy();
  });

  it("fills URL and model when a preset is chosen", async () => {
    const { impl } = fetchRouter({
      "/api/providers": () => json({ ok: true, providers: [] }),
      "/api/providers/presets": () => json({ ok: true, presets: PRESETS }),
    });
    vi.stubGlobal("fetch", impl);

    await render(<ModelPlatformSettings />);
    await setValue(q<HTMLSelectElement>("provider-preset-select")!, "stepfun-v1");
    await settle();

    expect(q<HTMLInputElement>("provider-url-input")!.value).toBe("https://api.stepfun.com/v1");
    expect(q<HTMLInputElement>("provider-model-input")!.value).toBe("step-3.5-flash");
    expect(q("provider-preset-description")!.textContent).toContain("阶跃普通 API");
  });

  it("fetches models, lists them and lets the user pick one by search", async () => {
    const { impl, calls } = fetchRouter({
      "/api/providers": () => json({ ok: true, providers: [] }),
      "/api/providers/presets": () => json({ ok: true, presets: PRESETS }),
      "/api/providers/preview/models": () => json({
        ok: true,
        models: [
          { id: "gpt-4o", kind: "chat" },
          { id: "bge-m3", kind: "embedding" },
          { id: "tts-1", kind: "audio" },
        ],
      }),
    });
    vi.stubGlobal("fetch", impl);

    await render(<ModelPlatformSettings />);
    await setValue(q<HTMLSelectElement>("provider-preset-select")!, "custom");
    await settle();
    await setValue(q<HTMLInputElement>("provider-key-input")!, "sk-test-key");
    await settle();

    await act(async () => { q<HTMLButtonElement>("provider-fetch-models")!.click(); });
    await settle();

    // The model list is populated and a chat model was preselected.
    expect(q("provider-model-picker")).toBeTruthy();
    expect(q<HTMLInputElement>("provider-model-input")!.value).toBe("gpt-4o");
    expect(container.querySelectorAll('[data-testid="provider-model-option"]').length).toBe(3);

    // The key travelled to the preview endpoint but is never rendered as text.
    const previewCall = calls.find((call) => call.url.endsWith("/preview/models"))!;
    expect(String(previewCall.init!.body)).toContain("sk-test-key");
    expect(container.textContent).not.toContain("sk-test-key");

    // Search narrows the list.
    await setValue(q<HTMLInputElement>("provider-model-search")!, "bge");
    await settle();
    const options = container.querySelectorAll('[data-testid="provider-model-option"]');
    expect(options.length).toBe(1);
    expect(options[0]!.getAttribute("data-model-id")).toBe("bge-m3");

    // Selecting an option updates the model field.
    await act(async () => { (options[0] as HTMLButtonElement).click(); });
    await settle();
    expect(q<HTMLInputElement>("provider-model-input")!.value).toBe("bge-m3");
  });

  it("shows a searchable empty state when nothing matches", async () => {
    const { impl } = fetchRouter({
      "/api/providers": () => json({ ok: true, providers: [] }),
      "/api/providers/presets": () => json({ ok: true, presets: PRESETS }),
      "/api/providers/preview/models": () => json({ ok: true, models: [{ id: "gpt-4o", kind: "chat" }] }),
    });
    vi.stubGlobal("fetch", impl);

    await render(<ModelPlatformSettings />);
    await act(async () => { q<HTMLButtonElement>("provider-fetch-models")!.click(); });
    await settle();
    await setValue(q<HTMLInputElement>("provider-model-search")!, "zzz");
    await settle();
    expect(q("provider-model-empty")).toBeTruthy();
  });

  it("falls back to the preset list when the platform has no /models", async () => {
    const { impl } = fetchRouter({
      "/api/providers": () => json({ ok: true, providers: [] }),
      "/api/providers/presets": () => json({ ok: true, presets: PRESETS }),
      "/api/providers/preview/models": () => json({
        ok: true, fallback: true,
        models: [{ id: "step-3.5-flash", kind: "chat" }],
        note: "该平台没有 /models 端点",
      }),
    });
    vi.stubGlobal("fetch", impl);

    await render(<ModelPlatformSettings />);
    await act(async () => { q<HTMLButtonElement>("provider-fetch-models")!.click(); });
    await settle();

    expect(q("provider-model-fallback")).toBeTruthy();
    expect(q("provider-model-fallback")!.textContent).toContain("内置模型清单");
  });

  it("reports a typed error when model discovery fails", async () => {
    const { impl } = fetchRouter({
      "/api/providers": () => json({ ok: true, providers: [] }),
      "/api/providers/presets": () => json({ ok: true, presets: PRESETS }),
      "/api/providers/preview/models": () => json(
        { ok: false, error: "鉴权失败（HTTP 401）：API Key 无效。", errorType: "auth" }, 401),
    });
    vi.stubGlobal("fetch", impl);

    await render(<ModelPlatformSettings />);
    await act(async () => { q<HTMLButtonElement>("provider-fetch-models")!.click(); });
    await settle();

    expect(q("provider-error")!.textContent).toContain("鉴权失败");
  });

  it("shows latency on a successful connection test", async () => {
    const { impl } = fetchRouter({
      "/api/providers": () => json({ ok: true, providers: [] }),
      "/api/providers/presets": () => json({ ok: true, presets: PRESETS }),
      "/api/providers/preview/test": () => json({ ok: true, latencyMs: 123, model: "gpt-4o", models: 7 }),
    });
    vi.stubGlobal("fetch", impl);

    await render(<ModelPlatformSettings />);
    await setValue(q<HTMLSelectElement>("provider-preset-select")!, "custom");
    await settle();
    // The custom preset carries no default model, so type one.
    await setValue(q<HTMLInputElement>("provider-model-input")!, "gpt-4o");
    await settle();

    await act(async () => { q<HTMLButtonElement>("provider-test")!.click(); });
    await settle();

    const result = q("provider-test-result")!;
    expect(result.getAttribute("data-ok")).toBe("true");
    expect(result.textContent).toContain("123 ms");
    expect(result.textContent).toContain("gpt-4o");
    expect(result.textContent).toContain("7 个模型");
  });

  it("shows the error type and reason on a failed test", async () => {
    const { impl } = fetchRouter({
      "/api/providers": () => json({ ok: true, providers: [] }),
      "/api/providers/presets": () => json({ ok: true, presets: PRESETS }),
      "/api/providers/preview/test": () => json({
        ok: false, errorType: "protocol",
        error: "4B 模型只接受 StartLux 原生协议（{state, questions}）。",
      }, 400),
    });
    vi.stubGlobal("fetch", impl);

    await render(<ModelPlatformSettings />);
    await setValue(q<HTMLInputElement>("provider-model-input")!, "startlux-decision-4b");
    await settle();
    await act(async () => { q<HTMLButtonElement>("provider-test")!.click(); });
    await settle();

    const result = q("provider-test-result")!;
    expect(result.getAttribute("data-ok")).toBe("false");
    expect(result.textContent).toContain("[协议不匹配]");
    expect(result.textContent).toContain("StartLux 原生协议");
  });

  it("saves a provider and lists it without the key", async () => {
    let saved: unknown;
    const { impl } = fetchRouter({
      "/api/providers/presets": () => json({ ok: true, presets: PRESETS }),
      "/api/providers/preview/models": () => json({ ok: true, models: [{ id: "gpt-4o", kind: "chat" }] }),
      "/api/providers": () => json({ ok: true, providers: [] }),
    });
    // The create call (POST /api/providers) is distinguished by its method.
    vi.stubGlobal("fetch", (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/providers") && init?.method === "POST") {
        saved = JSON.parse(String(init.body));
        return json({ ok: true, provider: { id: "p1" } }, 201);
      }
      return impl(input, init);
    }) as typeof fetch);

    await render(<ModelPlatformSettings />);
    await setValue(q<HTMLSelectElement>("provider-preset-select")!, "custom");
    await settle();
    await setValue(q<HTMLInputElement>("provider-key-input")!, "sk-save-me");
    await settle();
    await act(async () => { q<HTMLButtonElement>("provider-fetch-models")!.click(); });
    await settle();

    const save = q<HTMLButtonElement>("provider-save")!;
    expect(save.disabled).toBe(false);
    await act(async () => { save.click(); });
    await settle();

    expect(saved).toMatchObject({
      protocol: "openai-compatible",
      baseUrl: "http://127.0.0.1:8080/v1",
      apiKey: "sk-save-me",
      model: "gpt-4o",
    });
    // The form was reset after a successful save.
    expect(q<HTMLInputElement>("provider-key-input")!.value).toBe("");
  });

  it("lists saved providers with their status and reasons", async () => {
    const { impl } = fetchRouter({
      "/api/providers/presets": () => json({ ok: true, presets: PRESETS }),
      "/api/providers": () => json({
        ok: true,
        providers: [
          {
            id: "p1", name: "StepFun 普通", kind: "custom", protocol: "stepfun-v1",
            baseUrl: "https://api.stepfun.com/v1", model: "step-3.5-flash", roles: ["main"],
            enabled: true, hasApiKey: true, apiKeyHint: "2v0U••••T4Bb",
            createdAt: "2026-10-31T00:00:00.000Z", updatedAt: "2026-10-31T00:00:00.000Z",
            connected: true, latencyMs: 321,
          },
          {
            id: "p2", name: "本地 4B", kind: "custom", protocol: "startlux-native",
            baseUrl: "https://edsionc.top/api/v1", model: "startlux-decision-4b", roles: ["decision"],
            enabled: true, hasApiKey: true, apiKeyHint: "vvc_••••abcd",
            createdAt: "2026-10-31T00:00:00.000Z", updatedAt: "2026-10-31T00:00:00.000Z",
            connected: false, lastError: "4B 原生响应缺少 answers 字段", errorType: "protocol",
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", impl);

    await render(<ModelPlatformSettings />);

    const rows = container.querySelectorAll('[data-testid="provider-row"]');
    expect(rows.length).toBe(2);
    const badges = container.querySelectorAll('[data-testid="provider-status-badge"]');
    expect(badges[0]!.textContent).toContain("已连接");
    expect(badges[0]!.textContent).toContain("321 ms");
    expect(badges[1]!.textContent).toBe("未连接");
    // A failure must say why, not just "未连接".
    expect(q("provider-row-error")!.textContent).toContain("[协议不匹配]");
    expect(q("provider-row-error")!.textContent).toContain("answers");
    // Masked hints only, never a real key.
    expect(container.textContent).toContain("2v0U••••T4Bb");
  });

  it("tests and deletes a saved provider", async () => {
    const methods: string[] = [];
    vi.stubGlobal("fetch", (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      methods.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/api/providers/presets")) return json({ ok: true, presets: PRESETS });
      if (url.endsWith("/api/providers/p1/test")) return json({ ok: true, latencyMs: 55, model: "step-3.5-flash", models: 4 });
      if (url.endsWith("/api/providers/p1") && init?.method === "DELETE") return json({ ok: true });
      if (url.endsWith("/api/providers")) return json({
        ok: true,
        providers: [{
          id: "p1", name: "StepFun", kind: "custom", protocol: "stepfun-v1",
          baseUrl: "https://api.stepfun.com/v1", model: "step-3.5-flash", roles: ["main"],
          enabled: true, hasApiKey: true, createdAt: "2026-10-31T00:00:00.000Z",
          updatedAt: "2026-10-31T00:00:00.000Z", connected: false,
        }],
      });
      return json({ ok: false }, 404);
    }) as typeof fetch);

    await render(<ModelPlatformSettings />);
    await act(async () => { q<HTMLButtonElement>("provider-row-test")!.click(); });
    await settle();
    expect(methods).toContain("POST /api/providers/p1/test");
    expect(q("provider-note")!.textContent).toContain("55 ms");

    await act(async () => { q<HTMLButtonElement>("provider-row-delete")!.click(); });
    await settle();
    expect(methods).toContain("DELETE /api/providers/p1");
  });

  it("disables every control when disabled", async () => {
    const { impl } = fetchRouter({
      "/api/providers": () => json({ ok: true, providers: [] }),
      "/api/providers/presets": () => json({ ok: true, presets: PRESETS }),
    });
    vi.stubGlobal("fetch", impl);

    await render(<ModelPlatformSettings disabled />);

    expect(q<HTMLSelectElement>("provider-preset-select")!.disabled).toBe(true);
    expect(q<HTMLInputElement>("provider-url-input")!.disabled).toBe(true);
    expect(q<HTMLInputElement>("provider-key-input")!.disabled).toBe(true);
    expect(q<HTMLButtonElement>("provider-fetch-models")!.disabled).toBe(true);
    expect(q<HTMLButtonElement>("provider-test")!.disabled).toBe(true);
  });

  it("surfaces an unreadable backend without crashing", async () => {
    vi.stubGlobal("fetch", (async () => new Response("down", { status: 503 })) as typeof fetch);
    await render(<ModelPlatformSettings />);
    expect(q("provider-load-error")!.textContent).toContain("无法读取");
    // The fallback preset list still renders.
    expect(q<HTMLSelectElement>("provider-preset-select")!.options.length).toBeGreaterThan(0);
  });
});
