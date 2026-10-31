import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { streamFeedbackEnabled } from "../src/config.js";
import { CredentialStore } from "../src/credentials.js";
import type { IntentRouter } from "../src/decision/router.js";
import { createOnlineSessionApp } from "../src/online/appFactory.js";
import type { DiagnosticEvent } from "../src/diagnostics.js";
import { authed, emptyContext, modelsOk, testConfig, TEST_TOKEN } from "./helpers.js";

const sseFrame = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
const answer = { slots: { text: "阅读草稿" }, say: "已整理。" };
/** One upstream that answers streamed only when the request actually asks for it. */
const upstream = (bodies: Record<string, unknown>[]) => vi.fn<typeof fetch>(async (_input, init) => {
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
  bodies.push(body);
  const content = JSON.stringify({ feedback: "我来整理这份便笺。", ...answer });
  if (body.stream !== true) return Response.json({ choices: [{ message: { content } }] });
  const cut = content.indexOf(",") + 1;
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sseFrame(content.slice(0, cut))));
      controller.enqueue(new TextEncoder().encode(sseFrame(content.slice(cut))
        + `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
});
const noteRouter: IntentRouter = { mode: "on", directRoutes: new Set(["note"]),
  routeUtterance: async () => ({ route: "note", probability: .99, probabilities: { note: .99 }, none: false, latencyMs: 0 }),
  chooseTarget: async () => null };
const credentialStore = () => {
  const store = new CredentialStore();
  store.set({ apiKey: "test-key-only", models: ["test-model"], defaultModel: "test-model", checkedAt: "test" });
  return store;
};
const streamed = async (config: ReturnType<typeof testConfig>, bodies: Record<string, unknown>[]) => {
  const app = createApp({ config, credentials: credentialStore(), fetchImpl: upstream(bodies), router: noteRouter });
  try {
    const response = await app.request("/api/intent", { method: "POST", headers: { ...authed, accept: "text/event-stream" },
      body: JSON.stringify({ text: "整理一份阅读草稿", canvasContext: emptyContext() }) });
    return await response.text();
  } finally { app.dispose(); }
};

describe("VIVIC_STREAM_FEEDBACK deployment switch", () => {
  it("keeps today's streamed first sentence when the switch is unset", async () => {
    const bodies: Record<string, unknown>[] = [];
    const text = await streamed(testConfig(), bodies);
    expect(bodies[0]!.stream).toBe(true);
    expect(text).toContain('"feedback":"我来整理这份便笺。"');
    expect(text.match(/event: result/g)).toHaveLength(1);
    const final = JSON.parse(text.split("event: result\ndata: ")[1]!.trim());
    expect(final).toMatchObject({ kind: "envelope" });
    expect(final.task?.status).toBe("awaiting_execution");
    // The published first sentence is timestamped in the same trace, not a second chain.
    expect(typeof final.trace?.firstFeedbackMs).toBe("number");
    expect(final.trace.firstFeedbackMs).toBeGreaterThanOrEqual(0);
    expect(final.envelope.actions).toContainEqual(expect.objectContaining({ type: "card.create" }));
  });
  it("publishes the planner's first sentence in a progress frame before the result, with a numeric cap", async () => {
    const bodies: Record<string, unknown>[] = [];
    const text = await streamed(testConfig(), bodies);
    // maxTokens must reach the transport as a number: the streamed-delta sink is
    // positional right after it, and passing the sink in the cap slot both typed
    // the cap wrong and turned streaming off entirely.
    expect(typeof bodies[0]!.max_tokens).toBe("number");
    expect(bodies[0]!.stream).toBe(true);
    const frames = text.split("\n\n").filter(Boolean);
    const feedbackAt = frames.findIndex(frame => frame.includes('"feedback":"我来整理这份便笺。"'));
    const resultAt = frames.findIndex(frame => frame.startsWith("event: result"));
    expect(feedbackAt).toBeGreaterThanOrEqual(0);
    expect(feedbackAt).toBeLessThan(resultAt);
  });
  it("off never requests stream:true and sends no feedback, while the task still completes", async () => {
    const bodies: Record<string, unknown>[] = [];
    const text = await streamed(testConfig({ streamFeedback: false }), bodies);
    expect(bodies[0]!.stream).toBeUndefined();
    expect(JSON.stringify(bodies[0])).not.toContain("feedback");
    expect(text).not.toContain("feedback");
    expect(text).toContain("event: accepted");
    expect(text.match(/event: result/g)).toHaveLength(1);
    const final = JSON.parse(text.split("event: result\ndata: ")[1]!.trim());
    expect(final).toMatchObject({ kind: "envelope" });
    expect(final.task?.status).toBe("awaiting_execution");
    // No feedback was sent, so the optional field must stay absent (not 0/null).
    expect(final.trace).not.toHaveProperty("firstFeedbackMs");
    expect(final.envelope.actions).toContainEqual(expect.objectContaining({ type: "card.create" }));
  });
  it("never leaks into ordinary JSON clients even when the switch is on", async () => {
    const bodies: Record<string, unknown>[] = [];
    const app = createApp({ config: testConfig(), credentials: credentialStore(), fetchImpl: upstream(bodies), router: noteRouter });
    try {
      const response = await app.request("/api/intent", { method: "POST", headers: authed,
        body: JSON.stringify({ text: "整理一份阅读草稿", canvasContext: emptyContext() }) });
      expect(await response.json()).toMatchObject({ kind: "envelope" });
      expect(bodies[0]!.stream).toBeUndefined();
      expect(JSON.stringify(bodies[0])).not.toContain("feedback");
    } finally { app.dispose(); }
  });
  it("reads the deployment environment in online sessions", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith("/models")) return modelsOk(["step-3.5-flash"]);
      return upstream(bodies)(input, init);
    });
    vi.stubEnv("VIVIC_STREAM_FEEDBACK", "off");
    const session = createOnlineSessionApp({ token: TEST_TOKEN, origin: "https://vivic.example" },
      { fetchImpl, router: noteRouter });
    try {
      const validate = await session.fetch(new Request("https://vivic.example/api/credentials/stepfun/validate",
        { method: "POST", headers: authed, body: JSON.stringify({ apiKey: "test-key-only" }) }));
      expect(await validate.json()).toMatchObject({ connected: true });
      const response = await session.fetch(new Request("https://vivic.example/api/intent", { method: "POST",
        headers: { ...authed, origin: "https://vivic.example", accept: "text/event-stream" },
        body: JSON.stringify({ text: "整理一份阅读草稿", canvasContext: emptyContext() }) }));
      const text = await response.text();
      expect(bodies[0]!.stream).toBeUndefined();
      expect(text).not.toContain("feedback");
      expect(JSON.parse(text.split("event: result\ndata: ")[1]!.trim())).toMatchObject({ kind: "envelope" });
    } finally { session.dispose(); vi.unstubAllEnvs(); }
  });
  it.each([[undefined, true], ["on", true], ["off", false], [" OFF ", false], ["maybe", true], ["", true]])(
    "parses %j as enabled=%s, falling back to the default on", (value, expected) => {
      expect(streamFeedbackEnabled(value)).toBe(expected);
    });
});

describe("intent progress and metadata diagnostics", () => {
  it("streams ordered progress and one schema-valid final result using the existing authenticated route", async () => {
    const events: DiagnosticEvent[] = [];
    const app = createApp({ config: testConfig(), onDiagnostic: event => events.push(event) });
    try {
      const response = await app.request("/api/intent", { method: "POST", headers: { ...authed, accept: "text/event-stream" },
        body: JSON.stringify({ text: "倒计时一分钟", canvasContext: emptyContext() }) });
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const id = response.headers.get("x-request-id"); expect(id).toBeTruthy();
      const text = await response.text();
      expect(text.indexOf("event: accepted")).toBeLessThan(text.indexOf("event: progress"));
      expect(text.indexOf("event: progress")).toBeLessThan(text.indexOf("event: result"));
      expect(text.match(/event: result/g)).toHaveLength(1);
      const final = JSON.parse(text.split("event: result\ndata: ")[1]!.trim());
      expect(final).toMatchObject({ kind: "envelope", usedProvider: "rules" });
      expect(events).toContainEqual(expect.objectContaining({ event: "intent.stage", requestId: id, stage: "rules" }));
      const log = JSON.stringify(events);
      for (const privateValue of ["倒计时一分钟", authed.authorization, "test-token-0123456789"]) expect(log).not.toContain(privateValue);
    } finally { app.dispose(); }
  });
  it("publishes targetState after the route hint so the client can gate action copy", async () => {
    const router: IntentRouter = { mode: "on", directRoutes: new Set(),
      routeUtterance: async () => ({ route: "focus", probability: .99, probabilities: { focus: .99 }, none: false, latencyMs: 0 }),
      chooseTarget: async () => null };
    const app = createApp({ config: testConfig(), router });
    try {
      const response = await app.request("/api/intent", { method: "POST", headers: { ...authed, accept: "text/event-stream" },
        body: JSON.stringify({ text: "聚焦便签「会议记录」", canvasContext: emptyContext([{ id: "card-1", type: "NoteCard",
          displayProps: { text: "会议记录" }, sourceDataSummary: {},
          layout: { x: 0, y: 0, width: 320, height: 120, pinned: false } }]) }) });
      const text = await response.text();
      expect(text).toContain('"route":"focus"');
      expect(text).toContain('"targetState":"resolved"');
    } finally { app.dispose(); }
  });
  it("publishes a safe scene hint for multi-clause and continuation paths instead of an empty wait", async () => {
    const app = createApp({ config: testConfig() });
    try {
      const multi = await app.request("/api/intent", { method: "POST", headers: { ...authed, accept: "text/event-stream" },
        body: JSON.stringify({ text: "帮我记个便笺：明天交周报；加一个待办：买牛奶", canvasContext: emptyContext() }) });
      const multiText = await multi.text();
      expect(multiText).toContain('"scene":"multi"');
      expect(multiText).toContain("event: result");

      const follow = await app.request("/api/intent", { method: "POST", headers: { ...authed, accept: "text/event-stream" },
        body: JSON.stringify({ text: "杭州", continuation: { utterance: "明天天气", question: "你在哪个城市？" },
          canvasContext: emptyContext() }) });
      expect(await follow.text()).toContain('"scene":"continuation"');
    } finally { app.dispose(); }
  });
  it("preserves authentication, strict input validation and JSON clients", async () => {
    const app = createApp({ config: testConfig(), onDiagnostic: () => { throw new Error("observer failure"); } });
    try {
      expect((await app.request("/api/intent/stream", { method: "POST" })).status).toBe(401);
      expect((await app.request("/api/intent/stream", { method: "POST", headers: authed, body: "{}" })).status).toBe(400);
      const ordinary = await app.request("/api/intent", { method: "POST", headers: authed,
        body: JSON.stringify({ text: "倒计时一分钟", canvasContext: emptyContext() }) });
      expect(ordinary.headers.get("content-type")).toContain("application/json");
      expect(await ordinary.json()).toMatchObject({ kind: "envelope" });
    } finally { app.dispose(); }
  });
  it("refreshes demo facts only via the validated adapter route", async () => {
    const query = { kind: "hotel", destination: "杭州", nights: 2 };
    const fetchImpl = vi.fn<typeof fetch>();
    const app = createApp({ config: testConfig(), fetchImpl });
    try {
      const response = await app.request("/api/travel/refresh", { method: "POST", headers: authed, body: JSON.stringify({ query }) });
      expect(await response.json()).toMatchObject({ kind: "travel", card: { type: "TravelOffersCard", displayProps: { query, mode: "demo" }, sourceData: { provider: "vivic-demo" } } });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect((await app.request("/api/travel/refresh", { method: "POST", headers: authed,
        body: JSON.stringify({ query, items: [{ price: 1 }] }) })).status).toBe(400);
    } finally { app.dispose(); }
  });
});
