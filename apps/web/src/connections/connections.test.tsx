// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionPanel } from "./ConnectionPanel";
import { ConnectionQueryPanel } from "./ConnectionQueryPanel";
import { connectionResultCard } from "./resultCard";
import type { ConnectionResult } from "./api";

let root: Root, container: HTMLDivElement;
const fixture: ConnectionResult = { provider: "mcdonalds", source: "麦当劳", tool: "campaign-calendar", title: "活动日历", checkedAt: "2026-10-24T12:00:00.000Z", text: "TEST fixture 活动日历", links: [{ title: "官方活动", url: "https://www.mcdonalds.com.cn/" }], truncated: false };
const statuses = [{ provider: "mcdonalds", label: "麦当劳", configured: true, connected: true, transport: "mcp", tools: [{ name: "campaign-calendar", title: "活动日历", description: "", inputSchema: { type: "object", properties: {} } }] }];
const button = (text: string) => [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === text || node.getAttribute("aria-label") === text)!;
const inputValue = async (input: HTMLInputElement, value: string) => act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  vi.stubGlobal("fetch", vi.fn(async (input: string) => Response.json({ ok: true, ...(input.endsWith("/query") || input.endsWith("/ask") ? { result: fixture } : { connections: statuses }) })));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("connected service UI", () => {
  it("uses a natural-language question by default", async () => {
    await act(async () => root.render(<ConnectionQueryPanel />)); await act(async () => button("查询资料").click());
    const textarea = document.body.querySelector<HTMLTextAreaElement>('textarea[aria-label="资料查询问题"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "这个月有什么活动？"); textarea.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => button("查询").click());
    const request = vi.mocked(fetch).mock.calls.find(call => String(call[0]).endsWith("/ask"));
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({ provider: "mcdonalds", question: "这个月有什么活动？" });
    expect(document.body.textContent).toContain("TEST fixture");
  });
  it("keeps query collapsed until requested, then queries the selected read tool and saves only on user click", async () => {
    const save = vi.fn(); await act(async () => root.render(<ConnectionQueryPanel onSave={save} />));
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => button("查询资料").click());
    await act(async () => button("指定查询").click());
    const queryCall = vi.mocked(fetch).mock.calls.find(call => String(call[0]).endsWith("/query"));
    expect(JSON.parse(String(queryCall?.[1]?.body))).toEqual({ provider: "mcdonalds", tool: "campaign-calendar", args: {} });
    expect(document.body.textContent).toContain("TEST fixture"); expect(save).not.toHaveBeenCalled();
    await act(async () => button("保存为卡片").click()); expect(save).toHaveBeenCalledWith(fixture); expect(button("已加入 Space").disabled).toBe(true);
  });
  it("does not report saved when durable host save fails or throws synchronously", async () => {
    await act(async () => root.render(<ConnectionQueryPanel onSave={() => { throw new Error("save failed"); }} />));
    await act(async () => button("查询资料").click()); await act(async () => button("指定查询").click()); await act(async () => button("保存为卡片").click());
    expect(document.body.textContent).toContain("卡片未保存"); expect(button("保存为卡片").disabled).toBe(false);
  });
  it("clears typed credentials on settings close and sends no auth until explicitly connected", async () => {
    await act(async () => root.render(<ConnectionPanel active />));
    await act(async () => button("飞书连接").click());
    const token = document.body.querySelector<HTMLInputElement>('input[type="password"]')!;
    await inputValue(token, "TEST-secret-not-persisted");
    expect(vi.mocked(fetch).mock.calls.every(call => String(call[0]).endsWith("/status"))).toBe(true);
    await act(async () => root.render(<ConnectionPanel active={false} />)); expect(token.value).toBe("");
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
  });
  it("preserves a bounded read-only service receipt in the created card", () => {
    const card = connectionResultCard({ ...fixture, text: "正文".repeat(400) });
    expect(card.type).toBe("NoteCard"); expect(card.displayProps.text?.length).toBe(500);
    expect(card.sources[0]).toMatchObject({ kind: "service", provider: "麦当劳", readFullPage: false, fetchedAt: fixture.checkedAt });
    expect(card.sourceData.connectedSource).toMatchObject({ provider: "mcdonalds", truncated: false, previewTruncated: true });
  });
});
