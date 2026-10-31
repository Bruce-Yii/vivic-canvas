import { describe, expect, it } from "vitest";
import { runIntent } from "../src/intent/pipeline.js";
import { CredentialStore } from "../src/credentials.js";
import { IntentRequestSchema } from "../src/schemas.js";
import { emptyContext, chatOk } from "./helpers.js";
import { createDataClient } from "../src/data/index.js";
import { ActionEnvelopeSchema } from "@vivic/contracts";
import { continueWeatherInput } from "../src/data/weatherInput.js";

describe("one-turn clarification continuation", () => {
  it("resolves an answer against the original delete request rather than creating a new timer", async () => {
    const credentials = new CredentialStore();
    credentials.set({ apiKey: "TEST-private-clarification", defaultModel: "step-3.5-flash", models: ["step-3.5-flash"], checkedAt: new Date().toISOString() });
    const input = { text: "五分钟倒计时", continuation: { utterance: "删除那个提醒", question: "你要删除哪个时长的提醒？" },
      canvasContext: emptyContext([{ id: "five-minute", type: "CountdownCard", displayProps: {}, sourceDataSummary: { targetAt: new Date(Date.now() + 300000).toISOString() }, layout: { x: 0, y: 0 } }]) };
    let calls = 0;
    const result = await runIntent(input, { credentials, stepfun: { baseUrl: "https://unit.test", fetchImpl: async (_url, init) => {
      calls++; const payload = JSON.parse(String(init?.body)); const message = JSON.parse(payload.messages[1].content);
      expect(message.clarification).toEqual(input.continuation); expect(message.utterance).toBe("五分钟倒计时");
      return chatOk({ actions: [{ type: "card.delete", targetId: "five-minute" }] });
    } } });
    expect(calls).toBe(1); expect(result.kind).toBe("envelope");
    expect(result.envelope?.actions).toEqual([{ type: "card.delete", targetId: "five-minute" }]);
  });
  it("rejects credential/config/extra fields in the continuation contract", () => {
    expect(IntentRequestSchema.safeParse({ text: "第一个", canvasContext: emptyContext(),
      continuation: { utterance: "删除那个", question: "哪一个？", apiKey: "TEST never prompt" } }).success).toBe(false);
  });
});

describe("data questions never fall through to the model", () => {
  it.each(["上海明天天气", "上海天气然后删除旧卡", "删除天气卡片"])("does not reduce unsupported or destructive %s to current weather", utterance => {
    expect(continueWeatherInput("上海,上海市", utterance)).toBeNull();
  });
  it("answers an unresolved region question with the named city, and re-asks rather than locating on a refusal", () => {
    expect(continueWeatherInput("北京", "今天天气如何")).toBe("北京天气");
    expect(continueWeatherInput("北京今天天气", "天气怎么样")).toBe("北京今天天气");
    for (const refusal of ["不要查", "删除卡片"]) expect(continueWeatherInput(refusal, "今天天气如何")).toBe("？天气");
  });
  const location = { id: 1796236, name: "上海", latitude: 31.22, longitude: 121.46, country: "中国",
    country_code: "CN", admin1: "上海市", timezone: "Asia/Shanghai", feature_code: "PPLA" };
  const setup = () => {
    let plannerCalls = 0;
    const queries: string[] = [];
    const data = createDataClient({ fetchImpl: (async (input: string | URL | Request) => {
      const url = new URL(String(input)); queries.push(url.href);
      const value = url.hostname.startsWith("geocoding")
        ? { results: url.searchParams.get("name")!.includes(",") ? [location] : [location, { ...location, id: 42, admin1: "浙江" }] }
        : { latitude: 31.25, longitude: 121.5, utc_offset_seconds: 0,
          current_units: { time: "unixtime", temperature_2m: "°C" },
          current: { time: Math.floor(Date.now() / 1000), interval: 900, temperature_2m: 22.4, weather_code: 2, is_day: 1 } };
      return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    }) as typeof fetch });
    const run = (text: string, continuation?: { utterance: string; question: string }) => runIntent({ text, continuation, canvasContext: emptyContext() }, {
      data, credentials: new CredentialStore(), stepfun: { baseUrl: "https://unit.test", fetchImpl: async () => { plannerCalls++; throw new Error("Must not call a model"); } },
    });
    return { run, queries, calls: () => plannerCalls };
  };

  it("selects the municipality directly and supports older pending location questions", async () => {
    const h = setup();
    const first = await h.run("上海天气");
    expect(first).toMatchObject({ kind: "envelope" });
    const result = await h.run("上海,上海市", { utterance: "上海天气", question: "请补充城市" });
    expect(result.envelope?.spokenText).toBe("已显示上海当前天气");
    expect(ActionEnvelopeSchema.safeParse(result.envelope).success).toBe(true);
    expect(result.envelope?.actions).toContainEqual(expect.objectContaining({ type: "card.create",
      card: expect.objectContaining({ type: "WeatherCard", displayProps: { tempC: 22.4, conditionIcon: "cloud" } }) }));
    expect(h.queries).toHaveLength(4); expect(h.calls()).toBe(0);
  });

  it.each(["上海,上海市天气", "帮我创建一张上海,上海市天气卡片", "天气卡片：上海,上海市"])("accepts explicit weather %s after a question", async text => {
    const h = setup();
    const result = await h.run(text, { utterance: "上海天气", question: "请补充城市和省州" });
    expect(result.kind).toBe("envelope"); expect(h.queries).toHaveLength(2); expect(h.calls()).toBe(0);
  });

  it("creates an empty table immediately and supports older pending data questions", async () => {
    const h = setup();
    const first = await h.run("给我创建一个表格");
    expect(first).toMatchObject({ kind: "envelope" });
    const result = await h.run("周一3，周二5，周三4", { utterance: "给我创建一个表格", question: "请提供数据" });
    expect(result.envelope?.actions).toContainEqual(expect.objectContaining({ type: "card.create",
      card: expect.objectContaining({ type: "TableCard", displayProps: { columns: ["名称", "数值"], rows: [["周一", 3], ["周二", 5], ["周三", 4]] } }) }));
    expect(h.queries).toHaveLength(0); expect(h.calls()).toBe(0);
  });

  it("does not retain the old data question for a new instruction or resolve mixed follow-ups partially", async () => {
    const h = setup();
    const next = await h.run("加待办：完成测试", { utterance: "给我创建一个表格", question: "请提供数据" });
    expect(next.envelope?.actions).toContainEqual(expect.objectContaining({ type: "card.create", card: expect.objectContaining({ type: "TodoCard" }) }));
    for (const answer of ["上海天气然后删除旧卡", "不要查上海", "周一3，同时删除卡片"]) {
      const result = await h.run(answer, { utterance: answer.startsWith("周") ? "创建表格" : "上海天气", question: "请补充信息" });
      expect(result.kind).toBe("clarify"); expect(result.envelope).toBeUndefined();
    }
    expect(h.queries).toHaveLength(0); expect(h.calls()).toBe(0);
  });
});
