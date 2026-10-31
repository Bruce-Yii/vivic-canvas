import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { IntentRouter } from "../src/decision/router.js";
import { ProviderStore } from "../src/providers/store.js";
import type { IntentRouteId } from "@vivic/contracts";
import { authed, emptyContext, TEST_TOKEN, testConfig } from "./helpers.js";

/**
 * The four multi-card scenarios that failed on the deployed account because
 * the session app answered "未连接模型" while the provider panel showed an
 * enabled DeepSeek row. They now run through the real app with a saved
 * DeepSeek provider and a controlled OpenAI-compatible stub: the transport is
 * real, only the model's plan is canned.
 */

const CASES: Array<{ id: string; text: string; cards: string[]; provider: "rules" | "deepseek"; focus?: boolean }> = [
  { id: "sc-41", text: "帮我记个便签明天交周报，再设个 50 分钟倒计时", cards: ["NoteCard", "CountdownCard"], provider: "rules" },
  { id: "sc-42", text: "记个便笺明天交周报，再过五分钟叫我休息", cards: ["NoteCard", "CountdownCard"], provider: "deepseek" },
  { id: "sc-43", text: "加待办：买牛奶；记个便笺明天交周报", cards: ["TodoCard", "NoteCard"], provider: "rules" },
  { id: "sc-44", text: "加待办：买牛奶；显示全部", cards: ["TodoCard"], provider: "rules" },
  { id: "sc-45", text: "介绍一下特斯拉，顺便加个待办研究它的财报", cards: ["NewsCard", "TodoCard"], provider: "deepseek" },
  { id: "sc-50", text: "记个便笺交周报，加个待办买菜，再设一个 25 分钟计时", cards: ["NoteCard", "TodoCard", "CountdownCard"], provider: "deepseek" },
  { id: "sc-53", text: "记个便笺明天交周报，然后聚焦它", cards: ["NoteCard"], provider: "deepseek", focus: true },
];

const route = (text: string): IntentRouteId =>
  /聚焦/.test(text) ? "focus" : /显示全部/.test(text) ? "overview" : /特斯拉|介绍/.test(text) ? "answer"
    : /待办/.test(text) ? "todo" : /分钟|计时|叫我/.test(text) ? "countdown" : "note";

const plansFor = (clauses: string[]) => clauses.map((clause, index) => {
  if (/聚焦/.test(clause)) return { contract: "focus", slots: {}, clause: index };
  if (/特斯拉|介绍/.test(clause)) return { contract: "answer", clause: index,
    slots: { headline: "特斯拉", summary: "美国电动车与储能公司。", keyPoints: ["2003 年成立", "主业为电动车与储能"] } };
  if (/待办/.test(clause)) return { contract: "todo", clause: index, slots: { items: [/买菜/.test(clause) ? "买菜" : "研究特斯拉财报"] } };
  if (/分钟|计时|叫我/.test(clause)) return { contract: "countdown", clause: index,
    slots: { seconds: /25/.test(clause) ? 1500 : 300, ...(/叫我/.test(clause) ? { text: "休息" } : {}) } };
  return { contract: "note", clause: index, slots: { text: /周报/.test(clause) ? "明天交周报" : clause } };
});

const urls: string[] = [];
const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
  urls.push(String(input));
  const messages = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
  const user = JSON.parse(messages.messages.find(message => message.role === "user")!.content.split("\n上次校验失败")[0]!) as
    { clauses?: string[]; utterance?: string };
  const clauses = user.clauses ?? [user.utterance ?? ""];
  return Response.json({ choices: [{ message: { content: JSON.stringify({ plans: plansFor(clauses), say: "好的", text: "已完成" }) } }] });
}) as typeof fetch;

const store = new ProviderStore({ dataDir: "C:\\nonexistent", persist: false });
store.create({ name: "DeepSeek 官方 (seed)", protocol: "openai-compatible", baseUrl: "https://api.deepseek.com/v1",
  apiKey: "sk-test-multicard-deepseek", model: "deepseek-chat", roles: ["main"] });

const router: IntentRouter = { mode: "on",
  directRoutes: new Set(["countdown", "todo", "note", "overview", "restore"]),
  routeUtterance: async text => ({ route: route(text), probability: .99, probabilities: { [route(text)]: .99 }, none: false, latencyMs: 1 }),
  chooseTarget: async () => null };

const app = createApp({ config: testConfig(), mode: "online", providerStore: store, router, fetchImpl });
afterAll(() => app.dispose());

describe("multi-card scenarios with a saved DeepSeek provider", () => {
  it.each(CASES)("$id returns an envelope with every expected card", async ({ id, text, cards, provider, focus }) => {
    urls.length = 0;
    const response = await app.request("/api/intent", { method: "POST", headers: authed,
      body: JSON.stringify({ text, canvasContext: emptyContext() }) });
    const body = await response.json();
    expect(body.kind, `${id}: ${body.message ?? ""}`).toBe("envelope");
    expect(body.usedProvider).toBe(provider);
    expect(body.message ?? "").not.toContain("未连接模型");
    const created = (body.envelope.actions as Array<{ type: string; card?: { type: string } }>)
      .filter(action => action.type === "card.create").map(action => action.card!.type);
    expect(created).toEqual(cards);
    if (focus) expect((body.envelope.actions as Array<{ type: string }>).some(action => action.type === "card.focus")).toBe(true);
    if (provider === "deepseek") {
      expect(urls).toContain("https://api.deepseek.com/v1/chat/completions");
    } else {
      expect(urls).toEqual([]);
    }
  });
});
