import { describe, expect, it, vi } from "vitest";
import { ActionEnvelopeSchema, type IntentRouteId } from "@vivic/contracts";
import { CredentialStore } from "../src/credentials.js";
import type { CanvasContext } from "../src/schemas.js";
import { runIntent, type PipelineDeps } from "../src/intent/pipeline.js";
import type { IntentRouter, RouteResult } from "../src/decision/router.js";

const allowed: IntentRouteId[] = ["countdown", "todo", "note", "overview", "restore"];
const context = (cards: CanvasContext["cards"] = []): CanvasContext => ({ canvasId: "TEST-on", stage: "WORKSPACE", viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], cards });
const route = (id: IntentRouteId, probability = .99): RouteResult => ({ route: id, probability, probabilities: { [id]: probability }, none: false, latencyMs: 1 });
function setup(id: IntentRouteId | ((text: string) => IntentRouteId), value: unknown = {}, probability = .99) {
  const router: IntentRouter = { mode: "on", directRoutes: new Set(allowed),
    routeUtterance: vi.fn(async text => route(typeof id === "function" ? id(text) : id, probability)), chooseTarget: vi.fn(async () => null) };
  const generate = vi.fn(async () => ({ ok: true as const, value }));
  const deps: PipelineDeps = { router, credentials: new CredentialStore(), stepfun: { baseUrl: "https://unused.test" },
    planner: { provider: "gpt", connected: true, isCurrent: () => true, generate } };
  return { deps, router, generate };
}
const created = (result: Awaited<ReturnType<typeof runIntent>>) => result.envelope?.actions.flatMap(action => action.type === "card.create" ? [action.card] : []) ?? [];

describe("approved on-mode contract execution", () => {
  it.each([
    ["countdown", "倒计时50分钟", "CountdownCard"], ["todo", "添加待办：喝水、交周报", "TodoCard"],
    ["note", "帮我记个便签明天交周报", "NoteCard"], ["overview", "显示全部", null], ["restore", "恢复原视图", null],
  ] as const)("executes %s from validated parameters without a planner", async (id, text, cardType) => {
    const f = setup(id);
    const r = await runIntent({ text, canvasContext: context() }, f.deps);
    expect(r.kind).toBe("envelope");
    expect(ActionEnvelopeSchema.safeParse(r.envelope).success).toBe(true);
    expect(r.trace).toMatchObject({ mode: "on", plannerCalls: 0, directClauses: 1 });
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.router.routeUtterance).not.toHaveBeenCalled();
    expect(r.trace?.decisions[0]?.source).toBe("rules");
    expect(r.usedProvider).toBe("rules");
    if (cardType) expect(created(r).map(card => card.type)).toEqual([cardType]);
  });
  it("creates a note and countdown atomically with a single camera fit and no planner", async () => {
    const f = setup(text => /便签/.test(text) ? "note" : "countdown");
    const fixed = { id: "TEST-fixed", type: "NoteCard", displayProps: { text: "不可移动" }, sourceDataSummary: {}, layout: { x: 0, y: 0, width: 600, height: 400, pinned: true } };
    const ctx = { ...context([fixed]), stage: "STANDBY" as const };
    const original = structuredClone(ctx);
    const r = await runIntent({ text: "帮我记个便签明天交周报，再设个50分钟倒计时", canvasContext: ctx }, f.deps);
    expect(r.kind).toBe("envelope");
    expect(created(r).map(card => card.type)).toEqual(["NoteCard", "CountdownCard"]);
    expect(created(r)[0]?.layout.x).toBeGreaterThanOrEqual(600);
    expect(created(r)[1]!.layout.x).toBeGreaterThanOrEqual(created(r)[0]!.layout.x + created(r)[0]!.layout.width);
    expect(r.envelope!.actions.filter(action => action.type === "stage.awaken")).toHaveLength(1);
    expect(r.envelope!.actions.filter(action => action.type === "canvas.fit")).toHaveLength(1);
    expect(r.envelope!.actions.filter(action => action.type === "subtitle.show")).toHaveLength(1);
    expect(r.trace).toMatchObject({ mode: "on", directClauses: 2, plannerCalls: 0 });
    expect(ctx).toEqual(original);
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.router.routeUtterance).not.toHaveBeenCalled();
  });
  it("records which cards each clause built without storing card text", async () => {
    const f = setup(text => /便签/.test(text) ? "note" : "countdown");
    const r = await runIntent({ text: "帮我记个便签明天交周报，再设个50分钟倒计时", canvasContext: context() }, f.deps);
    expect(r.kind).toBe("envelope");
    expect(r.trace?.decisions.map(row => row.built)).toEqual([
      { cards: ["NoteCard"], n: 1 }, { cards: ["CountdownCard"], n: 1 },
    ]);
    // Card types and counts only: no clause text, title or body reaches the field.
    expect(JSON.stringify(r.trace?.decisions.map(row => row.built))).not.toContain("交周报");
  });
  it("fills only the unparsed clause, then merges it with the deterministic clause", async () => {
    const f = setup(text => /便签/.test(text) ? "note" : "countdown", { slots: { seconds: 300, text: "休息" } });
    const r = await runIntent({ text: "帮我记个便签明天交周报，然后过五分钟叫我休息", canvasContext: context() }, f.deps);
    expect(r.kind, JSON.stringify(r)).toBe("envelope");
    expect(created(r).map(card => card.type)).toEqual(["NoteCard", "CountdownCard"]);
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(r.trace).toMatchObject({ plannerCalls: 1, directClauses: 1 });
  });
  it("returns one clarification rather than a partial proposal if any clause needs information", async () => {
    const f = setup(text => /便签/.test(text) ? "note" : "countdown", { clarify: "要计时多久？" });
    const r = await runIntent({ text: "帮我记个便签明天交周报，然后设一个倒计时", canvasContext: context() }, f.deps);
    expect(r.kind).toBe("clarify");
    expect(r.envelope).toBeUndefined();
    expect(r.trace).toMatchObject({ plannerCalls: 1, directClauses: 0 });
    // A turn that committed nothing must not claim per-clause cards.
    expect(r.trace?.decisions.every(row => row.built === undefined)).toBe(true);
  });
  it("does not turn an invented timer length into a real countdown", async () => {
    // The user never said how long: a model-supplied 300 s is a guess, not a slot.
    const f = setup(text => /便签/.test(text) ? "note" : "countdown", { slots: { seconds: 300, text: "喝水" } });
    const r = await runIntent({ text: "帮我记个便签明天交周报，然后设一个倒计时", canvasContext: context() }, f.deps);
    expect(r.kind).toBe("clarify");
    expect(r.envelope).toBeUndefined();
    expect(created(r)).toHaveLength(0);
    expect(r.message).toContain("多久");
    expect(f.generate).toHaveBeenCalledTimes(1);
  });
  it("uses the whole slots planner for a non-approved clause and does not partially build", async () => {
    const f = setup(text => /便签/.test(text) ? "note" : "focus", { clarify: "请选择要查看的卡片。" });
    const r = await runIntent({ text: "帮我记个便签明天交周报，然后聚焦一张卡片", canvasContext: context() }, f.deps);
    expect(r.kind).toBe("clarify");
    expect(r.envelope).toBeUndefined();
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(r.trace?.directClauses).toBe(0);
  });
  it.each([.79, .3])("does not fall back to fast legacy rules below the direct confidence gate %s", async probability => {
    const f = setup("countdown", { slots: { seconds: 3000 } }, probability);
    const r = await runIntent({ text: "过五分钟叫我休息", canvasContext: context() }, f.deps);
    if (probability < .5) {
      // The low-confidence planner chooses from the top three contracts.
      expect(f.generate).toHaveBeenCalled();
    } else expect(r.kind).toBe("envelope");
    expect(f.generate).toHaveBeenCalled();
    expect(r.trace?.directClauses).toBe(0);
  });
  it("an empty allow-list cannot enable new classifier execution", async () => {
    const f = setup("countdown", { slots: { seconds: 3000 } }); f.router.directRoutes = new Set();
    const r = await runIntent({ text: "倒计时50分钟", canvasContext: context() }, f.deps);
    expect(r.kind).toBe("envelope");
    expect(r.trace).toMatchObject({ plannerCalls: 1, directClauses: 0 });
  });
  it("does not use the offline target shortcut to execute an unapproved route", async () => {
    const f = setup("focus"); f.deps.planner!.connected = false;
    const ctx = context([{ id: "TEST-note", type: "NoteCard", aliases: ["读书笔记"], displayProps: { text: "正文" }, sourceDataSummary: {}, layout: { x: 0, y: 0 } }]);
    const r = await runIntent({ text: "聚焦读书笔记", canvasContext: ctx, offlineReferenceCompatibility: true }, f.deps);
    expect(r.kind).toBe("unknown");expect(r.envelope).toBeUndefined();
    expect(r.trace?.directClauses).toBe(0);expect(f.generate).not.toHaveBeenCalled();
  });
  it("defers a negated command even if classification is confidently wrong", async () => {
    const f = setup("countdown", { clarify: "这次不设置计时。" });
    const r = await runIntent({ text: "不要设置50分钟倒计时", canvasContext: context() }, f.deps);
    expect(r.kind).toBe("clarify");expect(r.envelope).toBeUndefined();expect(r.trace?.directClauses).toBe(0);
  });
  it("keeps literal approved tasks usable during a router outage without calling the planner", async () => {
    const f = setup("countdown", { contract: "countdown", slots: { seconds: 3000 } });
    vi.mocked(f.router.routeUtterance).mockResolvedValue(null);
    const r = await runIntent({ text: "倒计时50分钟", canvasContext: context() }, f.deps);
    expect(r.kind).toBe("envelope");expect(f.generate).not.toHaveBeenCalled();
    expect(f.router.routeUtterance).not.toHaveBeenCalled();
    expect(r.trace).toMatchObject({ status: "complete", plannerCalls: 0, directClauses: 1 });
    expect(r.usedProvider).toBe("rules");
  });
  it("keeps nonliteral router-outage requests in the slots planner", async () => {
    const f=setup("countdown",{contract:"countdown",slots:{seconds:300,text:"休息"}});
    vi.mocked(f.router.routeUtterance).mockResolvedValue(null);
    const r=await runIntent({text:"过五分钟叫我休息",canvasContext:context()},f.deps);
    expect(r.kind).toBe("envelope");expect(f.generate).toHaveBeenCalledTimes(1);expect(r.trace?.directClauses).toBe(0);
  });
  it("discards a proposal when the session changes while the route is awaited", async () => {
    const f = setup("countdown"); f.deps.isSessionCurrent = () => false;
    const r = await runIntent({ text: "倒计时50分钟", canvasContext: context() }, f.deps);
    expect(r.kind).toBe("error");expect(r.envelope).toBeUndefined();expect(f.generate).not.toHaveBeenCalled();
  });
  it("off remains the pre-existing path and never classifies", async () => {
    const f = setup("countdown");f.router.mode = "off";
    const r = await runIntent({ text: "倒计时50分钟", canvasContext: context() }, f.deps);
    expect(r.kind).toBe("envelope");expect(r.usedProvider).toBe("rules");expect(f.router.routeUtterance).not.toHaveBeenCalled();
  });
});
