import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { CredentialStore } from "../src/credentials.js";
import { authed, emptyContext, testConfig } from "./helpers.js";
import type { CanvasContext } from "../src/schemas.js";
import type { IntentResult } from "../src/intent/pipeline.js";

const apps: Array<ReturnType<typeof createApp>> = [];
afterEach(() => { for (const app of apps.splice(0)) app.dispose(); });
const timer = (id = "timer-1", x = 0) => ({ id, type: "CountdownCard", displayProps: {}, sourceDataSummary: { targetAt: "2099-01-01T00:00:00Z" }, layout: { x, y: 0 } });
const ctx = (cards: CanvasContext["cards"] = [timer()]): CanvasContext => ({ ...emptyContext(cards), version: 3 });
function setup(connected = false) {
  const credentials = new CredentialStore();
  if (connected) credentials.set({ apiKey: "test-key-only", models: ["step-3.5-flash"], defaultModel: "step-3.5-flash", checkedAt: "TEST" });
  const transport = vi.fn(async () => Response.json({ choices: [{ message: { content: JSON.stringify({ clarify: "请确认要改变镜头还是卡片尺寸。" }) } }] }));
  const app = createApp({ config: testConfig(), mode: "online", credentials, fetchImpl: transport }); apps.push(app);
  const send = async (text: string, canvasContext = ctx(), task: Record<string, unknown> = { id: "offline-case" }) =>
    await (await app.request("/api/intent", { method: "POST", headers: authed, body: JSON.stringify({ text, canvasContext, task }) })).json() as IntentResult;
  return { send, transport };
}

describe("offline references retain owner receipts after backend-first routing", () => {
  it("focuses a unique countdown without a model, and completes only after persistence receipt", async () => {
    const { send, transport } = setup();
    const first = await send("放大倒计时");
    expect(first).toMatchObject({ kind: "envelope", usedProvider: "rules-offline", task: { status: "awaiting_execution", canvasVersion: 3, decision: "legacy-fallback" } });
    expect(first.envelope?.actions).toEqual([{ type: "card.focus", targetId: "timer-1" }]);
    expect((await send("放大倒计时", { ...ctx(), version: 4 }, { id: "offline-case", receipt: { executionId: first.task!.executionId!, status: "succeeded" } })).task?.status).toBe("completed");
    expect(transport).not.toHaveBeenCalled();
  });
  it("keeps unique delete recoverable through the same task proposal", async () => {
    const { send } = setup(); const result = await send("删除这个");
    expect(result.envelope?.actions).toEqual([{ type: "card.delete", targetId: "timer-1" }]);
    expect(result.task?.status).toBe("awaiting_execution");
    expect(result.envelope?.spokenText).toContain("可撤销");
  });
  it.each(["放大倒计时", "删除那个卡片"])("clarifies ambiguous %s without a proposal", async text => {
    const { send } = setup(); const result = await send(text, ctx([timer(), timer("timer-2", 300)]));
    expect(result.kind).toBe("clarify"); expect(result.envelope).toBeUndefined(); expect(result.task?.status).toBe("awaiting_clarification");
  });
  it.each(["不要放大倒计时", "解释放大倒计时", "删除这个然后放大倒计时", "引用“删除这个”"])("does not partly execute %s", async text => {
    const result = await setup().send(text); expect(result.envelope).toBeUndefined(); expect(result.task?.status).not.toBe("awaiting_execution");
  });
  it("refuses to infer uniqueness from truncated context", async () => {
    const result = await setup().send("放大倒计时", { ...ctx(), totalCardCount: 5 });
    expect(result.kind).toBe("clarify"); expect(result.envelope).toBeUndefined();
  });
  it("does not override a connected planner's clarification", async () => {
    const { send, transport } = setup(true); const result = await send("放大倒计时");
    expect(transport).toHaveBeenCalledOnce(); expect(result.kind).toBe("clarify"); expect(result.envelope).toBeUndefined();
  });
  it("pauses a named ordinary reminder through the host, without inventing client timestamps", async () => {
    const card = { ...timer(), sourceDataSummary: { targetAt: "2099-01-01T00:00:00Z", reminderText: "开会" } };
    const result = await setup().send("暂停开会提醒", ctx([card]));
    expect(result.hostOperation).toEqual({ kind: "countdown.pause", targetId: "timer-1" });
    expect(result.task?.status).toBe("awaiting_execution"); expect(result.envelope).toBeUndefined();
  });
  it("resumes a paused reminder and refuses scheduled or conditional variants", async () => {
    const card = { ...timer(), sourceDataSummary: { targetAt: "2099-01-01T00:00:00Z", reminderText: "开会", pausedAt: "2026-10-24T00:00:00Z" } };
    expect((await setup().send("继续开会提醒", ctx([card]))).hostOperation).toEqual({ kind: "countdown.resume", targetId: "timer-1" });
    for (const extra of [{ event: { title: "考试" } }, { schedule: { kind: "daily" } }, { condition: { kind: "weather" } }]) {
      const result = await setup().send("继续开会提醒", ctx([{ ...card, sourceDataSummary: { ...card.sourceDataSummary, ...extra } }]));
      expect(result.kind).toBe("clarify"); expect(result.hostOperation).toBeUndefined(); expect(result.envelope).toBeUndefined();
    }
  });
  it("preserves stable IDs and other rows when completing one todo item", async () => {
    const items = [{ id: "a", text: "测试事项", done: false }, { id: "b", text: "保留事项", done: false }];
    const card = { id: "todo-1", type: "TodoCard", displayProps: { items }, sourceDataSummary: {}, layout: { x: 0, y: 0 } };
    const result = await setup().send("把待办第一项标记为完成", ctx([card]));
    expect(result.envelope?.actions).toEqual([{ type: "card.update", targetId: card.id, displayProps: { items: [{ ...items[0], done: true }, items[1]] } }]);
    expect((await setup().send("高亮待办第2项", ctx([card]))).envelope?.actions).toEqual([{ type: "card.highlight", targetId: card.id, itemId: "b", durationMs: 6000 }]);
    expect((await setup().send("把待办第一项标记为完成", ctx([card, { ...card, id: "todo-2" }]))).envelope).toBeUndefined();
    expect((await setup().send("把待办第3项标记为完成", ctx([card]))).envelope).toBeUndefined();
    expect((await setup().send("把待办第一项标记为完成", ctx([{ ...card, contextSummary: { truncatedFields: ["items"] } }]))).envelope).toBeUndefined();
  });
});
