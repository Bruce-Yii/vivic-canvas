import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionEnvelopeSchema, type Action } from "@vivic/contracts";
import { DecisionTaskManager, type TaskRunDeps } from "../src/decision/taskV2.js";
import type { NativeQuestion, NativeV2Provider } from "../src/decision/nativeV2.js";
import type { IntentRequest, IntentResult } from "../src/intent/pipeline.js";
import { IntentResponseSchema, type CanvasContext } from "../src/schemas.js";
import type { PlannerRouteHint } from "../src/decision/trace.js";
import type { TargetResult } from "../src/decision/target.js";

const managers: DecisionTaskManager[] = [];
afterEach(() => { for (const tasks of managers.splice(0)) tasks.dispose(); vi.restoreAllMocks(); });
const manager = (options: ConstructorParameters<typeof DecisionTaskManager>[0] = {}) => {
  const tasks = new DecisionTaskManager(options); managers.push(tasks); return tasks;
};
const context = (): CanvasContext => ({ canvasId: "TEST-canvas", version: 7, stage: "WORKSPACE", viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [],
  cards: [
    { id: "TEST-note-1", type: "NoteCard", displayProps: { text: "读书笔记" }, sourceDataSummary: {}, layout: { x: 0, y: 0, width: 320, height: 120, pinned: false } },
    { id: "TEST-note-2", type: "NoteCard", displayProps: { text: "会议记录" }, sourceDataSummary: {}, layout: { x: 400, y: 0, width: 320, height: 120, pinned: true } },
    { id: "TEST-todo-1", type: "TodoCard", displayProps: { title: "购物清单", items: [{ id: "TEST-item", text: "牛奶", done: false }] }, sourceDataSummary: {}, layout: { x: 800, y: 0, width: 288, height: 160, pinned: false } },
    { id: "TEST-todo-2", type: "TodoCard", displayProps: { title: "工作清单", items: [{ id: "TEST-work-item", text: "周报", done: false }] }, sourceDataSummary: {}, layout: { x: 1200, y: 0, width: 288, height: 160, pinned: false } },
  ],
});
const request = (text = "删除读书笔记", canvasContext = context()): IntentRequest => ({ text, canvasContext });
const plan = (actions: Action[], canvasId = "TEST-canvas"): IntentResult => ({ kind: "envelope", usedProvider: "rules",
  envelope: ActionEnvelopeSchema.parse({ schemaVersion: "0.6", requestId: "TEST-proposal", canvasId, actions }),
});
const deletePlan = () => plan([{ type: "card.delete", targetId: "TEST-note-1" }]);
const reply = (first: IntentResult, text: string, canvasContext = context()): IntentRequest => ({ text, canvasContext, task: { id: first.task!.id } });
const hidden = { targetCandidates: [{ id: "TEST-note-1", label: "读书笔记" }, { id: "TEST-note-2", label: "会议记录" }], targetClause: 0 };
const ambiguous = (): IntentResult => ({ kind: "clarify", message: "请选择要操作的便笺。", ...hidden });
const safeDeps = (legacy: TaskRunDeps["legacy"]): TaskRunDeps => ({ legacy, safetyMode: true });

function publicOnly(result: IntentResult) {
  expect(result).not.toHaveProperty("targetCandidates");
  expect(result).not.toHaveProperty("targetClause");
  expect(result).not.toHaveProperty("resolvedTargetId");
  expect(result).not.toHaveProperty("resolvedTargets");
  expect(IntentResponseSchema.safeParse(result).success).toBe(true);
}
function withheld(result: IntentResult) {
  publicOnly(result);
  expect(result.envelope).toBeUndefined(); expect(result.hostOperation).toBeUndefined();
  expect(result.task?.executionId).toBeUndefined();
}

function native(select: (key: string, state: Record<string, unknown>) => string): NativeV2Provider & { decide: ReturnType<typeof vi.fn> } {
  return { decide: vi.fn(async (state: unknown, questions: Record<string, NativeQuestion>) => ({ ok: true as const,
    answers: Object.fromEntries(Object.entries(questions).map(([key, question]) => {
      const choice = select(key, state as Record<string, unknown>);
      return [key, { choice, none_probability: .001, probabilities: Object.fromEntries(Object.keys(question.criteria)
        .map(id => [id, id === choice ? .99 : .01 / Math.max(1, Object.keys(question.criteria).length - 1)])) }];
    })),
  })) };
}

describe("on-mode deletion confirmation freezes the whole proposal", () => {
  it("preserves the old mode's proposal behavior unless safetyMode is enabled", async () => {
    const tasks = manager(), legacy = vi.fn(async () => deletePlan());
    expect((await tasks.run(request(), { legacy })).task?.status).toBe("awaiting_execution");
  });

  it("wraps a no-task-id delete proposal in a public clarification without executing it", async () => {
    const tasks = manager(), legacy = vi.fn(async () => ({ ...deletePlan(), ...hidden }));
    const first = await tasks.run(request(), safeDeps(legacy));
    withheld(first); expect(first.kind).toBe("clarify");
    expect(first.task).toMatchObject({ status: "awaiting_clarification", clarification: { candidates: [] } });
    expect(first.message).toContain("读书笔记");
    expect(legacy).toHaveBeenCalledTimes(1);
    expect(await tasks.run({ ...request(), task: { id: first.task!.id } }, safeDeps(legacy))).toEqual(first);
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it.each(["确定", "是", "是的。", "删吧", "确认删除！"])("executes only the frozen proposal after the entire affirmative %s", async text => {
    const tasks = manager(), legacy = vi.fn(async () => deletePlan()), deps = safeDeps(legacy);
    const first = await tasks.run(request(), deps);
    const confirmed = await tasks.run(reply(first, text), deps);
    publicOnly(confirmed); expect(confirmed.envelope).toEqual(deletePlan().envelope);
    expect(confirmed.task?.status).toBe("awaiting_execution");
    expect(legacy).toHaveBeenCalledTimes(1);
    expect(await tasks.run(reply(first, text), deps)).toEqual(confirmed);
  });

  it.each(["不", "取消", "算了", "确定但不要删便笺", "确定，然后删除全部", "是吗", "删吧？", "1", "请先聚焦"])("cancels without partial execution for %s", async text => {
    const tasks = manager(), legacy = vi.fn(async () => deletePlan()), deps = safeDeps(legacy);
    const first = await tasks.run(request(), deps), cancelled = await tasks.run(reply(first, text), deps);
    withheld(cancelled); expect(cancelled.task?.status).toBe("cancelled");
    expect(await tasks.run(reply(first, "确定"), deps)).toEqual(cancelled);
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it("holds updates, creation and deletion together until confirmation", async () => {
    const actions: Action[] = [
      { type: "card.update", targetId: "TEST-note-2", displayProps: { text: "更新后的会议记录" } },
      { type: "card.delete", targetId: "TEST-note-1" },
      { type: "card.create", card: { id: "TEST-new-note", type: "NoteCard", variant: "minimal", displayProps: { text: "新便笺" },
        sourceData: {}, sources: [], layout: { x: 1600, y: 0, width: 320, height: 120, pinned: false },
        metadata: { createdAt: "2026-10-30T00:00:00.000Z", updatedAt: "2026-10-30T00:00:00.000Z" } } },
    ];
    const tasks = manager(), legacy = vi.fn(async () => plan(actions)), deps = safeDeps(legacy);
    const req = request("更新会议记录并删除读书笔记，然后新建便笺"), before = structuredClone(req.canvasContext);
    const first = await tasks.run(req, deps); withheld(first);
    expect(first.message).toContain("新增1张卡片"); expect(first.message).toContain("更新1张卡片");
    const result = await tasks.run(reply(first, "确定"), deps);
    expect(result.envelope?.actions).toEqual(actions); expect(req.canvasContext).toEqual(before);
  });

  it("does not broaden deletion if its original proposal object is later mutated", async () => {
    const original = deletePlan(), expected = structuredClone(original.envelope);
    const tasks = manager(), legacy = vi.fn(async () => original), deps = safeDeps(legacy);
    const first = await tasks.run(request(), deps);
    original.envelope!.actions = [{ type: "cards.delete", targetIds: context().cards.map(card => card.id) }];
    const result = await tasks.run(reply(first, "确定"), deps);
    expect(result.envelope).toEqual(expected);
  });

  it("keeps safety enabled if later task dependencies omit the flag", async () => {
    const tasks = manager(), legacy = vi.fn(async () => deletePlan());
    const first = await tasks.run(request(), safeDeps(legacy));
    const rejected = await tasks.run(reply(first, "确定但还要删其他卡"), { legacy });
    withheld(rejected); expect(rejected.task?.status).toBe("cancelled");
  });

  it("rejects a deletion for a different canvas and a truncated batch scope", async () => {
    const tasks = manager(), deps = safeDeps(async () => plan([{ type: "card.delete", targetId: "TEST-note-1" }], "TEST-other-canvas"));
    withheld(await tasks.run(request(), deps));
    const batch = manager(), ctx = { ...context(), totalCardCount: 20 };
    const result = await batch.run(request("删除全部卡片", ctx), safeDeps(async () => plan([{ type: "cards.delete", targetIds: ctx.cards.map(card => card.id) }])));
    withheld(result); expect(result.task?.status).toBe("awaiting_clarification");
  });
});

describe("confirmation preserves canvas, lifetime and receipt boundaries", () => {
  it("rejects cross-canvas confirmation without returning an execution", async () => {
    const tasks = manager(), deps = safeDeps(async () => deletePlan()), first = await tasks.run(request(), deps);
    const result = await tasks.run(reply(first, "确定", { ...context(), canvasId: "TEST-other-canvas" }), deps);
    expect(result.kind).toBe("error"); expect(result.envelope).toBeUndefined();
  });

  it.each(["removed", "renamed", "version", "new-card", "no-version"])("cancels when the frozen target or version changes: %s", async change => {
    const tasks = manager(), legacy = vi.fn(async () => plan([{ type: "cards.delete", targetIds: context().cards.map(card => card.id) }])), deps = safeDeps(legacy);
    const initial = context(); if (change === "no-version") delete initial.version;
    const first = await tasks.run(request("删除全部卡片", initial), deps), ctx = structuredClone(initial);
    if (change === "removed") ctx.cards.shift();
    if (change === "renamed" || change === "no-version") ctx.cards[0]!.displayProps.text = "改变后的原文";
    if (change === "version") ctx.version = 8;
    if (change === "new-card") ctx.cards.push({ ...ctx.cards[0]!, id: "TEST-new-card" });
    const result = await tasks.run(reply(first, "确定", ctx), deps);
    withheld(result); expect(result.task?.status).toBe("cancelled");
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it("accepts a reordered identical snapshot while preserving frozen deletion IDs", async () => {
    const ids = context().cards.map(card => card.id), tasks = manager(), deps = safeDeps(async () => plan([{ type: "cards.delete", targetIds: ids }]));
    const first = await tasks.run(request("删除全部卡片"), deps), ctx = context(); ctx.cards.reverse();
    expect((await tasks.run(reply(first, "确定", ctx), deps)).envelope?.actions).toEqual([{ type: "cards.delete", targetIds: ids }]);
  });

  it("does not accept a receipt as deletion confirmation, then deduplicates the real receipt", async () => {
    const tasks = manager(), legacy = vi.fn(async () => deletePlan()), deps = safeDeps(legacy), first = await tasks.run(request(), deps);
    const early = await tasks.run({ ...reply(first, "确定"), task: { id: first.task!.id, receipt: { executionId: "TEST-fake", status: "succeeded" } } }, deps);
    expect(early.kind).toBe("error"); expect(early.envelope).toBeUndefined();
    const confirmed = await tasks.run(reply(first, "确定"), deps);
    const wrong = await tasks.run({ ...reply(first, "已执行"), task: { id: first.task!.id, receipt: { executionId: "TEST-wrong", status: "succeeded" } } }, deps);
    expect(wrong.kind).toBe("error");
    const ctx = context(); ctx.version = 8; ctx.cards = ctx.cards.filter(card => card.id !== "TEST-note-1");
    const receipt: IntentRequest = { ...reply(first, "已执行", ctx), task: { id: first.task!.id, receipt: { executionId: confirmed.task!.executionId!, status: "succeeded" } } };
    const complete = await tasks.run(receipt, deps);
    expect(complete.task?.status).toBe("completed");
    expect(await tasks.run(receipt, deps)).toEqual(complete);
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it("does not share tasks between session-owned managers", async () => {
    const firstManager = manager(), secondManager = manager(), deps = safeDeps(async () => deletePlan());
    const first = await firstManager.run(request(), deps);
    const unknown = await secondManager.run({ ...reply(first, "已执行"), task: { id: first.task!.id, receipt: { executionId: "TEST-fake", status: "succeeded" } } }, deps);
    expect(unknown.kind).toBe("error"); expect(unknown.envelope).toBeUndefined();
    const other = await secondManager.run(reply(first, "确定"), deps);
    withheld(other); expect(other.task?.status).toBe("awaiting_clarification");
  });

  it("rejects expired confirmation and cancelled or obsolete model sessions", async () => {
    let now = 0;
    const tasks = manager({ now: () => now, ttlMs: 10 }), deps = safeDeps(async () => deletePlan()), first = await tasks.run(request(), deps);
    now = 11; const expired = await tasks.run(reply(first, "确定"), deps);
    withheld(expired); expect(expired.task?.status).toBe("failed");
    const next = manager(), controller = new AbortController(), second = await next.run(request(), deps); controller.abort();
    const cancelled = await next.run(reply(second, "确定"), deps, controller.signal);
    withheld(cancelled); expect(cancelled.task?.status).toBe("cancelled");
    const changed = manager(), third = await changed.run(request(), deps);
    const stale = await changed.run(reply(third, "确定"), { ...deps, isCurrent: () => false });
    withheld(stale); expect(stale.task?.status).toBe("failed");
  });
});

describe("target disambiguation uses frozen numbers and the original goal", () => {
  it.each([["第一个", "TEST-note-1"], ["1", "TEST-note-1"], ["第二个", "TEST-note-2"], ["2号", "TEST-note-2"], ["会议记录", "TEST-note-2"]])(
    "resolves %s from the original candidate list", async (text, targetId) => {
      const tasks = manager(), legacy = vi.fn(async (req: IntentRequest): Promise<IntentResult> => req.resolvedTargetId
        ? plan([{ type: "card.focus", targetId: req.resolvedTargetId }]) : ambiguous()), deps = safeDeps(legacy);
      const first = await tasks.run(request("聚焦便笺"), deps); withheld(first);
      expect(first.task?.clarification?.candidates.map(candidate => candidate.id)).toEqual(["TEST-note-1", "TEST-note-2"]);
      const reordered = context(); reordered.cards.reverse();
      const result = await tasks.run(reply(first, text, reordered), deps);
      expect(result.envelope?.actions).toEqual([{ type: "card.focus", targetId }]); publicOnly(result);
      expect(legacy.mock.calls[1]![0]).toMatchObject({ text: "聚焦便笺", resolvedTargetId: targetId, resolvedTargets: { "0": targetId } });
      expect(legacy.mock.calls[1]![0].continuation).toBeUndefined();
    });

  it("does not reinterpret unknown numbering or duplicate labels as a new command", async () => {
    const tasks = manager(), legacy = vi.fn(async () => ambiguous()), deps = safeDeps(legacy), first = await tasks.run(request("聚焦便笺"), deps);
    const invalid = await tasks.run(reply(first, "第三个"), deps);
    withheld(invalid); expect(invalid.task?.clarification?.candidates).toEqual(first.task?.clarification?.candidates);
    expect(legacy).toHaveBeenCalledTimes(1);
    const duplicate = manager(), dup = await duplicate.run(request("聚焦便笺"), safeDeps(async () => ({ ...ambiguous(), targetCandidates: hidden.targetCandidates.map(card => ({ ...card, label: "同名" })) })));
    withheld(await duplicate.run(reply(dup, "同名"), deps));
  });

  it("refuses a disappeared candidate without replacing it with a new card of the same title", async () => {
    const tasks = manager(), legacy = vi.fn(async () => ambiguous()), deps = safeDeps(legacy), first = await tasks.run(request("聚焦便笺"), deps);
    const ctx = context(); ctx.cards[0] = { ...ctx.cards[0]!, id: "TEST-replacement" };
    const stale = await tasks.run(reply(first, "第一个", ctx), deps);
    withheld(stale); expect(stale.message).toContain("已不存在");
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it("rejects an obsolete candidate snapshot while keeping its original numbering", async () => {
    const tasks = manager(), legacy = vi.fn(async () => ambiguous()), deps = safeDeps(legacy), first = await tasks.run(request("聚焦便笺"), deps);
    const stale = await tasks.run(reply(first, "第一个", { ...context(), version: 6 }), deps);
    withheld(stale); expect(stale.message).toContain("版本已过期");
    expect(stale.task?.clarification?.candidates).toEqual(first.task?.clarification?.candidates);
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it("requires a separate confirmation after choosing an ambiguous delete target", async () => {
    const tasks = manager(), legacy = vi.fn(async (req: IntentRequest): Promise<IntentResult> => req.resolvedTargetId
      ? plan([{ type: "card.delete", targetId: req.resolvedTargetId }]) : ambiguous()), deps = safeDeps(legacy);
    const first = await tasks.run(request("删除便笺"), deps), selected = await tasks.run(reply(first, "第二个"), deps);
    withheld(selected); expect(selected.message).toContain("确定删除");
    const confirmed = await tasks.run(reply(first, "确定"), deps);
    expect(confirmed.envelope?.actions).toEqual([{ type: "card.delete", targetId: "TEST-note-2" }]);
    expect(legacy).toHaveBeenCalledTimes(2);
  });

  it("keeps each clause's chosen ID without applying a selection to the whole request", async () => {
    const tasks = manager(), legacy = vi.fn(async (req: IntentRequest): Promise<IntentResult> => {
      if (!req.resolvedTargets?.["0"]) return { ...ambiguous(), targetClause: 0 };
      if (!req.resolvedTargets["1"]) return { kind: "clarify", message: "请选择待办。", targetClause: 1,
        targetCandidates: [{ id: "TEST-todo-1", label: "购物清单" }, { id: "TEST-todo-2", label: "工作清单" }] };
      return plan([{ type: "card.delete", targetId: req.resolvedTargets["0"] }, { type: "card.delete", targetId: req.resolvedTargets["1"] }]);
    }), deps = safeDeps(legacy), goal = "删除便笺，然后删除待办";
    const first = await tasks.run(request(goal), deps), second = await tasks.run(reply(first, "第二个"), deps);
    withheld(second); expect(second.task?.clarification?.candidates[0]?.id).toBe("TEST-todo-1");
    const selected = await tasks.run(reply(first, "购物清单"), deps); withheld(selected);
    expect(legacy.mock.calls[2]![0]).toMatchObject({ text: goal, resolvedTargets: { "0": "TEST-note-2", "1": "TEST-todo-1" } });
    expect(legacy.mock.calls[2]![0].resolvedTargetId).toBeUndefined();
    const confirmed = await tasks.run(reply(first, "确定"), deps); publicOnly(confirmed);
    expect(confirmed.envelope?.actions).toEqual([{ type: "card.delete", targetId: "TEST-note-2" }, { type: "card.delete", targetId: "TEST-todo-1" }]);
    expect(legacy).toHaveBeenCalledTimes(3);
  });
});

describe("native proposals use the same host confirmation gate", () => {
  it("does not treat native authorization as the user's delete confirmation", async () => {
    const provider = native(key => ({ next_step: "resolve", operation: "card.delete", target: "TEST-note-1", authorization: "authorized", goal_coverage: "complete" }[key]!));
    const tasks = manager({ provider, gate: { executionEnabled: true } }), legacy = vi.fn(async () => deletePlan()), deps = safeDeps(legacy);
    const first = await tasks.run(request(), deps); withheld(first); expect(first.kind).toBe("clarify");
    const calls = provider.decide.mock.calls.length, confirmed = await tasks.run(reply(first, "确定"), deps);
    expect(confirmed.envelope?.actions).toEqual(deletePlan().envelope!.actions);
    expect(provider.decide).toHaveBeenCalledTimes(calls); expect(legacy).not.toHaveBeenCalled();
  });

  it("gates native execute of a planner's mixed delete proposal without another RPC on confirmation", async () => {
    const provider = native((key, state) => key === "next_step" ? state.phase === "after_llm" ? "execute" : "llm"
      : key === "llm_subtask" ? "plan" : "complete");
    const tasks = manager({ provider, gate: { executionEnabled: true } }), legacy = vi.fn(async () => plan([
      { type: "card.focus", targetId: "TEST-note-2" }, { type: "card.delete", targetId: "TEST-note-1" },
    ])), deps = safeDeps(legacy), first = await tasks.run(request("聚焦会议记录并删除读书笔记"), deps);
    withheld(first); const calls = provider.decide.mock.calls.length;
    expect((await tasks.run(reply(first, "确定"), deps)).envelope?.actions).toHaveLength(2);
    expect(provider.decide).toHaveBeenCalledTimes(calls); expect(legacy).toHaveBeenCalledTimes(1);
  });

  it("preserves the disabled native gate and confirms the offline fallback proposal", async () => {
    const provider = native(() => "resolve"), legacy = vi.fn(async (_request: IntentRequest) => deletePlan());
    const tasks = manager({ provider }), first = await tasks.run(request(), safeDeps(legacy));
    withheld(first); expect(first.task?.decision).toBe("legacy-fallback");
    expect(provider.decide).not.toHaveBeenCalled();
    expect(legacy.mock.calls[0]![0].offlineReferenceCompatibility).toBe(true);
  });
});

describe("read-only delete preparation reuses the existing route and target hint", () => {
  function hint(target: TargetResult | undefined, route: "delete" | "answer" | "chat" = "delete"): PlannerRouteHint {
    return { result: { route, probability: .01, probabilities: { [route]: .01 }, none: false, latencyMs: 1 }, target: Promise.resolve(target) };
  }
  const offline = () => vi.fn(async (): Promise<IntentResult> => ({ kind: "unknown", message: "TEST planner not connected" }));

  it("prepares a unique low-confidence delete without the unavailable main model, then asks for confirmation", async () => {
    const tasks = manager(), legacy = offline(), deps = { ...safeDeps(legacy), routeHint: Promise.resolve(hint({ targetId: "TEST-note-1" })) };
    const first = await tasks.run(request(), deps);
    withheld(first); expect(first.kind).toBe("clarify"); expect(first.message).toContain("确定删除「读书笔记」");
    const confirmed = await tasks.run(reply(first, "确定"), deps);
    expect(confirmed.envelope?.actions).toEqual([{ type: "card.delete", targetId: "TEST-note-1" }]);
    expect(confirmed.task?.status).toBe("awaiting_execution"); expect(legacy).not.toHaveBeenCalled();
  });

  it("keeps the same target promise and frozen candidates across selection and separate confirmation", async () => {
    const target = vi.fn(() => Promise.resolve({ ambiguous: hidden.targetCandidates }));
    const value: PlannerRouteHint = { ...hint(undefined), get target() { return target(); } };
    const tasks = manager(), legacy = offline(), deps = { ...safeDeps(legacy), routeHint: Promise.resolve(value) };
    const first = await tasks.run(request("删除便笺"), deps); withheld(first);
    expect(first.task?.clarification?.candidates.map(candidate => candidate.id)).toEqual(["TEST-note-1", "TEST-note-2"]);
    const ctx = context(); ctx.cards.reverse();
    const selected = await tasks.run(reply(first, "第二个", ctx), { ...deps, routeHint: Promise.resolve(hint({ missing: true }, "answer")) });
    withheld(selected); expect(selected.message).toContain("确定删除「会议记录」");
    const confirmed = await tasks.run(reply(first, "删吧", ctx), deps);
    expect(confirmed.envelope?.actions).toEqual([{ type: "card.delete", targetId: "TEST-note-2" }]);
    expect(target).toHaveBeenCalledTimes(1); expect(legacy).not.toHaveBeenCalled();
  });

  it("retains the original delete intent when 第一个 and 确定 are classified as chat", async () => {
    const tasks = manager(), legacy = offline(), ctx = context(); ctx.cards = ctx.cards.slice(0, 2);
    const originalHint = hint({ ambiguous: hidden.targetCandidates });
    originalHint.result = { ...originalHint.result!, probability: .99, probabilities: { delete: .99 } };
    const deps = { ...safeDeps(legacy), routeHint: Promise.resolve(originalHint) };
    const first = await tasks.run(request("删除便签", ctx), deps); withheld(first);
    expect(first.task?.clarification?.candidates.map(candidate => candidate.id)).toEqual(["TEST-note-1", "TEST-note-2"]);
    const chatDeps = { ...deps, routeHint: Promise.resolve(hint({ missing: true }, "chat")) };
    const selected = await tasks.run(reply(first, "第一个", ctx), chatDeps); withheld(selected);
    expect(selected.task?.id).toBe(first.task?.id);
    expect(selected.message).toContain("确定删除「读书笔记」");
    expect(selected.task?.clarification?.candidates).toEqual([]);
    const confirmed = await tasks.run(reply(first, "确定", ctx), chatDeps); publicOnly(confirmed);
    expect(confirmed.task?.status).toBe("awaiting_execution");
    expect(confirmed.envelope?.actions).toEqual([{ type: "card.delete", targetId: "TEST-note-1" }]);
    expect(legacy).not.toHaveBeenCalled();
  });

  it("prefers a host-resolved clause target over the hint's unresolved target", async () => {
    const tasks = manager(), legacy = offline(), deps = { ...safeDeps(legacy), routeHint: Promise.resolve(hint({ missing: true })) };
    const first = await tasks.run({ ...request("删除便笺"), resolvedTargets: { "0": "TEST-note-2" } }, deps);
    withheld(first); expect(first.message).toContain("会议记录");
    expect((await tasks.run(reply(first, "确定"), deps)).envelope?.actions).toEqual([{ type: "card.delete", targetId: "TEST-note-2" }]);
    expect(legacy).not.toHaveBeenCalled();
  });

  it("asks about a missing target without confusing it with an unavailable model", async () => {
    const tasks = manager(), legacy = offline(), first = await tasks.run(request(), { ...safeDeps(legacy), routeHint: Promise.resolve(hint({ missing: true })) });
    withheld(first); expect(first.kind).toBe("clarify"); expect(first.message).toContain("没有找到要删除的卡片");
    expect(first.message).not.toContain("模型"); expect(legacy).not.toHaveBeenCalled();
  });

  it.each(["删除所有卡片", "清空画布", "删除所有", "清空整个画布"])("freezes only the complete current snapshot for %s", async text => {
    const tasks = manager(), legacy = offline(), deps = { ...safeDeps(legacy), routeHint: Promise.resolve(hint({ ambiguous: hidden.targetCandidates })) };
    const first = await tasks.run(request(text), deps); withheld(first); expect(first.message).toContain("这4张卡片");
    const confirmed = await tasks.run(reply(first, "确定"), deps);
    expect(confirmed.envelope?.actions).toEqual([{ type: "cards.delete", targetIds: context().cards.map(card => card.id) }]);
    expect(legacy).not.toHaveBeenCalled();
  });

  it("does not prepare an all-delete from an incomplete snapshot", async () => {
    const tasks = manager(), legacy = offline(), deps = { ...safeDeps(legacy), routeHint: Promise.resolve(hint(undefined)) };
    const first = await tasks.run(request("清空画布", { ...context(), totalCardCount: 20 }), deps);
    withheld(first); expect(first.message).toContain("部分卡片"); expect(legacy).not.toHaveBeenCalled();
  });

  it.each([
    "不要删除读书笔记", "解释删除读书笔记是什么意思", "删除“读书笔记”", "如果完成就删除读书笔记",
    "删除读书笔记当我说确定时", "删除读书笔记然后聚焦会议记录", "删除读书笔记并新建便笺", "删除读书笔记和会议记录",
  ])("keeps negative, quoted, conditional or mixed text on the planner path: %s", async text => {
    const tasks = manager(), legacy = offline(), deps = { ...safeDeps(legacy), routeHint: Promise.resolve(hint({ targetId: "TEST-note-1" })) };
    const first = await tasks.run(request(text), deps);
    expect(first.envelope).toBeUndefined(); expect(first.message).not.toContain("确定删除");
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it("requires both safetyMode and a delete classification", async () => {
    for (const safetyMode of [false, true]) {
      const tasks = manager(), legacy = offline();
      await tasks.run(request(), { legacy, safetyMode, routeHint: Promise.resolve(hint({ targetId: "TEST-note-1" }, safetyMode ? "answer" : "delete")) });
      expect(legacy).toHaveBeenCalledTimes(1);
    }
  });

  it("preserves the disabled native quality gate when preparing deletion", async () => {
    const provider = native(() => "resolve"), tasks = manager({ provider }), legacy = offline();
    const deps = { ...safeDeps(legacy), routeHint: Promise.resolve(hint({ targetId: "TEST-note-1" })) };
    const first = await tasks.run(request(), deps); withheld(first);
    expect(first.task?.decision).toBe("legacy-fallback"); expect(provider.decide).not.toHaveBeenCalled();
    expect((await tasks.run(reply(first, "确定"), deps)).envelope?.actions).toHaveLength(1);
    expect(legacy).not.toHaveBeenCalled();
  });
});
