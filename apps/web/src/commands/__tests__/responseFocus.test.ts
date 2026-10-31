import { expect, it } from "vitest";
import { startsNewInstruction } from "@vivic/contracts";
import { focusResponseActions } from "../responseFocus";
import { createCanvasStore } from "@/state/canvasStore";
import { testCards } from "@/cards/__tests__/fixtures";
import { fastLocalCommand } from "../parse";

it.each(["每周一、三、五下午3点提醒我休息", "纽约时间明天上午9点提醒我开会", "当待办第1项完成后5秒提醒我休息", "上海天气", "展示所有卡片", "把待办第1项标记为完成", "一分钟倒计时"])("does not carry a failed unrelated question into %s", text => {
  expect(startsNewInstruction(text, "每天25:00提醒我休息")).toBe(true);
});
it("retains bare reference answers to destructive clarification", () => {
  expect(startsNewInstruction("五分钟倒计时", "删除那个提醒")).toBe(false);
  expect(startsNewInstruction("第二个", "删除那个卡片")).toBe(false);
  expect(startsNewInstruction("上海", "查询天气")).toBe(false);
});
it("focuses one direct response and preserves explicit highlighting and batches", () => {
  const state = createCanvasStore().getState();
  const create = { type: "card.create" as const, card: testCards.TodoCard };
  expect(focusResponseActions([create, { type: "canvas.fit" }], state).at(-1)).toEqual({ type: "card.focus", targetId: create.card.id });
  const highlight = { type: "card.highlight" as const, targetId: create.card.id };
  expect(focusResponseActions([create, highlight], state)).toEqual([create, highlight]);
  expect(focusResponseActions([create, { ...create, card: { ...create.card, id: "second" } }, { type: "canvas.fit" }], state).at(-1)).toEqual({ type: "canvas.fit" });
});
it("accepts everyday fit wording locally", () => {
  const state = createCanvasStore().getState();
  for (const text of ["展示所有卡片", "显示所有卡片", "请显示全部卡片", "显示全部"]) {
    expect(fastLocalCommand(text, { state, canvasId: "TEST" })?.kind).toBe("envelope");
  }
});
it("keeps new distant reminders off the canvas even when the adapter suggests focus", () => {
  const state = createCanvasStore().getState();
  const card = { ...testCards.CountdownCard, sourceData: { targetAt: new Date(Date.now() + 7200000).toISOString(), reminderText: "两小时后开会" } };
  expect(focusResponseActions([{ type: "card.create", card }, { type: "card.focus", targetId: card.id }], state)).toEqual([{ type: "card.create", card }]);
});
it("does not discard reminder alerts when ordinary subtitles are disabled", () => {
  const store = createCanvasStore();
  store.setPreferences({ theme: "auto", reducedMotion: false, subtitles: false });
  store.dispatch({ schemaVersion: "0.6", requestId: "due", canvasId: "TEST", actions: [{ type: "subtitle.show", text: "喝水", priority: "reminder", durationMs: 10000 }] });
  store.dispatch({ schemaVersion: "0.6", requestId: "normal", canvasId: "TEST", actions: [{ type: "subtitle.show", text: "已执行" }] });
  expect(store.getState().subtitle?.text).toBe("喝水");
  store.setPreferences({ theme: "auto", reducedMotion: true, subtitles: false });
  expect(store.getState().subtitle?.text).toBe("喝水");
});
