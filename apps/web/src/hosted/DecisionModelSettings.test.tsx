// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DecisionModelSettings, type DecisionModelSettingsProps } from "./DecisionModelSettings";

function render(overrides: Partial<DecisionModelSettingsProps> = {}) {
  const props: DecisionModelSettingsProps = {
    models: { configured: true, decision: { configured: false, model: null, executionEnabled: false, protocol: "classification-only", quality: "not-tested" } },
    selectedModel: "startlux-decision-2b", input: "把所有卡片显示在一屏里", result: null, busy: false,
    onModelChange: vi.fn(), onInputChange: vi.fn(), onConnect: vi.fn(), onDisconnect: vi.fn(), onClassify: vi.fn(),
    ...overrides,
  };
  return renderToStaticMarkup(<DecisionModelSettings {...props} />);
}

describe("decision model settings", () => {
  it("shows an independent unconnected status and safe classifier controls", () => {
    const html = render();
    expect(html).toContain("未连接");
    expect(html).toContain("连接并测试");
    expect(html).toContain("测试分类");
    expect(html).toContain("卡片执行已关闭");
  });

  it("shows the selected decision model as connected when its probe succeeded", () => {
    const html = render({ models: { configured: true, decision: { configured: true, model: "startlux-decision-2b", connectedAt: "2026-10-27T00:00:00.000Z", executionEnabled: false, protocol: "classification-only", quality: "not-tested" } } });
    expect(html).toContain("已连接 · Startlux Decision 2B");
    expect(html).toContain("重新测试并连接");
    expect(html).toContain("断开决策模型");
    expect(html).toContain("卡片执行已关闭");
  });

  it("renders the classifier result and review signal without calling it a probability", () => {
    const html = render({
      models: { configured: true, decision: { configured: true, model: "startlux-decision-2b", executionEnabled: false, protocol: "classification-only", quality: "not-tested" } },
      result: { model: "startlux-decision-2b", choice: "fit", score: 0.93, needs_review: true },
    });
    expect(html).toContain("分类结果：在一屏显示全部卡片");
    expect(html).toContain("模型分数 0.930 · 需要人工复核");
    expect(html).not.toContain("概率");
  });

  it("asks for the platform key before enabling a decision connection", () => {
    const html = render({ models: { configured: false, decision: { configured: false, model: null, executionEnabled: false, protocol: "classification-only", quality: "not-tested" } } });
    expect(html).toContain("请先连接平台 Key");
    expect(html).toContain('disabled=""');
  });

  it("forwards connect, disconnect, and classifier test actions", async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const onConnect = vi.fn(), onDisconnect = vi.fn(), onClassify = vi.fn();
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<DecisionModelSettings
      models={{ configured: true, decision: { configured: true, model: "startlux-decision-2b", executionEnabled: false, protocol: "classification-only", quality: "not-tested" } }}
      selectedModel="startlux-decision-2b" input="请聚焦这张卡片" result={null} busy={false}
      onModelChange={vi.fn()} onInputChange={vi.fn()} onConnect={onConnect} onDisconnect={onDisconnect} onClassify={onClassify}
    />));
    const forms = container.querySelectorAll("form");
    await act(async () => forms[0]!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await act(async () => forms[1]!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    const disconnect = [...container.querySelectorAll("button")].find(button => button.textContent === "断开决策模型")!;
    await act(async () => disconnect.click());
    expect(onConnect).toHaveBeenCalledOnce();
    expect(onClassify).toHaveBeenCalledOnce();
    expect(onDisconnect).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
  });
});
