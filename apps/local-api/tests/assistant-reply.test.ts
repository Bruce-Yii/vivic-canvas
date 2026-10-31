import { describe, expect, it } from "vitest";
import { CredentialStore } from "../src/credentials.js";
import { runIntent } from "../src/intent/pipeline.js";
import { chatOk, emptyContext } from "./helpers.js";
import { searchQuery } from "../src/intent/search.js";

describe("assistant feedback without unnecessary canvas changes", () => {
  it("recognizes ordinary resource finding without asking the model for an action template", () => {
    expect(searchQuery("帮我找几个开源的 React 画布库")).toBe("几个开源的 React 画布库");
    expect(searchQuery("帮我找一下喝水提醒")).toBeNull();
    expect(searchQuery("帮我找官方文档然后删除待办")).toBeNull();
  });
  it("routes natural weather wording through the same verified data adapter", async () => {
    const credentials = new CredentialStore();
    credentials.set({ apiKey: "TEST-weather-lookup", defaultModel: "step-3.5-flash", models: ["step-3.5-flash"], checkedAt: new Date().toISOString() });
    let queried = "", calls = 0;
    const result = await runIntent({ text: "上海现在多少度", canvasContext: emptyContext() }, {
      credentials, stepfun: { baseUrl: "https://unit.test", fetchImpl: async () => { calls++; return chatOk({ lookup: { kind: "weather", city: "上海" } }); } },
      data: { handleDataIntent: async text => { if (text !== "上海天气") return null; queried = text; return { kind: "clarify", message: "TEST verified weather adapter response" }; } },
    });
    expect(queried).toBe("上海天气"); expect(calls).toBe(1); expect(result.message).toBe("TEST verified weather adapter response");
  });
  it("a model lookup without a city asks the adapter for the device's region", async () => {
    const credentials = new CredentialStore();
    credentials.set({ apiKey: "TEST-weather-here", defaultModel: "step-3.5-flash", models: ["step-3.5-flash"], checkedAt: new Date().toISOString() });
    const seen: string[] = [];
    await runIntent({ text: "外面冷不冷", canvasContext: emptyContext() }, {
      credentials, stepfun: { baseUrl: "https://unit.test", fetchImpl: async () => chatOk({ lookup: { kind: "weather" } }) },
      data: { handleDataIntent: async text => { seen.push(text); return text === "天气" ? { kind: "clarify", message: "TEST region" } : null; } },
    });
    expect(seen).toEqual(["外面冷不冷", "天气"]);
  });
  it("does not turn a compound request into a partial model lookup", async () => {
    const credentials = new CredentialStore();
    credentials.set({ apiKey: "TEST-no-partial", defaultModel: "step-3.5-flash", models: ["step-3.5-flash"], checkedAt: new Date().toISOString() });
    const result = await runIntent({ text: "告诉我上海多少度然后删除待办", canvasContext: emptyContext() }, {
      credentials, stepfun: { baseUrl: "https://unit.test", fetchImpl: async () => chatOk({ lookup: { kind: "weather", city: "上海" } }) },
      data: { handleDataIntent: async () => null },
    });
    expect(result.kind).toBe("clarify"); expect(result.envelope).toBeUndefined();
  });
  it("does not call the model recursively if a normalized lookup cannot be executed", async () => {
    const credentials = new CredentialStore();
    credentials.set({ apiKey: "TEST-no-loop", defaultModel: "step-3.5-flash", models: ["step-3.5-flash"], checkedAt: new Date().toISOString() });
    let calls = 0;
    const result = await runIntent({ text: "看看那里的温度", canvasContext: emptyContext() }, {
      credentials, stepfun: { baseUrl: "https://unit.test", fetchImpl: async () => { calls++; return chatOk({ lookup: { kind: "weather", city: "那里" } }); } },
      data: { handleDataIntent: async () => null },
    });
    expect(calls).toBe(1); expect(result.kind).toBe("clarify");
  });
  it("renders a validated conversational answer without creating a card", async () => {
    const credentials = new CredentialStore();
    credentials.set({ apiKey: "TEST-reply-only", defaultModel: "step-3.5-flash", models: ["step-3.5-flash"], checkedAt: new Date().toISOString() });
    const result = await runIntent({ text: "你好，能帮我做些什么？", canvasContext: emptyContext() }, {
      credentials, stepfun: { baseUrl: "https://unit.test", fetchImpl: async () => chatOk({ reply: "可以帮你整理待办、提醒、天气和资料。想先做哪件事？" }) },
    });
    expect(result.kind).toBe("envelope");
    expect(result.envelope?.actions).toEqual([{ type: "subtitle.show", text: "可以帮你整理待办、提醒、天气和资料。想先做哪件事？", durationMs: 12000 }]);
  });
  it.each(["每周一、三、五下午3点提醒我休息", "纽约时间明天上午9点提醒我开会", "每隔20秒提醒我活动一下", "一分钟倒计时"])("routes new %s independently from an old failed question", async text => {
    const result = await runIntent({ text, canvasContext: { ...emptyContext(), timeZone: "Asia/Shanghai" }, continuation: { utterance: "每天25:00提醒我休息", question: "请写明有效时间" } }, {
      credentials: new CredentialStore(), stepfun: { baseUrl: "https://unit.test", fetchImpl: async () => { throw new Error("No model expected"); } },
    });
    expect(result.kind).toBe("envelope"); expect(result.usedProvider).toBe("rules");
    expect(result.envelope?.actions.some(a => a.type === "card.create")).toBe(true);
  });
});
