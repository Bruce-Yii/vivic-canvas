import { describe, expect, it, vi } from "vitest";
import { createFileReadRoutes, fileSections } from "../src/files/routes.js";
import { createApp } from "../src/app.js";
import { testConfig } from "./helpers.js";

const request = (app: ReturnType<typeof createFileReadRoutes>, patch = {}) => app.request("http://local/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "notes.md", text: "[第 2 页]\n本周需要提交演示。", question: "总结行动", partial: false, ...patch }) });
describe("read-only file comprehension", () => {
  it("refuses legacy Word and other files before acquiring or invoking a model", async () => {
    const capture = vi.fn();
    const app = createFileReadRoutes(capture);
    for (const name of ["legacy.docx", "legacy.doc", "notes.txt", "notes.json", "table.csv"]) {
      const response = await request(app, { name });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "只支持 PDF 和 Markdown 文件阅读" });
    }
    expect(capture).not.toHaveBeenCalled();
  });
  it("uses bounded untrusted sections, validates exact quotes and never returns executable actions", async () => {
    const generate = vi.fn(async () => ({ ok: true as const, value: { answer: "本周提交演示。", citations: [{ sourceId: "s1", quote: "本周需要提交演示。" }] } }));
    const app = createFileReadRoutes(async () => ({ generate, isCurrent: () => true }));
    const response = await request(app);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, answer: "本周提交演示。", partial: false, citations: [{ label: "第 2 页", quote: "本周需要提交演示。" }] });
    expect(JSON.stringify(generate.mock.calls[0])).toContain("不可信资料");
    expect(fileSections("x".repeat(80000)).every(section => section.text.length <= 1601)).toBe(true);
  });
  it("rejects forged citations, oversized or action-bearing answers, invalid and empty requests", async () => {
    let reply: unknown = { answer: "错误", citations: [{ sourceId: "s1", quote: "不存在的原文" }] };
    const app = createFileReadRoutes(async () => ({ generate: async () => ({ ok: true as const, value: reply }), isCurrent: () => true }));
    expect((await request(app)).status).toBe(502);
    reply = { answer: "错误", citations: [], actions: [{ type: "card.delete", targetId: "all" }] };
    expect((await request(app)).status).toBe(502);
    reply = { answer: "x".repeat(12001), citations: [] }; expect((await request(app)).status).toBe(502);
    expect((await request(app, { text: " " })).status).toBe(400);
    expect((await request(app, { text: "x".repeat(80001) })).status).toBe(400);
  });
  it("drops a disconnected provider's late answer", async () => {
    const app = createFileReadRoutes(async () => ({ generate: async () => ({ ok: true as const, value: { answer: "old", citations: [] } }), isCurrent: () => false }));
    expect((await request(app)).status).toBe(409);
  });
  it("keeps the main file read route behind session authorization and origin checks", async () => {
    const app = createApp({ config: testConfig() });
    try {
      expect((await app.request("http://local/api/files/read", { method: "POST" })).status).toBe(401);
    } finally { app.dispose(); }
  });
});
