import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ActionSchema, CardRecordSchema, HostOperationSchema, type Action, type CardRecord } from "@vivic/contracts";
import { CARD_CONTRACTS, getCardContract } from "../src/cards/index.js";
import type { CardBuildContext } from "../src/cards/types.js";
import { actionExecutionIssue } from "../src/intent/validation.js";

const now = new Date("2026-10-29T02:00:00.000Z");
const context = (cards: CardBuildContext["cards"] = []): CardBuildContext => ({
  canvasId: "TEST-canvas", stage: "WORKSPACE", viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], cards,
});
const samples = {
  countdown: { seconds: 90, text: "TEST 喝水" },
  todo: { title: "TEST 本周待办", items: ["TEST 买牛奶", "TEST 交周报"] },
  note: { text: "TEST 明天交周报\n请保留第二行和末尾标点。" },
  answer: { headline: "TEST 光合作用", summary: "TEST 植物将光能转化为化学能。", keyPoints: ["TEST 利用光能", "TEST 生成有机物"] },
  overview: {}, restore: {}, focus: {}, highlight: {}, undo: {},
};
type ContractId = keyof typeof samples;

async function actionsFor(id: ContractId, slots: unknown, ctx = context()): Promise<Action[]> {
  const output = await getCardContract(id)!.build(slots, ctx, now);
  if (!Array.isArray(output)) throw new Error("Expected actions");
  for (const action of output) expect(ActionSchema.safeParse(action).success).toBe(true);
  return output;
}

function createdCard(actions: Action[]): CardRecord {
  const create = actions.find(action => action.type === "card.create");
  if (!create || create.type !== "card.create") throw new Error("Expected card creation");
  return CardRecordSchema.parse(create.card);
}

const targetContext = (): CardBuildContext => ({ ...context([{
  id: "TEST-todo", type: "TodoCard", displayProps: { items: [{ id: "TEST-item", text: "TEST 买牛奶", done: false }] },
  sourceDataSummary: {}, layout: { x: 0, y: 0, width: 288, height: 160, pinned: true },
}]), targetId: "TEST-todo", itemId: "TEST-item" });

describe("builtin card contract registry and slot boundaries", () => {
  it("exposes the assigned contracts and ignores inherited properties", () => {
    expect(Object.keys(CARD_CONTRACTS)).toEqual(expect.arrayContaining(Object.keys(samples)));
    expect(Object.isFrozen(CARD_CONTRACTS)).toBe(true);
    for (const [id, contract] of Object.entries(CARD_CONTRACTS)) {
      expect(getCardContract(id)).toBe(contract);
      expect(contract.id).toBe(id);
      expect(contract.examples.length).toBeGreaterThan(0);
      expect(contract.description.length).toBeGreaterThan(0);
    }
    for (const id of ["missing", "toString", "constructor", "__proto__"]) {
      expect(getCardContract(id)).toBeUndefined();
    }
  });

  it.each(Object.keys(samples) as ContractId[])("%s rejects record fields and host selections in model slots", async id => {
    const contract = getCardContract(id)!;
    expect(contract.slots.safeParse(samples[id]).success).toBe(true);
    for (const field of ["id", "type", "displayProps", "sourceData", "sources", "layout", "metadata", "createdAt", "updatedAt", "targetId", "itemId", "trustedImageRef"]) {
      const injected = { ...samples[id], [field]: "TEST-model-value" };
      expect(contract.slots.safeParse(injected).success, `${id}.${field}`).toBe(false);
      await expect(Promise.resolve().then(() => contract.build(injected, targetContext(), now))).rejects.toThrow();
    }
    const record = createdCard(await actionsFor("note", samples.note));
    expect(contract.slots.safeParse(record).success).toBe(false);
    const jsonSchema = z.toJSONSchema(contract.slots);
    expect(JSON.stringify(jsonSchema)).toContain('"additionalProperties":false');
  });

  it.each([
    ["countdown", { seconds: 0 }], ["countdown", { seconds: 86_401 }], ["countdown", { seconds: 1.5 }],
    ["countdown", { seconds: 1, text: 42 }], ["countdown", { seconds: 1, text: "长".repeat(161) }],
    ["todo", { items: [] }], ["todo", { items: Array(31).fill("TEST item") }],
    ["todo", { items: [" "] }], ["todo", { title: "长".repeat(81), items: ["TEST"] }],
    ["todo", { items: [{ id: "injected", text: "TEST", done: true }] }],
    ["note", {}], ["note", { text: " " }], ["note", { text: "长".repeat(501) }],
    ["note", { bullets: [] }], ["note", { bullets: Array(6).fill("TEST") }],
    ["note", { bullets: ["长".repeat(181)] }], ["note", { text: "TEST", bullets: ["TEST"] }],
    ["answer", { headline: "", summary: "TEST" }],
    ["answer", { ...samples.answer, keyPoints: Array(6).fill("TEST") }],
    ["answer", { ...samples.answer, summaryBy: "source" }],
    ["answer", { ...samples.answer, url: "http://example.test/article" }],
    ["answer", { ...samples.answer, url: "javascript:alert(1)" }],
  ] as Array<[ContractId, unknown]>)("%s refuses invalid slot data %j", (id, slots) => {
    expect(getCardContract(id)!.slots.safeParse(slots).success).toBe(false);
  });
});

describe("deterministic extraction preserves all literal content", () => {
  it.each([
    ["倒计时五十分钟", { seconds: 3000 }],
    ["设一个1小时20分钟30秒倒计时", { seconds: 4830 }],
    ["创建半小时倒计时", { seconds: 1800 }],
    ["倒计时1秒", { seconds: 1 }],
    ["十分钟后提醒我喝水", { seconds: 600, text: "喝水" }],
    ["请提醒我5分钟后交周报", { seconds: 300, text: "交周报" }],
  ])("extracts countdown %s", (text, expected) => {
    expect(getCardContract("countdown")!.parse!(text as string, context())).toEqual(expected);
  });

  it.each([
    "十分钟后提醒我喝水、伸展", "十分钟后提醒我喝水，二十分钟后提醒我开会",
    "倒计时5分钟然后显示全部", "创建5分钟和10分钟倒计时", "倒计时5分钟，添加待办买牛奶",
    "每天十分钟后提醒我喝水", "不要倒计时5分钟", "倒计时5分钟5分钟", "倒计时0秒", "倒计时25小时",
  ])("defers the entire unsupported reminder rather than losing content: %s", text => {
    expect(getCardContract("countdown")!.parse!(text, context())).toBeNull();
  });

  it.each([
    ["添加待办：买牛奶；交周报，订车票、取快递\n打电话", ["买牛奶", "交周报", "订车票", "取快递", "打电话"]],
    ["待办：第一行\r\n第二行", ["第一行", "第二行"]],
    ["列下待办 买牛奶", ["买牛奶"]],
    ["新建待办：明天复盘", ["明天复盘"]],
  ])("extracts the full todo list %s", (text, items) => {
    expect(getCardContract("todo")!.parse!(text as string, context())).toEqual({ items });
  });

  it("retains thirty todos and defers over-limit lists without slicing", () => {
    const items = Array.from({ length: 30 }, (_, index) => `TEST 第${index + 1}项`);
    expect(getCardContract("todo")!.parse!(`待办：${items.join("\n")}`, context())).toEqual({ items });
    expect(getCardContract("todo")!.parse!(`待办：${[...items, "TEST 多余项"].join("\n")}`, context())).toBeNull();
  });

  it.each(["添加待办：", "待办：；，", "待办：买牛奶，然后提醒我开会", "添加待办：买牛奶；再聚焦这张卡", `待办：${"长".repeat(161)}`])(
    "defers invalid or mixed todo instructions: %s", text => {
      expect(getCardContract("todo")!.parse!(text, context())).toBeNull();
    });

  it.each([
    ["记一下明天交周报。", "明天交周报。"],
    ["记下来：第一行，带逗号；也带分号。\n第二行保留：冒号！", "第一行，带逗号；也带分号。\n第二行保留：冒号！"],
    ["便签：明天交周报", "明天交周报"],
    ["请帮我新建一张便笺，内容是：周五下午复盘。\n不要遗漏末行", "周五下午复盘。\n不要遗漏末行"],
    ["创建笔记: 第一段\r\n第二段", "第一段\r\n第二段"],
    ["帮我记个便签明天交周报", "明天交周报"],
    ["新建便笺，内容是内容是完整的原文", "内容是完整的原文"],
  ])("extracts the entire note %s", (text, body) => {
    expect(getCardContract("note")!.parse!(text, context())).toEqual({ text: body });
  });

  it.each(["记一下", "便签：", "新建便笺，内容是", "创建便笺：", `记一下${"长".repeat(501)}`, "帮我解释光合作用"]) (
    "defers an empty, oversized or non-note request: %s", text => {
      expect(getCardContract("note")!.parse!(text, context())).toBeNull();
    });
});

describe("host-generated cards pass the real persistence and execution schemas", () => {
  it.each(["countdown", "todo", "note", "answer"] as const)("builds a valid %s with program IDs and the supplied clock", async id => {
    const ctx = { ...context(), stage: "STANDBY" as const };
    const first = await actionsFor(id, samples[id], ctx);
    const card = createdCard(first);
    expect(card.type).toBe(getCardContract(id)!.cardType);
    expect(card.metadata).toEqual({ createdAt: now.toISOString(), updatedAt: now.toISOString() });
    expect(card.layout.pinned).toBe(false);
    expect(first[0]).toEqual({ type: "stage.awaken" });
    expect(first.at(-1)).toEqual({ type: "card.focus", targetId: card.id });
    expect(createdCard(await actionsFor(id, samples[id], ctx)).id).not.toBe(card.id);
    // NewsCard is accepted as a program-built card by the existing validator.
    expect(actionExecutionIssue(first, ctx, new Set([card.id]))).toBeNull();
  });

  it("calculates reminder fields from seconds and host time without inventing scheduler state", async () => {
    const card = createdCard(await actionsFor("countdown", samples.countdown));
    expect(card.sourceData).toEqual({
      targetAt: "2026-10-29T02:01:30.000Z", startedAt: now.toISOString(), reminderText: "TEST 喝水",
    });
    expect(card.displayProps).toEqual({});
    const timer = createdCard(await actionsFor("countdown", { seconds: 1 }));
    expect(timer.sourceData).toEqual({ targetAt: "2026-10-29T02:00:01.000Z", startedAt: now.toISOString() });
  });

  it("sets todo item IDs and initial completion state in code", async () => {
    const card = createdCard(await actionsFor("todo", samples.todo));
    expect(card.displayProps).toEqual({ title: samples.todo.title, items: [
      { id: "item-1", text: samples.todo.items[0], done: false },
      { id: "item-2", text: samples.todo.items[1], done: false },
    ] });
  });

  it("builds text and bullet notes without truncating or joining their content", async () => {
    expect(createdCard(await actionsFor("note", samples.note)).displayProps).toEqual(samples.note);
    const bullets = ["TEST 第一条", "TEST 第二条\n内部换行"];
    expect(createdCard(await actionsFor("note", { bullets })).displayProps).toEqual({ bullets });
  });

  it("builds knowledge answers without an article, using NewsCard and an honest AI attribution", async () => {
    const contract = getCardContract("answer")!;
    expect(contract.parse).toBeUndefined();
    const withoutUrl = createdCard(await actionsFor("answer", { ...samples.answer, keyPoints: [] }));
    expect(withoutUrl.type).toBe("NewsCard");
    expect(withoutUrl.displayProps).toEqual({ ...samples.answer, keyPoints: [], summaryBy: "ai" });
    expect(withoutUrl.sources).toEqual([]);
    const withUrl = createdCard(await actionsFor("answer", { ...samples.answer, url: "https://example.test/article" }));
    expect(withUrl.displayProps).toEqual({ ...samples.answer, url: "https://example.test/article", summaryBy: "ai" });
    expect(withUrl.sources).toEqual([]);
    expect(withUrl.sourceData).toEqual({ contract: "answer" });
  });

  it("allows an answer to omit optional keyPoints", async () => {
    const slots = { headline: samples.answer.headline, summary: samples.answer.summary };
    expect(getCardContract("answer")!.slots.safeParse(slots).success).toBe(true);
    const card = createdCard(await actionsFor("answer", slots));
    expect(card.displayProps).toEqual({ ...slots, summaryBy: "ai" });
  });

  it.each(["countdown", "todo", "note", "answer"] as const)("places a new %s clear of fixed and newly created cards", async id => {
    const ctx = context([
      { id: "TEST-pinned", type: "NoteCard", displayProps: { text: "TEST fixed" }, sourceDataSummary: {},
        layout: { x: -40, y: -20, width: 900, height: 700, pinned: true } },
      { id: "TEST-next", type: "TodoCard", displayProps: { items: [] }, sourceDataSummary: {},
        layout: { x: 880, y: 0, width: 400, height: 200, pinned: false } },
    ]);
    const before = structuredClone(ctx);
    const firstActions = await actionsFor(id, samples[id], ctx);
    const first = createdCard(firstActions);
    expect(ctx).toEqual(before);
    expect(firstActions.every(action => ["card.create", "card.focus"].includes(action.type))).toBe(true);
    expect(first.layout.x).toBeGreaterThanOrEqual(1280);
    ctx.cards.push({ id: first.id, type: first.type, displayProps: first.displayProps, sourceDataSummary: first.sourceData, layout: first.layout });
    const second = createdCard(await actionsFor(id, samples[id], ctx));
    expect(second.layout.x).toBeGreaterThanOrEqual(first.layout.x + first.layout.width);
    expect(ctx.cards.slice(0, 2)).toEqual(before.cards);
  });

  it("avoids a fixed card whose older context omits its dimensions", async () => {
    const ctx = context([{ id: "TEST-legacy", type: "NoteCard", displayProps: { text: "TEST" },
      sourceDataSummary: {}, layout: { x: 0, y: 0, pinned: true } }]);
    const card = createdCard(await actionsFor("note", samples.note, ctx));
    expect(card.layout.x).toBeGreaterThanOrEqual(640);
  });
});

describe("view contracts use only trusted host targets", () => {
  it.each([["overview", "canvas.fit"], ["restore", "canvas.restore"]] as const)("%s uses an Action without touching layout", async (id, type) => {
    const ctx = { ...targetContext(), stage: "STANDBY" as const };
    const before = structuredClone(ctx);
    expect(await actionsFor(id, {}, ctx)).toEqual([{ type: "stage.awaken" }, { type }]);
    expect(ctx).toEqual(before);
  });

  it("focuses the host target and highlights only the host-selected item", async () => {
    const ctx = targetContext();
    const before = structuredClone(ctx);
    const focus = await actionsFor("focus", {}, ctx);
    const highlight = await actionsFor("highlight", {}, ctx);
    expect(focus).toEqual([{ type: "card.focus", targetId: "TEST-todo" }]);
    expect(highlight).toEqual([{ type: "card.highlight", targetId: "TEST-todo", itemId: "TEST-item" }]);
    expect(actionExecutionIssue([...focus, ...highlight], ctx)).toBeNull();
    delete ctx.itemId;
    expect(await actionsFor("highlight", {}, ctx)).toEqual([{ type: "card.highlight", targetId: "TEST-todo" }]);
    expect({ ...ctx, itemId: before.itemId }).toEqual(before);
  });

  it.each(["focus", "highlight"] as const)("%s refuses a missing host target instead of falling back to history", async id => {
    const ctx = targetContext();
    ctx.focusHistory = ["TEST-todo"];
    delete ctx.targetId;
    await expect(actionsFor(id, {}, ctx)).rejects.toThrow("目标卡片");
    await expect(actionsFor(id, {}, { ...ctx, targetId: "TEST-missing" })).rejects.toThrow("目标卡片");
  });

  it("refuses nonexistent or unsupported item highlights", async () => {
    await expect(actionsFor("highlight", {}, { ...targetContext(), itemId: "TEST-missing" })).rejects.toThrow("目标条目");
    const ctx = targetContext();
    ctx.cards[0]!.type = "NoteCard";
    await expect(actionsFor("highlight", {}, ctx)).rejects.toThrow("尚不支持");
  });

  it("delegates undo to the host operation schema", async () => {
    const output = await getCardContract("undo")!.build({}, context(), now);
    expect(output).toEqual({ hostOperation: { kind: "history.undo" } });
    if (Array.isArray(output)) throw new Error("Expected host operation");
    expect(HostOperationSchema.parse(output.hostOperation)).toEqual({ kind: "history.undo" });
  });
});
