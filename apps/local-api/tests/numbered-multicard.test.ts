import { afterEach, describe, expect, it, vi } from "vitest";
import type { CardRecord, IntentRouteId } from "@vivic/contracts";
import { CredentialStore } from "../src/credentials.js";
import { splitClauses } from "../src/decision/split.js";
import { runIntent, type IntentResult, type PipelineDeps } from "../src/intent/pipeline.js";
import type { IntentRouter, RouteResult } from "../src/decision/router.js";
import { IntentResponseSchema, type CanvasContext } from "../src/schemas.js";
import type { ChatMessage, StepfunResult } from "../src/stepfun.js";

const originalMode = process.env.VIVIC_MULTI_CARD_MODE;
afterEach(() => {
  if (originalMode === undefined) delete process.env.VIVIC_MULTI_CARD_MODE;
  else process.env.VIVIC_MULTI_CARD_MODE = originalMode;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const context = (): CanvasContext => ({ canvasId: "TEST-numbered", stage: "WORKSPACE",
  viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], cards: [], timeZone: "Asia/Shanghai" });
const route = (id: IntentRouteId, probability = .99): RouteResult =>
  ({ route: id, probability, probabilities: { [id]: probability }, none: false, latencyMs: 1 });

/** Route per sentence; the deterministic path should never need it. */
const routeFor = (text: string): IntentRouteId => {
  if (/倒计时|分钟|计时|提醒/.test(text)) return "countdown";
  if (/待办|清单/.test(text)) return "todo";
  if (/便笺|便签|笔记/.test(text)) return "note";
  return "generate";
};

function setup(mode: "on" | "off" = "on") {
  const generate = vi.fn(async (_messages: ChatMessage[]): Promise<StepfunResult<unknown>> =>
    ({ ok: true, value: { clarify: "模型不应被调用：本地契约应已覆盖全部子句" } }));
  const router: IntentRouter = { mode, directRoutes: new Set(["countdown", "todo", "note", "overview", "restore"]),
    routeUtterance: vi.fn(async (text: string) => route(routeFor(text))), chooseTarget: vi.fn(async () => null) };
  const credentials = new CredentialStore();
  credentials.set({ apiKey: "TEST-numbered-key", defaultModel: "deepseek-flash", models: ["deepseek-flash"], checkedAt: new Date().toISOString() });
  const deps: PipelineDeps = { credentials, stepfun: { baseUrl: "https://unused.test" },
    planner: { provider: "gpt", connected: true, isCurrent: () => true, generate }, router,
    multiCard: mode === "on" ? "hybrid" : "off" };
  return { deps, generate, router };
}

const cards = (result: IntentResult): CardRecord[] => result.envelope?.actions.flatMap(action =>
  action.type === "card.create" ? [action.card] : []) ?? [];
const ofType = <T extends CardRecord["type"]>(list: CardRecord[], type: T): Array<Extract<CardRecord, { type: T }>> =>
  list.filter((item): item is Extract<CardRecord, { type: T }> => item.type === type);
const noClock = (value: unknown) => {
  const text = JSON.stringify(value);
  expect(text).not.toMatch(/\d{1,2}\s*[:：]\s*\d{2}/u);
  expect(text).not.toMatch(/\d{1,2}\s*点/u);
};

/** The three item forms a real user writes; each must build every sentence. */
const numbered = [
  ["arabic", "1. 创建一个半小时倒计时。 2. 周四下午要去健身。 3. 周四上午 9 点要开会。",
    ["创建一个半小时倒计时", "周四下午要去健身", "周四上午 9 点要开会"]],
  ["chinese", "一、创建半小时倒计时 二、周四下午要去健身 三、周四上午 9 点要开会",
    ["创建半小时倒计时", "周四下午要去健身", "周四上午 9 点要开会"]],
  ["newline", "1. 创建半小时倒计时\n2. 周四下午要去健身\n3. 周四上午 9 点要开会",
    ["创建半小时倒计时", "周四下午要去健身", "周四上午 9 点要开会"]],
] as const;

describe("numbered multi-intent: every item is built, never only the first card", () => {
  it.each(numbered)("%s list builds one countdown and both schedules", async (_label, text) => {
    const f = setup();
    const result = await runIntent({ text, canvasContext: context() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(IntentResponseSchema.safeParse(result).success).toBe(true);
    const created = cards(result);
    expect(created.map(item => item.type)).toEqual(["CountdownCard", "WeeklyScheduleCard", "WeeklyScheduleCard"]);
    // The whole point of the bug: clause 0 must not short-circuit the list.
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.router.routeUtterance).not.toHaveBeenCalled();
    const countdown = ofType(created, "CountdownCard")[0]!;
    expect(Date.parse(String(countdown.sourceData.targetAt))).toBeGreaterThan(Date.parse(String(countdown.sourceData.startedAt)));
    const [gym, meeting] = ofType(created, "WeeklyScheduleCard");
    // 下午 keeps the period in the title and invents no clock time.
    expect(gym!.displayProps).toMatchObject({ title: "周四 下午 健身", weekStart: "2026-11-02",
      events: [{ day: 4, title: "下午 健身" }] });
    expect(gym!.displayProps.events[0]).not.toHaveProperty("start");
    expect(gym!.displayProps.events[0]).not.toHaveProperty("end");
    noClock(gym!.displayProps.events);
    // 上午 9 点 is a real user clock time, so the start is kept and no end is invented.
    expect(meeting!.displayProps).toMatchObject({ title: "周四 开会",
      events: [{ day: 4, start: "09:00", title: "开会" }] });
    expect(meeting!.displayProps.events[0]).not.toHaveProperty("end");
    // Provenance: one rule plan per clause, built and committed together.
    expect(result.trace?.clauses).toHaveLength(3);
    expect(result.trace?.plans?.map(plan => [plan.clause, plan.contract, plan.source])).toEqual([
      [0, "countdown", "rules"], [1, "weekly_schedule", "rules"], [2, "weekly_schedule", "rules"],
    ]);
    expect(result.trace).toMatchObject({ plannerCalls: 0, directClauses: 3 });
    expect(result.trace?.decisions.map(row => row.route)).toEqual(["countdown", "generate", "generate"]);
    expect(result.trace?.decisions.map(row => row.built?.n)).toEqual([1, 1, 1]);
  });

  it.each(numbered)("%s list stays deterministic on the legacy (off) path", async (_label, text) => {
    const f = setup("off");
    const result = await runIntent({ text, canvasContext: context() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(cards(result).map(item => item.type)).toEqual(["CountdownCard", "WeeklyScheduleCard", "WeeklyScheduleCard"]);
    expect(f.generate).not.toHaveBeenCalled();
  });

  it("never commits the countdown alone when another item still needs the planner", async () => {
    const f = setup();
    const result = await runIntent({ text: "1. 创建一个半小时倒计时。 2. 明天北京天气", canvasContext: context() }, f.deps);
    // The second clause is not a literal contract: the whole turn is one
    // clarification, and the already-built countdown is not committed.
    expect(result.kind).toBe("clarify");
    expect(result.envelope).toBeUndefined();
    expect(cards(result)).toHaveLength(0);
    expect(result.trace?.plans).toBeUndefined();
    expect(f.generate).toHaveBeenCalled();
  });
});

describe("splitClauses owns numbered list structure", () => {
  it.each(numbered)("%s list is split per item", (_label, text, expected) => {
    expect(splitClauses(text)).toEqual(expected);
  });

  it("keeps a decimal and prose punctuation as content", () => {
    expect(splitClauses("版本1.5小时，再显示全部")).toEqual(["版本1.5小时", "显示全部"]);
    expect(splitClauses("倒计时1.5小时")).toEqual(["倒计时1.5小时"]);
    expect(splitClauses("统一、二、三都是数字")).toEqual(["统一、二、三都是数字"]);
  });

  it("folds a fourth item into the third clause instead of dropping it", () => {
    const clauses = splitClauses("1. 记个便签 2. 设个倒计时 3. 显示全部 4. 恢复原视图");
    expect(clauses).toHaveLength(3);
    expect(clauses[2]).toBe("显示全部，恢复原视图");
  });
});

describe("weekly plan request builds the scene card instead of asking the user", () => {
  const weekly = "帮我做一个下周的健身计划";

  it("leaves other plan subjects and named days on the planner path", async () => {
    const f = setup();
    const result = await runIntent({ text: "帮我做一个下周的旅行计划", canvasContext: context() }, f.deps);
    // The narrow deterministic draft only owns the fitness plan; everything
    // else keeps the existing model path (which may legitimately ask).
    expect(result.kind).toBe("clarify");
    expect(cards(result)).toHaveLength(0);
    expect(f.generate).toHaveBeenCalled();
  });

  it.each(["on", "off"] as const)("builds WeeklyScheduleCard on the %s path without clock times", async mode => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-17T02:00:00.000Z"));
    const f = setup(mode);
    const result = await runIntent({ text: weekly, canvasContext: context() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(result.message ?? "").not.toContain("想练哪几天");
    const created = cards(result);
    expect(created.map(item => item.type)).toEqual(["WeeklyScheduleCard"]);
    const plan = ofType(created, "WeeklyScheduleCard")[0]!;
    // A plan may propose days, but no clock time may be invented.
    expect(plan.displayProps).toMatchObject({ weekStart: "2026-10-19",
      events: [{ day: 1 }, { day: 3 }, { day: 5 }] });
    noClock(plan.displayProps.events);
    for (const event of plan.displayProps.events) {
      expect(event).not.toHaveProperty("start");
      expect(event).not.toHaveProperty("end");
    }
    expect(f.generate).not.toHaveBeenCalled();
    if (mode === "on") {
      expect(result.trace?.route).toBe("generate");
      expect(result.trace?.plans?.map(plan => [plan.clause, plan.contract])).toEqual([[0, "weekly_schedule"]]);
    }
  });
});
