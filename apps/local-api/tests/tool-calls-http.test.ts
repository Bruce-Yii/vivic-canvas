import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { CredentialStore } from "../src/credentials.js";
import { IntentResponseSchema, type CanvasContext } from "../src/schemas.js";
import { TEST_TOKEN, emptyContext, testConfig } from "./helpers.js";

/**
 * The tool layer is a pure mapper, but a composite answer only reaches a user
 * if the HTTP path keeps both halves. These tests drive the real pipeline with
 * a loopback OpenAI-compatible stub: no provider key, no network.
 */

const origin = "http://localhost:5173";
const todo = (): CanvasContext["cards"][number] => ({ id: "todo_shop", type: "TodoCard", aliases: ["购物清单"],
  displayProps: { title: "购物清单", items: [{ id: "i1", text: "买牛奶", done: false }] },
  sourceDataSummary: {}, layout: { x: 0, y: 0, width: 320, height: 140 } });

type Call = { name: string; arguments: Record<string, unknown> };
const callsFor = (text: string): Call[] => {
  if (/固定住|固定/u.test(text)) return [
    { name: "focus_card", arguments: { card_id: "todo_shop" } },
    { name: "arrange_card", arguments: { card_id: "todo_shop", action: "pin" } },
  ];
  if (/整理一下布局|整理布局/u.test(text)) return /删除|删掉/u.test(text)
    ? [{ name: "delete_card", arguments: { card_id: "todo_shop" } }, { name: "arrange_canvas", arguments: {} }]
    : [{ name: "canvas_fit", arguments: {} }, { name: "arrange_canvas", arguments: {} }];
  return [{ name: "chat", arguments: {} }];
};

const apps: ReturnType<typeof createApp>[] = [];
afterEach(() => { for (const app of apps.splice(0)) app.dispose(); });

function setup() {
  const credentials = new CredentialStore();
  credentials.set({ apiKey: "TEST-synthetic-key", models: ["deepseek-flash"], defaultModel: "deepseek-flash", checkedAt: new Date().toISOString() });
  const bodies: Array<Record<string, unknown>> = [];
  const model = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages?: Array<{ role?: string; content?: string }>; tools?: unknown[] };
    bodies.push(body);
    const user = [...(body.messages ?? [])].reverse().find(message => message.role === "user")?.content ?? "";
    const toolCalls = callsFor(user).map((call, index) => ({ id: `call_${index}`, type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments) } }));
    return Response.json({ choices: [{ index: 0, finish_reason: "tool_calls",
      message: { role: "assistant", content: null, tool_calls: toolCalls } }] });
  });
  const app = createApp({ config: { ...testConfig(), stepfunBaseUrl: "https://model.test/v1", toolCalls: true },
    mode: "online", credentials, fetchImpl: model as unknown as typeof fetch });
  apps.push(app);
  const post = async (text: string) => {
    const response = await app.fetch(new Request(`${origin}/api/intent`, { method: "POST",
      headers: { authorization: `Bearer ${TEST_TOKEN}`, origin, "content-type": "application/json" },
      body: JSON.stringify({ text, canvasContext: emptyContext([todo()]) }) }));
    expect(response.status).toBe(200);
    return IntentResponseSchema.parse(await response.json());
  };
  return { post, model, bodies };
}

describe("composite protocol over the real intent HTTP path", () => {
  it("returns focus actions plus the pin operation in one validated response", async () => {
    const { post, bodies } = setup();
    const result = await post("先聚焦购物清单，再把它固定住");
    expect(bodies[0]!.tools).toBeDefined();
    expect(result.kind).toBe("envelope");
    expect(result.toolCalls).toBe(true);
    expect(result.envelope!.actions).toEqual([{ type: "card.focus", targetId: "todo_shop" }]);
    expect(result.hostOperation).toEqual({ kind: "card.pin", targetId: "todo_shop", pinned: true });
  });

  it("returns a camera move plus canvas.arrange in one validated response", async () => {
    const { post } = setup();
    const result = await post("先显示全部卡片，然后整理一下布局");
    expect(result.kind).toBe("envelope");
    expect(result.toolCalls).toBe(true);
    expect(result.envelope!.actions).toEqual([{ type: "canvas.fit" }]);
    expect(result.hostOperation).toEqual({ kind: "canvas.arrange" });
  });

  it("keeps the deletion confirmation gate for a composite that carries a delete", async () => {
    const { post } = setup();
    // Relaxing envelope+operation must not let a taskless request delete.
    const result = await post("删掉购物清单，然后整理一下布局");
    expect(result.kind).toBe("clarify");
    expect(result.message).toContain("删除需要确认");
    expect(result.envelope).toBeUndefined();
    expect(result.hostOperation).toBeUndefined();
  });
});
