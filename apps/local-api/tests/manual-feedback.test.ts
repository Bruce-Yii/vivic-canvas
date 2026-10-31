import { expect, it } from "vitest";
import { createDataClient } from "../src/data/index.js";
import { emptyContext } from "./helpers.js";
import { matchRules } from "../src/intent/rules.js";
import { parseExactReminders } from "../src/intent/reminders.js";
const shanghai = { id: 1796236, name: "上海", latitude: 31.22, longitude: 121.46, country: "中国", country_code: "CN", admin1: "上海市", timezone: "Asia/Shanghai", feature_code: "PPLA" };
it("creates an actually empty table and fills the same stable ID from the next explicit data series", async () => {
  const client = createDataClient({ fetchImpl: async () => { throw new Error("No model/network is required"); } });
  for (const text of ["给我创建一个表格", "创建一个空表格", "创建表格卡片"]) {
    const result = await client.handleDataIntent(text, emptyContext());
    const action = result?.envelope?.actions.find(a => a.type === "card.create");
    expect(action?.type).toBe("card.create"); if (action?.type !== "card.create") throw new Error("missing table");
    expect(action.card.displayProps).toEqual({ columns: ["名称", "数值"], rows: [] });
    const card = action.card;
    const filled = await client.handleDataIntent("周一3，周二5，周三4", emptyContext([{ id: card.id, type: card.type, displayProps: card.displayProps, sourceDataSummary: card.sourceData, layout: card.layout }]));
    expect(filled?.envelope?.actions).toEqual([expect.objectContaining({ type: "card.update", targetId: card.id, displayProps: { columns: ["名称", "数值"], rows: [["周一", 3], ["周二", 5], ["周三", 4]] } })]);
  }
});
it("keeps genuine ambiguous cities and missing weather data as explicit errors instead of inventing a location", async () => {
  const client = createDataClient({ fetchImpl: async () => Response.json({ results: [
    { ...shanghai, id: 1, name: "Springfield", country_code: "US", admin1: "Illinois" },
    { ...shanghai, id: 2, name: "Springfield", country_code: "US", admin1: "Missouri" },
  ] }) });
  expect(await client.weather("Springfield")).toMatchObject({ kind: "clarify" });
});
it("bulk deletion uses a single validated batch covering every existing type", () => {
  const ctx = emptyContext(Array.from({ length: 60 }, (_, i) => ({ id: `TEST-${i}`, type: "TodoCard", displayProps: {}, sourceDataSummary: {}, layout: { x: i, y: 0 } })));
  expect(matchRules("删除所有卡片", ctx)?.actions).toEqual([{ type: "cards.delete", targetIds: ctx.cards.map(c => c.id) }]);
  expect(matchRules("不要删除所有卡片", ctx)).toBeNull();
});
it("does not mistake a character inside the task name for a compound operation", () => {
  expect(parseExactReminders("60分钟后提醒我合并资料")).toEqual([{ afterSeconds: 3600, text: "合并资料" }]);
  expect(parseExactReminders("60分钟后提醒我喝水并且删除待办")).toBeNull();
});
