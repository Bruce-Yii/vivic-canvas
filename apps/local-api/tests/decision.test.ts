import { describe, expect, it, vi } from "vitest";
import { acceptedDecision, localDecisionIntent } from "../src/decision/intent.js";
import { DecisionManager } from "../src/decision/manager.js";
import { createApp } from "../src/app.js";
import { authed, emptyContext, testConfig } from "./helpers.js";
const probs = (index: number) => Array.from({ length: 7 }, (_, i) => i === index ? .94 : .01);
const note = (id: string, x = 0) => ({ id, type: "NoteCard", displayProps: { text: "TEST text" }, sourceDataSummary: {}, layout: { x, y: 0 } });
describe("optional bounded Kev decisions", () => {
  it("defaults off and never starts inference before explicit enabling", async () => {
    const model = new DecisionManager("/nonexistent/vivic-test-model");
    expect(model.status()).toMatchObject({ phase: "absent", enabled: false });
    expect(await model.score("显示所有卡片")).toBeNull(); model.stop();
  });
  it.each(["不要删除待办", "别展开便笺", "展开然后删除", "同时聚焦和收起", "例如展开便笺", "引用“展开便笺”", "删除便笺"])("rejects unsafe or narrated input even with full confidence: %s", text => {
    expect(acceptedDecision(text, probs(4))).toBeNull();
  });
  it("rejects delete, low confidence, invalid probabilities and abstention", () => {
    for (const p of [probs(3), probs(6), [.4, .1, .1, .1, .1, .1, .1], [NaN, 1, 0, 0, 0, 0, 0], [1, 0]]) expect(acceptedDecision("展开便笺", p)).toBeNull();
  });
  it("only programmatically resolves existing targets and keeps original note content", async () => {
    const ctx = emptyContext([note("n")]);
    const result = await localDecisionIntent("把笔记铺开让我看全", ctx, { score: async () => probs(4) });
    expect(result?.kind).toBe("envelope");
    if (result?.kind === "envelope") expect(result.envelope.actions).toEqual([{ type: "card.update", targetId: "n", variant: "expanded" }, { type: "canvas.fit" }]);
    expect((await localDecisionIntent("展开便笺", emptyContext([note("n"), note("m")]), { score: async () => probs(4) }))?.kind).toBe("clarify");
    expect(await localDecisionIntent("展开便笺", ctx, { score: async () => null })).toBeNull();
    expect(await localDecisionIntent("展开便笺", ctx, { score: async () => probs(4) }, AbortSignal.abort())).toBeNull();
  });
  it("guards all lifecycle routes with local API auth", async () => {
    const model = new DecisionManager("/nonexistent/vivic-test-model");
    const enable = vi.spyOn(model, "enable");
    const app = createApp({ config: testConfig(), decision: model });
    expect((await app.request("/api/decision/enable", { method: "POST" })).status).toBe(401);
    expect(enable).not.toHaveBeenCalled();
    expect((await app.request("/api/decision/status", { headers: authed })).status).toBe(200);
    expect((await app.request("/api/decision/enable", { method: "POST", headers: authed })).status).toBe(200);
    expect(enable).toHaveBeenCalledOnce(); app.dispose();
  });
});
