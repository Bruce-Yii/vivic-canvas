import { afterEach, describe, expect, it, vi } from "vitest";
import { observeDecision } from "../src/decision/trace.js";
import type { IntentRouter } from "../src/decision/router.js";
import type { IntentRequest, IntentResult, PipelineDeps } from "../src/intent/pipeline.js";
import { IntentResponseSchema } from "../src/schemas.js";
import { emptyContext } from "./helpers.js";
import type { CanvasContext } from "../src/schemas.js";

const req: IntentRequest = { text: "你好", canvasContext: emptyContext() };
const output: IntentResult = { kind: "unknown", message: "保留原来的回答", usedProvider: "rules" };
const answer = { route: "chat" as const, probability: .99, probabilities: { chat: .99, answer: .01 }, none: false, latencyMs: 50 };
const router = (routeUtterance: IntentRouter["routeUtterance"] = vi.fn(async () => answer)): IntentRouter => ({
  mode: "shadow", routeUtterance, chooseTarget: vi.fn(async () => null),
});
const deps = (value: IntentRouter, sink = vi.fn()): PipelineDeps => ({ router: value, onDecisionTrace: sink } as unknown as PipelineDeps);
afterEach(() => vi.useRealTimers());

describe("shadow observer", () => {
  it("leaves the authoritative result intact and never applies a model decision", async () => {
    const authoritative = vi.fn(async () => output), sink = vi.fn();
    const result = await observeDecision(req, deps(router(), sink), undefined, authoritative);
    const { trace, ...legacy } = result;
    expect(legacy).toEqual(output);
    expect(trace).toMatchObject({ mode: "shadow", status: "complete", route: "chat", legacyKind: "unknown" });
    expect(IntentResponseSchema.safeParse(result).success).toBe(true);
    expect(authoritative).toHaveBeenCalledTimes(1);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(sink).toHaveBeenCalledTimes(1);
  });
  it("does not wait more than the 300ms budget and records a late decision after SSE completion", async () => {
    vi.useFakeTimers();
    let complete!: (value: typeof answer) => void;
    let modelSignal: AbortSignal | undefined;
    const model = router(vi.fn((_text: string, _ctx: CanvasContext, signal?: AbortSignal) => {
      modelSignal = signal;
      return new Promise<typeof answer>(resolve => { complete = resolve; });
    }));
    const sink = vi.fn(), transport = new AbortController();
    const pending = observeDecision(req, deps(model, sink), transport.signal, async () => output);
    await vi.advanceTimersByTimeAsync(300);
    const result = await pending;
    expect(result.trace).toMatchObject({ status: "pending", shadowWaitMs: 250 });
    await vi.advanceTimersByTimeAsync(1);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0]![1]).toMatchObject({ status: "pending" });
    transport.abort();
    expect(modelSignal?.aborted).toBe(false);
    complete(answer);
    await vi.runAllTimersAsync();
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink.mock.calls[1]![1]).toMatchObject({ status: "complete", route: "chat" });
  });
  it("starts the model concurrently rather than adding it after the old planner", async () => {
    vi.useFakeTimers();
    const model = router(vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 50)); return answer; }));
    const pending = observeDecision(req, deps(model), undefined, async () => {
      await new Promise(resolve => setTimeout(resolve, 100)); return output;
    });
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(result.trace).toMatchObject({ legacyElapsedMs: 100, shadowWaitMs: 0, latencyMs: 50, status: "complete" });
  });
  it("model and logging failures cannot alter the old response", async () => {
    const model = router(vi.fn(async () => { throw Error("private upstream error"); }));
    const sink = vi.fn(() => { throw Error("observer storage unavailable"); });
    const result = await observeDecision(req, deps(model, sink), undefined, async () => output);
    expect(result).toMatchObject(output);
    expect(result.trace).toMatchObject({ status: "failed", failedCount: 1, route: null });
    expect(JSON.stringify(result)).not.toContain("private upstream error");
  });
  it("off mode remains an exact bypass", async () => {
    for (const mode of ["off"] as const) {
      const model = { ...router(), mode };
      expect(await observeDecision(req, deps(model), undefined, async () => output)).toBe(output);
      expect(model.routeUtterance).not.toHaveBeenCalled();
    }
  });
  it("on mode records the same shared observation without itself committing mutations", async () => {
    const model = { ...router(), mode: "on" as const };
    const result = await observeDecision(req, deps(model), undefined, async () => output);
    expect(result).toMatchObject(output);
    expect(result.trace).toMatchObject({ mode: "on", route: "chat" });
    expect(model.routeUtterance).toHaveBeenCalledTimes(1);
  });
  it.each([
    { id: "task-one", receipt: { executionId: "execute-one", status: "succeeded" as const } },
    { id: "task-one", cancel: true as const },
  ])("does not classify execution receipts or cancellation as new user intents", async task => {
    const model = router();
    expect(await observeDecision({ ...req, task }, deps(model), undefined, async () => output)).toBe(output);
    expect(model.routeUtterance).not.toHaveBeenCalled();
  });
  it("keeps cancellation before the old response and observes clauses sequentially", async () => {
    const transport = new AbortController();
    const model = router(vi.fn(async (_text: string, _ctx: CanvasContext, signal?: AbortSignal) => {
      expect(signal?.aborted).toBe(true);
      return answer;
    }));
    transport.abort();
    const result = await observeDecision({ ...req, text: "显示全部，然后写便签" }, deps(model), transport.signal, async () => output);
    expect(result.trace?.clauses).toEqual(["显示全部", "写便签"]);
    expect(model.routeUtterance).toHaveBeenCalledTimes(2);
  });
  it("carries hypothetical focus between clauses without changing the real context", async () => {
    const context = emptyContext([
      { id: "left", type: "TodoCard", displayProps: { title: "本周待办", items: [{ text: "交周报" }, { text: "买牛奶" }] }, sourceDataSummary: {}, layout: { x: 0, y: 0 } },
      { id: "right", type: "TodoCard", displayProps: { title: "购物清单", items: [{ text: "鸡蛋" }] }, sourceDataSummary: {}, layout: { x: 900, y: 0 } },
    ]);
    const query: IntentRouter["routeUtterance"] = vi.fn<IntentRouter["routeUtterance"]>(async (text, ctx) => {
      if (text.startsWith("高亮")) expect(ctx.focusHistory).toEqual(["left"]);
      return { ...answer, route: text.startsWith("聚焦") ? "focus" as const : "highlight" as const };
    });
    const model = router(query);
    const result = await observeDecision({ text: "聚焦左边的待办，高亮第二条", canvasContext: context }, deps(model), undefined, async () => output);
    expect(result.trace?.decisions.map(x => x.target)).toEqual([{ targetId: "left" }, { targetId: "left" }]);
    expect(context.focusHistory).toEqual([]);
    expect(model.chooseTarget).not.toHaveBeenCalled();
  });
});
