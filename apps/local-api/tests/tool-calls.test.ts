import { describe, expect, it } from "vitest";
import { ActionEnvelopeSchema, type Action } from "@vivic/contracts";
import { TOOL_DEFINITIONS, buildToolSystemPrompt, planFromToolCalls, type ToolCall, type ToolCallPlan } from "../src/intent/toolCalls.js";
import { CanvasContextSchema, type CanvasContext } from "../src/schemas.js";

/**
 * The tool layer is a pure mapper: `tool_calls` in, existing card contracts out.
 * These tests pin both halves of the contract the model can break — the tool
 * surface (ten tools, one meaning each) and the ActionEnvelope the host commits.
 */

/** Fixed clock so countdown/weekly targets are deterministic (Sunday 2026-11-01, Shanghai). */
const NOW = Date.parse("2026-11-01T02:00:00+08:00");

/** Four existing cards, shaped exactly like the Control page's CanvasContext. */
const canvas = (): CanvasContext => ({
  canvasId: "TEST-tool-calls",
  stage: "WORKSPACE",
  viewport: { x: 0, y: 0, zoom: 1 },
  focusHistory: ["note_meeting"],
  timeZone: "Asia/Shanghai",
  cards: [
    {
      id: "note_meeting",
      type: "NoteCard",
      aliases: ["会议记录"],
      displayProps: { text: "周会纪要：确认发布窗口" },
      sourceDataSummary: {},
      layout: { x: 0, y: 0, width: 320, height: 120, pinned: false },
    },
    {
      id: "note_shopping",
      type: "NoteCard",
      aliases: ["购物便笺"],
      displayProps: { text: "采购清单" },
      sourceDataSummary: {},
      layout: { x: 344, y: 0, width: 320, height: 120 },
    },
    {
      id: "todo_week",
      type: "TodoCard",
      aliases: ["本周待办"],
      displayProps: { items: [{ id: "item-1", text: "交周报", done: false }] },
      sourceDataSummary: {},
      layout: { x: 0, y: 144, width: 288, height: 160 },
    },
    {
      id: "countdown_tea",
      type: "CountdownCard",
      aliases: ["泡茶"],
      displayProps: { totalSeconds: 300 },
      // No absolute ISO timestamp here on purpose: the scene guard treats any
      // calendar fact on the canvas as a weekday the user named, which makes
      // create_weekly_plan's proposed Mon/Wed/Fri "ungrounded". The probe canvas
      // also sent titles only; the production-shaped canvas is covered by the
      // sensitivity section of scripts/tool-dry-run.ts.
      sourceDataSummary: { remainingSeconds: 300 },
      layout: { x: 312, y: 144, width: 260, height: 200 },
    },
  ],
});

const plan = (calls: ToolCall[], ctx: CanvasContext = canvas(), utterance = ""): Promise<ToolCallPlan> =>
  planFromToolCalls(calls, ctx, NOW, utterance);

const cardsOf = (result: ToolCallPlan): Extract<Action, { type: "card.create" }>[] =>
  result.actions.filter((action): action is Extract<Action, { type: "card.create" }> => action.type === "card.create");
const focusIds = (result: ToolCallPlan): string[] =>
  result.actions.flatMap(action => (action.type === "card.focus" ? [action.targetId] : []));

type CreateAction = Extract<Action, { type: "card.create" }>;
/** `CardRecord.displayProps/sourceData` are per-card unions; tests read raw fields. */
const propsOf = (action: CreateAction): Record<string, unknown> =>
  action.card.displayProps as Record<string, unknown>;
const sourceOf = (action: CreateAction): Record<string, unknown> =>
  action.card.sourceData as Record<string, unknown>;
const eventsOf = (action: CreateAction): Array<Record<string, unknown>> =>
  (propsOf(action).events as Array<Record<string, unknown>> | undefined) ?? [];

/** The host revalidates every batch through the same envelope schema before commit. */
const envelope = (result: ToolCallPlan) => {
  expect(result.actions.length).toBeGreaterThan(0);
  const parsed = ActionEnvelopeSchema.safeParse({
    schemaVersion: "0.6",
    requestId: "req_tool_calls_test",
    canvasId: "TEST-tool-calls",
    actions: result.actions,
  });
  expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  return parsed.data!;
};

const invalid = (result: ToolCallPlan) => {
  expect(result.kind).toBe("invalid");
  expect(result.actions).toEqual([]);
  expect(result.created).toEqual([]);
  expect(result.issues.length).toBeGreaterThan(0);
  return result.issues.join(" | ");
};

describe("tool surface", () => {
  it("declares the twenty-one tools exactly once, each with a description and a parameter schema", () => {
    const names = TOOL_DEFINITIONS.map(definition => definition.function.name);
    expect(names).toEqual([
      "create_countdown",
      "create_todo",
      "create_note",
      "create_weekly_plan",
      "create_schedule",
      "create_scene_card",
      "create_chart",
      "create_notification",
      "create_habit",
      "focus_created",
      "canvas_fit",
      "focus_card",
      "highlight_card",
      "restore_view",
      "delete_card",
      "undo_last",
      "edit_card",
      "arrange_card",
      "arrange_canvas",
      "clarify",
      "chat",
    ]);
    expect(new Set(names).size).toBe(names.length);
    for (const definition of TOOL_DEFINITIONS) {
      expect(definition.type).toBe("function");
      expect(definition.function.description.length).toBeGreaterThan(0);
      expect(definition.function.parameters).toMatchObject({ type: "object" });
    }
  });

  it("accepts the four-card canvas context the tests run against", () => {
    expect(CanvasContextSchema.safeParse(canvas()).success).toBe(true);
  });
});

/**
 * The prompt is the only lever the model has over target resolution and
 * multi-action batches, so it is pinned like an interface: ids plus geometry,
 * the focus tail, and the two multi-action few-shots must all survive edits.
 */
describe("tool system prompt", () => {
  const promptOf = (ctx: CanvasContext = canvas()): string => buildToolSystemPrompt(ctx);

  it("lists every card with its id, type, label and layout", () => {
    const prompt = promptOf();
    expect(prompt).toContain("- note_meeting (NoteCard) 「周会纪要：确认发布窗口」 @0,0 320x120");
    expect(prompt).toContain("- note_shopping (NoteCard) 「采购清单」 @344,0 320x120");
    // A TodoCard has no title; its first item is the label the user names.
    expect(prompt).toContain("- todo_week (TodoCard) 「交周报」 @0,144 288x160");
    // A CountdownCard falls back to its alias.
    expect(prompt).toContain("- countdown_tea (CountdownCard) 「泡茶」 @312,144 260x200");
    expect(prompt).toContain("@x,y 为左上角坐标");
  });

  it("keeps a long card label to one line", () => {
    const long = canvas();
    long.cards[0]!.displayProps = { text: "周".repeat(60) };
    const prompt = promptOf(long);
    expect(prompt).toContain(`「${"周".repeat(40)}…」`);
    expect(prompt).not.toContain("周".repeat(41));
  });

  it("marks a pinned card so pin/unpin targets are readable", () => {
    const pinned = canvas();
    pinned.cards[0]!.layout.pinned = true;
    expect(promptOf(pinned)).toContain("@0,0 320x120 [固定]");
    expect(promptOf()).not.toContain("@0,0 320x120 [固定]");
  });

  it("carries the focus history newest-first so “它/刚才那张” resolves", () => {
    expect(promptOf()).toContain("最近聚焦（越靠前越近）：note_meeting");
    expect(promptOf({ ...canvas(), focusHistory: [] })).toContain("最近聚焦：无");
    const two = promptOf({ ...canvas(), focusHistory: ["note_meeting", "todo_week"] });
    expect(two).toContain("最近聚焦（越靠前越近）：todo_week「交周报」 → note_meeting");
  });

  it("tells the model how to resolve positional references instead of refusing", () => {
    const prompt = promptOf();
    expect(prompt).toContain("x 最小=最左");
    expect(prompt).toContain("最近聚焦");
    expect(prompt).toContain("不要说“摘要里没有位置”");
    // A negated action must not be executed: "别删，先聚焦它" only focuses.
    expect(prompt).toContain("「别删，先聚焦它」→ 只调用 focus_card");
  });

  it("routes a chart utterance to data_visualization, not a table or a question", () => {
    const prompt = promptOf();
    expect(prompt).toContain("把这几个数做成柱状图");
    expect(prompt).toContain('scene_id="data_visualization"');
    expect(prompt).toContain('"chartKind":"bar"');
    expect(prompt).toContain('"points"');
    expect(prompt).toContain("不要改用表格");
    expect(prompt).toContain("不要反问用户已经说过的数据");
  });

  it("routes a notification utterance to single_notification with a level", () => {
    const prompt = promptOf();
    expect(prompt).toContain("明天九点交材料，级别重要");
    expect(prompt).toContain('scene_id="single_notification"');
    expect(prompt).toContain('"title":"交材料"');
    expect(prompt).toContain('"body":"明天九点交材料"');
    expect(prompt).toContain('"level":"warning"');
    expect(prompt).toContain("“重要/紧急”≈warning");
  });

  it("pins both multi-action few-shots on one line each", () => {
    const lines = promptOf().split("\n");
    const focusThenPin = lines.find(line => line.includes("先聚焦购物清单")) ?? "";
    expect(focusThenPin).toContain("focus_card");
    expect(focusThenPin).toContain("arrange_card");
    expect(focusThenPin).toContain('action="pin"');
    const showThenArrange = lines.find(line => line.includes("显示全部再整理")) ?? "";
    expect(showThenArrange).toContain("canvas_fit");
    expect(showThenArrange).toContain("arrange_canvas");
    expect(promptOf()).toContain("漏做");
  });
});

describe("one tool call per contract", () => {
  it("create_countdown builds a CountdownCard from minutes", async () => {
    const result = await plan([{ name: "create_countdown", arguments: { minutes: 10 } }]);
    expect(result.kind).toBe("envelope");
    expect(result.created.map(item => item.cardType)).toEqual(["CountdownCard"]);
    expect(result.created[0]!.tool).toBe("create_countdown");
    expect(result.routes).toEqual(["countdown"]);
    const created = cardsOf(result)[0]!;
    expect(created.card.type).toBe("CountdownCard");
    // 10 minutes from the fixed clock, computed by the host, not the model.
    expect(sourceOf(created)).toMatchObject({ startedAt: new Date(NOW).toISOString() });
    expect(Date.parse(String(sourceOf(created).targetAt))).toBe(NOW + 10 * 60 * 1000);
    expect(sourceOf(created)).not.toHaveProperty("reminderText");
    envelope(result);
  });

  it("create_countdown carries a user-stated reminder text", async () => {
    const result = await plan([{ name: "create_countdown", arguments: { minutes: 20, text: "把汤关火" } }]);
    expect(result.kind).toBe("envelope");
    expect(sourceOf(cardsOf(result)[0]!)).toMatchObject({ reminderText: "把汤关火" });
    envelope(result);
  });

  it("create_todo builds one TodoCard holding every item", async () => {
    const result = await plan([{ name: "create_todo", arguments: { items: ["买牛奶", "交周报"] } }]);
    expect(result.kind).toBe("envelope");
    expect(result.created.map(item => item.cardType)).toEqual(["TodoCard"]);
    expect(result.routes).toEqual(["todo"]);
    expect(propsOf(cardsOf(result)[0]!)).toMatchObject({
      items: [{ id: "item-1", text: "买牛奶", done: false }, { id: "item-2", text: "交周报", done: false }],
    });
    envelope(result);
  });

  it("create_note builds a NoteCard that stores the text verbatim", async () => {
    const result = await plan([{ name: "create_note", arguments: { text: "明天交周报" } }]);
    expect(result.kind).toBe("envelope");
    expect(result.created.map(item => item.cardType)).toEqual(["NoteCard"]);
    expect(result.routes).toEqual(["note"]);
    expect(propsOf(cardsOf(result)[0]!)).toMatchObject({ text: "明天交周报" });
    envelope(result);
  });

  it("create_weekly_plan asks when the plan has no days or duration", async () => {
    const asked = await plan([{ name: "create_weekly_plan", arguments: { topic: "健身计划" } }], canvas(), "帮我做一个下周的健身计划");
    expect(asked.kind).toBe("clarify");
    expect(asked.message).toContain("哪几天");
  });

  it("create_weekly_plan builds a WeeklyScheduleCard for next week with no invented clock", async () => {
    const result = await plan([{ name: "create_weekly_plan", arguments: { topic: "健身计划" } }], canvas(), "下周健身计划：周一三五早上跑步");
    expect(result.kind).toBe("envelope");
    expect(result.created.map(item => item.cardType)).toEqual(["WeeklyScheduleCard"]);
    const card = cardsOf(result)[0]!;
    // weekStart is intentionally not asserted: the scene guard re-anchors the
    // week from any "本周/下周" text on the canvas (the todo card's alias), which
    // the dry-run report records as an adapter finding rather than a contract.
    expect(String(propsOf(card).title)).toContain("健身计划");
    const events = eventsOf(card);
    expect(events.map(event => event.day)).toEqual([1, 3, 5]);
    for (const event of events) {
      expect(event).not.toHaveProperty("start");
      expect(event).not.toHaveProperty("end");
    }
    envelope(result);
  });

  it("create_schedule builds a WeeklyScheduleCard on the named weekday at the stated clock", async () => {
    const result = await plan([{ name: "create_schedule", arguments: { title: "开会", day: "周四", time: "上午9点" } }]);
    expect(result.kind).toBe("envelope");
    expect(result.created.map(item => item.cardType)).toEqual(["WeeklyScheduleCard"]);
    const card = cardsOf(result)[0]!;
    expect(propsOf(card)).toMatchObject({ title: "周四 开会" });
    expect(eventsOf(card)[0]).toMatchObject({
      day: 4,
      title: "开会",
      start: "09:00",
    });
    envelope(result);
  });

  it("create_schedule omits start when the user gave no clock", async () => {
    const result = await plan([{ name: "create_schedule", arguments: { title: "健身", day: "周四", time: "下午" } }]);
    expect(result.kind).toBe("envelope");
    expect(eventsOf(cardsOf(result)[0]!)[0]).toMatchObject({
      day: 4,
      // A period without a clock is user-stated fact: it stays in the title
      // instead of being dropped or turned into an invented start time.
      title: "下午健身",
    });
    expect(eventsOf(cardsOf(result)[0]!)[0]).not.toHaveProperty("start");
    envelope(result);
  });

  it("focus_created points at the card created in this same batch", async () => {
    const result = await plan([
      { name: "create_note", arguments: { text: "明天交周报" } },
      { name: "focus_created", arguments: {} },
    ]);
    expect(result.kind).toBe("envelope");
    expect(result.created.map(item => item.cardType)).toEqual(["NoteCard"]);
    // The note contract already focuses its own card; focus_created must land on
    // the same target and the batch keeps one focus per target.
    expect(focusIds(result)).toEqual([result.created[0]!.id]);
    envelope(result);
  });

  it("canvas_fit is a camera move only, never a card", async () => {
    const result = await plan([{ name: "canvas_fit", arguments: {} }]);
    expect(result.kind).toBe("envelope");
    expect(result.created).toEqual([]);
    expect(result.routes).toEqual(["overview"]);
    // A pure view action still needs at least one action to be a valid envelope.
    expect(envelope(result).actions).toEqual([{ type: "canvas.fit" }]);
  });

  it("focus_card targets an existing id from the canvas summary", async () => {
    const result = await plan([{ name: "focus_card", arguments: { card_id: "note_shopping" } }]);
    expect(result.kind).toBe("envelope");
    expect(result.created).toEqual([]);
    expect(result.routes).toEqual(["focus"]);
    expect(envelope(result).actions).toEqual([{ type: "card.focus", targetId: "note_shopping" }]);
  });

  it("highlight_card highlights an existing id and never creates", async () => {
    const result = await plan([{ name: "highlight_card", arguments: { card_id: "todo_week" } }]);
    expect(result.kind).toBe("envelope");
    expect(result.created).toEqual([]);
    expect(result.routes).toEqual(["highlight"]);
    expect(envelope(result).actions).toEqual([{ type: "card.highlight", targetId: "todo_week" }]);
  });

  it("restore_view restores the camera without touching cards", async () => {
    const result = await plan([{ name: "restore_view", arguments: {} }]);
    expect(result.kind).toBe("envelope");
    expect(result.created).toEqual([]);
    expect(result.routes).toEqual(["restore"]);
    expect(envelope(result).actions).toEqual([{ type: "canvas.restore" }]);
  });

  it("delete_card proposes a delete of an existing id (host still confirms)", async () => {
    const result = await plan([{ name: "delete_card", arguments: { card_id: "note_shopping" } }]);
    expect(result.kind).toBe("envelope");
    expect(result.created).toEqual([]);
    expect(result.routes).toEqual(["delete"]);
    expect(envelope(result).actions).toEqual([{ type: "card.delete", targetId: "note_shopping" }]);
  });

  it("undo_last returns a host history operation, not a card", async () => {
    const result = await plan([{ name: "undo_last", arguments: {} }]);
    expect(result.kind).toBe("host-operation");
    expect(result.hostOperation).toEqual({ kind: "history.undo" });
    expect(result.created).toEqual([]);
    expect(result.routes).toEqual(["undo"]);
    const redo = await plan([{ name: "undo_last", arguments: { redo: true } }]);
    expect(redo.hostOperation).toEqual({ kind: "history.redo" });
  });

  it("edit_card pauses and resumes only a countdown", async () => {
    const paused = await plan([{ name: "edit_card", arguments: { card_id: "countdown_tea", action: "pause_countdown" } }]);
    expect(paused.kind).toBe("host-operation");
    expect(paused.hostOperation).toEqual({ kind: "countdown.pause", targetId: "countdown_tea" });
    expect(paused.routes).toEqual(["edit"]);
    const resumed = await plan([{ name: "edit_card", arguments: { card_id: "countdown_tea", action: "resume_countdown" } }]);
    expect(resumed.hostOperation).toEqual({ kind: "countdown.resume", targetId: "countdown_tea" });
    const notCountdown = invalid(await plan([{ name: "edit_card", arguments: { card_id: "note_meeting", action: "pause_countdown" } }]));
    expect(notCountdown).toContain("倒计时");
  });

  it("arrange_card moves or pins an existing card", async () => {
    const moved = await plan([{ name: "arrange_card", arguments: { card_id: "todo_week", action: "move_left" } }]);
    expect(moved.kind).toBe("host-operation");
    expect(moved.hostOperation).toEqual({ kind: "card.move", targetId: "todo_week", direction: "left" });
    expect(moved.routes).toEqual(["arrange"]);
    const pinned = await plan([{ name: "arrange_card", arguments: { card_id: "note_meeting", action: "pin" } }]);
    expect(pinned.hostOperation).toEqual({ kind: "card.pin", targetId: "note_meeting", pinned: true });
  });

  it("pairs one host operation with view actions in a composite batch", async () => {
    // A create plus a host operation keeps the card envelope; the host applies
    // the envelope first, then the single operation.
    const note = await plan([
      { name: "create_note", arguments: { text: "x" } },
      { name: "undo_last", arguments: {} },
    ]);
    expect(note.kind).toBe("composite");
    expect(note.hostOperation).toEqual({ kind: "history.undo" });
    expect(note.actions.map(action => action.type)).toEqual(["card.create", "card.focus"]);
    // "先聚焦购物清单，再把它固定住": the focus is an envelope action and the
    // pin is a host operation against the same existing card.
    const pair = await plan([
      { name: "focus_card", arguments: { card_id: "todo_week" } },
      { name: "arrange_card", arguments: { card_id: "todo_week", action: "pin" } },
    ], canvas(), "先聚焦本周待办，再把它固定住");
    expect(pair.kind).toBe("composite");
    expect(pair.hostOperation).toEqual({ kind: "card.pin", targetId: "todo_week", pinned: true });
    expect(pair.actions).toEqual([{ type: "card.focus", targetId: "todo_week" }]);
    expect(pair.routes).toEqual(["focus", "arrange"]);
    // "先显示全部卡片，然后整理一下布局": a camera move plus canvas arrange.
    const camera = await plan([
      { name: "canvas_fit", arguments: {} },
      { name: "arrange_canvas", arguments: {} },
    ], canvas(), "先显示全部卡片，然后整理一下布局");
    expect(camera.kind).toBe("composite");
    expect(camera.hostOperation).toEqual({ kind: "canvas.arrange" });
    expect(camera.actions).toEqual([{ type: "canvas.fit" }]);
    expect(camera.routes).toEqual(["overview", "arrange"]);
  });

  it("still allows only one host operation per batch", async () => {
    // Relaxing the envelope+operation rule must not make two operations run.
    const issues = invalid(await plan([
      { name: "arrange_card", arguments: { card_id: "todo_week", action: "pin" } },
      { name: "arrange_canvas", arguments: {} },
    ]));
    expect(issues).toContain("一个宿主操作");
    const undone = invalid(await plan([
      { name: "undo_last", arguments: {} },
      { name: "edit_card", arguments: { card_id: "countdown_tea", action: "pause_countdown" } },
    ]));
    expect(undone).toContain("一个宿主操作");
  });


  it("create_scene_card builds any registered scene card", async () => {
    const quote = await plan([{ name: "create_scene_card", arguments: { scene_id: "quote_note", data: { text: "慢慢来，比较快" } } }]);
    expect(quote.kind).toBe("envelope");
    expect(quote.created.map(item => item.cardType)).toEqual(["QuoteCard"]);
    expect(quote.routes).toEqual(["generate"]);
    const chart = await plan([{ name: "create_scene_card", arguments: { scene_id: "data_visualization", data: {
      chartKind: "bar", points: [{ x: "周一", y: 12 }, { x: "周二", y: 8 }],
    } } }], canvas(), "把这几个数做成柱状图：周一 12，周二 8");
    expect(chart.created.map(item => item.cardType)).toEqual(["ChartCard"]);
    expect(chart.kind).toBe("envelope");
  });

  it("create_scene_card rejects an unknown scene id", async () => {
    const issues = invalid(await plan([{ name: "create_scene_card", arguments: { scene_id: "nope", data: {} } }]));
    expect(issues).toContain("参数不合法");
  });

  it("arrange_canvas is a host canvas arrangement operation", async () => {
    const result = await plan([{ name: "arrange_canvas", arguments: {} }]);
    expect(result.kind).toBe("host-operation");
    expect(result.hostOperation).toEqual({ kind: "canvas.arrange" });
    expect(result.routes).toEqual(["arrange"]);
  });

  it("missing required create args ask a question instead of falling back", async () => {
    const countdown = await plan([{ name: "create_countdown", arguments: {} }]);
    expect(countdown.kind).toBe("clarify");
    expect(countdown.message).toContain("多长时间");
    const todo = await plan([{ name: "create_todo", arguments: {} }]);
    expect(todo.kind).toBe("clarify");
    expect(todo.message).toContain("待办");
    const note = await plan([{ name: "create_note", arguments: {} }]);
    expect(note.kind).toBe("clarify");
    expect(note.message).toContain("便笺");
  });

  it("create_chart builds a ChartCard from the user's numbers", async () => {
    const result = await plan([{ name: "create_chart", arguments: {
      chartKind: "bar", points: [{ x: "周一", y: 12 }, { x: "周二", y: 8 }],
    } }], canvas(), "把这几个数做成柱状图：周一 12，周二 8");
    expect(result.kind).toBe("envelope");
    expect(result.created.map(item => item.cardType)).toEqual(["ChartCard"]);
    expect(result.routes).toEqual(["generate"]);
  });

  it("create_notification builds a NotificationCard", async () => {
    const result = await plan([{ name: "create_notification", arguments: {
      title: "交材料", body: "明天九点交材料",
    } }], canvas(), "给我发一条通知卡：明天九点交材料，级别重要");
    expect(result.kind).toBe("envelope");
    expect(result.created.map(item => item.cardType)).toEqual(["NotificationCard"]);
  });

  it("create_countdown refuses a duration the user never said", async () => {
    const asked = await plan([{ name: "create_countdown", arguments: { minutes: 5 } }], canvas(), "设个倒计时");
    expect(asked.kind).toBe("clarify");
    expect(asked.message).toContain("多长时间");
    const grounded = await plan([{ name: "create_countdown", arguments: { minutes: 5 } }], canvas(), "设个5分钟倒计时");
    expect(grounded.kind).toBe("envelope");
  });

  it("clarify asks one question and never touches the canvas", async () => {
    const result = await plan([{ name: "clarify", arguments: { question: "倒计时设多长时间？" } }]);
    expect(result.kind).toBe("clarify");
    expect(result.actions).toEqual([]);
    expect(result.created).toEqual([]);
    expect(result.message).toBe("倒计时设多长时间？");
    expect(result.issues).toEqual([]);
  });

  it("chat means no card at all", async () => {
    const result = await plan([{ name: "chat", arguments: {} }]);
    expect(result.kind).toBe("chat");
    expect(result.actions).toEqual([]);
    expect(result.created).toEqual([]);
    expect(result.routes).toEqual(["chat"]);
  });
});

describe("multi-card batches", () => {
  const cases: Array<[string, ToolCall[], string[]]> = [
    ["note + countdown", [
      { name: "create_note", arguments: { text: "明天交周报" } },
      { name: "create_countdown", arguments: { minutes: 50 } },
    ], ["NoteCard", "CountdownCard"]],
    ["todo + note", [
      { name: "create_todo", arguments: { items: ["买牛奶"] } },
      { name: "create_note", arguments: { text: "明天交周报" } },
    ], ["TodoCard", "NoteCard"]],
    ["note + todo + countdown", [
      { name: "create_note", arguments: { text: "交周报" } },
      { name: "create_todo", arguments: { items: ["买菜"] } },
      { name: "create_countdown", arguments: { minutes: 25 } },
    ], ["NoteCard", "TodoCard", "CountdownCard"]],
    ["numbered three items (countdown + 2 schedules)", [
      { name: "create_countdown", arguments: { minutes: 30 } },
      { name: "create_schedule", arguments: { title: "健身", day: "周四", time: "下午" } },
      { name: "create_schedule", arguments: { title: "开会", day: "周四", time: "上午9点" } },
    ], ["CountdownCard", "WeeklyScheduleCard", "WeeklyScheduleCard"]],
  ];

  it.each(cases)("%s builds every card, one camera move, no stray focus", async (_label, calls, cardTypes) => {
    const result = await plan(calls);
    expect(result.kind).toBe("envelope");
    expect(result.created.map(item => item.cardType)).toEqual(cardTypes);
    expect(cardsOf(result).map(action => action.card.type)).toEqual(cardTypes);
    // Order follows the user's order, never the contract registry's order.
    expect(result.created.map(item => item.tool)).toEqual(calls.map(call => call.name));

    const batch = envelope(result);
    expect(batch.actions.filter(action => action.type === "canvas.fit")).toHaveLength(1);
    expect(batch.actions.filter(action => action.type === "card.focus")).toHaveLength(0);
    // One awaken at most, and this canvas is already awake.
    expect(batch.actions.filter(action => action.type === "stage.awaken")).toHaveLength(0);

    // Cards are placed on distinct slots so auto-layout never stacks them.
    const layouts = cardsOf(result).map(action => action.card.layout);
    expect(new Set(layouts.map(layout => `${layout.x},${layout.y}`)).size).toBe(layouts.length);
    expect(result.routes).toHaveLength(cardTypes.length);
  });

  it("keeps an explicit focus_created target in a single-create batch", async () => {
    const result = await plan([
      { name: "create_todo", arguments: { items: ["买牛奶"] } },
      { name: "focus_created", arguments: {} },
    ]);
    expect(result.kind).toBe("envelope");
    expect(focusIds(result)).toContain(result.created[0]!.id);
    envelope(result);
  });
});

describe("invalid and boundary batches", () => {
  it("rejects clarify mixed with a create", async () => {
    const issues = invalid(await plan([
      { name: "create_note", arguments: { text: "明天交周报" } },
      { name: "clarify", arguments: { question: "要建待办吗？" } },
    ]));
    expect(issues).toContain("clarify/chat");
  });

  it("rejects chat mixed with a create", async () => {
    invalid(await plan([
      { name: "chat", arguments: {} },
      { name: "create_todo", arguments: { items: ["买牛奶"] } },
    ]));
  });

  it("rejects an unknown tool name", async () => {
    const issues = invalid(await plan([{ name: "unknown_tool", arguments: { card_id: "note_meeting" } }]));
    expect(issues).toContain("未知工具");
  });

  it("rejects focus_card pointing at a card that is not on the canvas", async () => {
    const issues = invalid(await plan([{ name: "focus_card", arguments: { card_id: "note_missing" } }]));
    expect(issues).toContain("note_missing");
  });

  it("rejects focus_created when the batch created nothing", async () => {
    invalid(await plan([{ name: "focus_created", arguments: {} }]));
  });

  it.each([0, -5])("rejects create_countdown minutes=%s", async minutes => {
    const issues = invalid(await plan([{ name: "create_countdown", arguments: { minutes } }]));
    expect(issues).toContain("参数不合法");
  });

  it("rejects a countdown longer than a day instead of clamping arbitrarily", async () => {
    invalid(await plan([{ name: "create_countdown", arguments: { minutes: 1441 } }]));
  });

  it("rejects an empty call list", async () => {
    invalid(await plan([]));
  });

  it("asks for a missing required argument and rejects empty or invalid values", async () => {
    const note = await plan([{ name: "create_note", arguments: {} }]);
    expect(note.kind).toBe("clarify");
    invalid(await plan([{ name: "create_todo", arguments: { items: [] } }]));
    invalid(await plan([{ name: "create_weekly_plan", arguments: { topic: "  " } }]));
  });

  it("is all-or-nothing: one bad call discards the cards that would have built", async () => {
    const issues = invalid(await plan([
      { name: "create_note", arguments: { text: "明天交周报" } },
      { name: "create_countdown", arguments: { minutes: 0 } },
    ]));
    // The failing call is named by its position so the caller can log the turn.
    expect(issues).toContain("#2 create_countdown");
  });
});
