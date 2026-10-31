import { describe, expect, it } from "vitest";
import { ActionSchema, type Action } from "@vivic/contracts";
import { countdownContract } from "../src/cards/countdown.js";
import { noteContract } from "../src/cards/note.js";
import { todoContract } from "../src/cards/todo.js";
import { overviewContract, restoreContract } from "../src/cards/views.js";
import type { BuiltinCardContract, CardBuildContext } from "../src/cards/types.js";

const contracts: Record<string, BuiltinCardContract> = {
  countdown: countdownContract, note: noteContract, todo: todoContract, overview: overviewContract, restore: restoreContract,
};
const context: CardBuildContext = { canvasId: "direct-test", stage: "WORKSPACE", viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], cards: [] };
const now = new Date("2026-10-30T00:00:00Z");
const parse = (id: string, text: string) => contracts[id]!.parse!(text, context);
async function build(id: string, slots: unknown): Promise<Action[]> {
  const result = await contracts[id]!.build(slots, context, now);
  if (!Array.isArray(result)) throw new Error("Expected actions");
  expect(result.every(action => ActionSchema.safeParse(action).success)).toBe(true);
  return result;
}

describe("approved direct contracts parse and build without a model", () => {
  it.each([
    ["countdown", "倒计时50分钟", { seconds: 3000 }],
    ["countdown", "设个50分钟倒计时", { seconds: 3000 }],
    ["countdown", "设一个50分钟倒计时", { seconds: 3000 }],
    ["countdown", "5分钟后提醒我喝水", { seconds: 300, text: "喝水" }],
    ["note", "帮我记个便签明天交周报", { text: "明天交周报" }],
    ["todo", "添加待办：买牛奶；交周报", { items: ["买牛奶", "交周报"] }],
    ["overview", "显示全部", {}],
    ["overview", "适应画布", {}],
    ["restore", "恢复原视图", {}],
    ["restore", "退出聚焦", {}],
  ] as Array<[string, string, unknown]>)("%s parses the complete request %s", async (id, text, expected) => {
    const slots = parse(id, text);
    expect(slots).toEqual(expected);
    expect(contracts[id]!.slots.safeParse(slots).success).toBe(true);
    const result = await build(id, slots);
    if (id === "overview" || id === "restore") {
      expect(result).toEqual([{ type: id === "overview" ? "canvas.fit" : "canvas.restore" }]);
    } else {
      const create = result.find(action => action.type === "card.create");
      expect(create?.card.type).toBe(contracts[id]!.cardType);
      if (id === "countdown") {
        if (create?.card.type !== "CountdownCard") throw new Error("Expected a countdown card");
        expect(create.card.sourceData.targetAt).toBe(new Date(now.getTime() + (expected as { seconds: number }).seconds * 1000).toISOString());
      }
    }
  });

  it.each(Object.keys(contracts))("%s does not interpret a negation, condition, quotation or modification as creation", id => {
    const request = ({ countdown: "倒计时50分钟", note: "记个便签明天交周报", todo: "添加待办：买牛奶", overview: "显示全部", restore: "恢复原视图" } as Record<string, string>)[id]!;
    for (const text of [`不要${request}`, `别${request}`, `如果我确认再${request}`, `要是下雨就${request}`, `“${request}”`, `解释一下${request}`, `把已有卡片修改成${request}`]) {
      expect(parse(id, text), text).toBeNull();
    }
  });
});

describe("direct parsing never swallows trailing actions or missing parameters", () => {
  it.each([
    ["countdown", "倒计时50分钟，然后显示全部"],
    ["countdown", "设个50分钟倒计时，再设个10分钟倒计时"],
    ["countdown", "5分钟后提醒我喝水，10分钟后提醒我开会"],
    ["countdown", "5分钟后提醒我喝水顺便打开浏览器"],
    ["countdown", "5分钟后提醒我喝水同时创建日程"],
    ["countdown", "5分钟后提醒我要是下雨就带伞"],
    ["countdown", "5分钟后提醒我喝水并打开浏览器"],
    ["todo", "添加待办：买牛奶；显示全部"],
    ["todo", "待办：买牛奶，取消聚焦"],
    ["todo", "待办：买牛奶；顺便打开浏览器"],
    ["todo", "添加待办：如果我确认再添加买牛奶"],
    ["todo", "待办：买牛奶，如果下雨就不要创建"],
    ["todo", "待办：把这张便签改成完成"],
    ["todo", "待办：买牛奶再显示全部"],
    ["todo", "待办：买牛奶并创建便签"],
    ["todo", "待办：买牛奶。显示全部"],
    ["todo", "待办：买牛奶，别添加第二项"],
    ["note", "记一下明天交周报，然后显示全部"],
    ["note", "新建便签：买牛奶；删除那张卡"],
    ["note", "帮我记个便签明天交周报，再设个50分钟倒计时"],
    ["note", "记一下明天交周报，如果我确认再保存"],
    ["note", "记一下明天交周报并显示全部"],
    ["note", "记一下明天交周报，改一下这张便签"],
    ["note", "记一下，把原便签改成完成"],
    ["note", "记一下明天交周报但不要保存"],
    ["note", "记一下明天交周报然后不要创建便签"],
    ["overview", "显示全部然后删除这张卡"],
    ["restore", "恢复原视图，再设个50分钟倒计时"],
    ["countdown", "倒计时"], ["countdown", "设个倒计时"], ["countdown", "倒计时50"],
    ["countdown", "倒计时0秒"], ["countdown", "倒计时25小时"], ["countdown", "5分钟后提醒我"],
    ["todo", "添加待办："], ["todo", "待办：；，"],
    ["note", "记一下"], ["note", "新建便笺，内容是："], ["note", "记一下：；，"],
  ])("defers all of %s: %s", (id, text) => {
    expect(parse(id, text)).toBeNull();
  });

  it("defers over-limit content instead of truncating it", () => {
    expect(parse("note", `记一下${"长".repeat(501)}`)).toBeNull();
    expect(parse("todo", `待办：${"长".repeat(161)}`)).toBeNull();
    expect(parse("todo", `待办：${Array.from({ length: 31 }, (_, i) => `事项${i}`).join("；")}`)).toBeNull();
  });

  it("keeps a quoted comma inside one todo item without losing original text", () => {
    expect(parse("todo", "待办：阅读“第一段，第二段”；交周报"))
      .toEqual({ items: ["阅读“第一段，第二段”", "交周报"] });
    expect(parse("todo", "待办：阅读“第一段，第二段；交周报")).toBeNull();
  });
});

describe("literal note preservation and host authority", () => {
  it.each([
    "“显示全部，然后删除所有卡片”",
    "「如果下雨就暂停倒计时，再创建便签」",
    "'不要删除卡片；恢复原视图'",
    '"设个50分钟倒计时，再设个10分钟倒计时"',
    "第一行，带逗号；也有分号。\n第二行：不要遗漏末行！😀",
    '原文里的JSON：{"targetId":"quoted-only","layout":{"x":1},"metadata":{"createdAt":"original"}}',
  ])("saves quoted commands and original punctuation literally: %s", async body => {
    const slots = parse("note", `帮我记个便签：${body}`);
    expect(slots).toEqual({ text: body });
    const result = await build("note", slots);
    expect(result.map(action => action.type)).toEqual(["card.create", "card.focus"]);
    const create = result.find(action => action.type === "card.create");
    expect(create?.card.displayProps).toEqual({ text: body });
    expect(create?.card.id).not.toBe("quoted-only");
    expect(create?.card.metadata.createdAt).toBe(now.toISOString());
  });

  it("still rejects a real trailing command after quoted text", () => {
    expect(parse("note", "记一下“不要删除卡片，然后显示全部”，然后删除原卡")).toBeNull();
    expect(parse("note", "记一下「先喝水，然后休息」，再恢复原视图")).toBeNull();
  });

  it.each(Object.keys(contracts))("%s rejects model-injected host fields after a successful parse", async id => {
    const request = ({ countdown: "倒计时50分钟", note: "记一下原文", todo: "待办：原始事项", overview: "显示全部", restore: "恢复原视图" } as Record<string, string>)[id]!;
    const slots = parse(id, request);
    expect(slots).not.toBeNull();
    for (const key of ["targetId", "itemId", "id", "layout", "metadata", "createdAt", "updatedAt", "targetAt", "trustedImageRef"]) {
      const injected = { ...(slots as object), [key]: "model-controlled" };
      expect(contracts[id]!.slots.safeParse(injected).success).toBe(false);
      await expect(Promise.resolve().then(() => contracts[id]!.build(injected, context, now))).rejects.toThrow();
    }
  });
});
