import { describe, expect, it } from "vitest";
import { ActionEnvelopeSchema } from "@vivic/contracts";
import { createApp } from "../src/app.js";
import { CredentialStore } from "../src/credentials.js";
import { authed, chatOk, emptyContext, fetchStub, modelsOk, testConfig } from "./helpers.js";

const SECRET = "[redacted]";

const setup = (fetchImpl: typeof fetch) => {
  const credentials = new CredentialStore();
  const app = createApp({
    config: testConfig(),
    credentials,
    fetchImpl,
  });
  return { app, credentials };
};

const presetCredentials = (credentials: CredentialStore) =>
  credentials.set({
    apiKey: SECRET,
    models: ["step-3"],
    defaultModel: "step-3",
    checkedAt: "2026-10-15T00:00:00.000Z",
  });

describe("auth + input hardening", () => {
  const noFetch = fetchStub({});

  it("accepts the configured Vivic origin and rejects another local page even with a valid session bearer", async () => {
    const app = createApp({ config: testConfig({ allowedOrigins: ["http://localhost:5175"] }), fetchImpl: noFetch });
    try {
      const request = (origin: string) => app.request("/api/intent", {
        method: "POST", headers: { ...authed, origin },
        body: JSON.stringify({ text: "十分钟倒计时", canvasContext: emptyContext() }),
      });
      const allowed = await request("http://localhost:5175");
      expect(allowed.status).toBe(200);
      expect(await allowed.json()).toMatchObject({ kind: "envelope", usedProvider: "rules" });
      expect((await request("http://localhost:5176")).status).toBe(403);
    } finally { app.dispose(); }
  });

  it("rejects requests without or with a wrong bearer token", async () => {
    const { app } = setup(noFetch);
    expect((await app.request("/api/providers/status")).status).toBe(401);
    expect(
      (
        await app.request("/api/providers/status", {
          headers: { authorization: "Bearer wrong" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request("/api/providers/status", {
          headers: { authorization: authed.authorization },
        })
      ).status,
    ).toBe(200);
  });

  it("zod-rejects bad bodies on every route (extra field / wrong type)", async () => {
    const { app } = setup(noFetch);
    const extraField = await app.request("/api/credentials/stepfun/validate", {
      method: "POST",
      headers: authed,
      body: JSON.stringify({ apiKey: "x".repeat(20), backdoor: true }),
    });
    expect(extraField.status).toBe(400);
    const wrongType = await app.request("/api/credentials/stepfun/validate", {
      method: "POST",
      headers: authed,
      body: JSON.stringify({ apiKey: 12345678901 }),
    });
    expect(wrongType.status).toBe(400);
    const badIntent = await app.request("/api/intent", {
      method: "POST",
      headers: authed,
      body: JSON.stringify({ text: "hi", canvasContext: { nope: 1 } }),
    });
    expect(badIntent.status).toBe(400);
    const notJson = await app.request("/api/intent", {
      method: "POST",
      headers: authed,
      body: "not json",
    });
    expect(notJson.status).toBe(400);
  });

  it("caps oversized bodies before parsing", async () => {
    const { app } = setup(noFetch);
    const big = await app.request("/api/intent", {
      method: "POST",
      headers: { ...authed, "content-length": String(70 * 1024) },
      body: JSON.stringify({
        text: "x".repeat(65_000),
        canvasContext: emptyContext(),
      }),
    });
    expect([400, 413]).toContain(big.status);
  });
});

describe("POST /api/credentials/stepfun/validate", () => {
  it("stores nothing but a sanitized status on success (C10 redaction)", async () => {
    const { app, credentials } = setup(
      fetchStub({ "/v1/models": () => modelsOk(), "/v1/chat/completions": () => chatOk({ ok: true }) }),
    );
    const res = await app.request("/api/credentials/stepfun/validate", {
      method: "POST",
      headers: authed,
      body: JSON.stringify({ apiKey: SECRET }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.connected).toBe(true);
    expect((body.models as string[]).includes("step-3")).toBe(true);
    expect(JSON.stringify(body)).not.toContain(SECRET);

    const status = await app.request("/api/providers/status", {
      headers: { authorization: authed.authorization },
    });
    expect(JSON.stringify(await status.json())).not.toContain(SECRET);
    expect(credentials.status().connected).toBe(true);
  });

  it("honest errors on rejected key, unreachable host and timeout", async () => {
    const rejected = setup(
      fetchStub({ "/v1/models": () => new Response("nope", { status: 401 }) }),
    );
    const r1 = await rejected.app.request("/api/credentials/stepfun/validate", {
      method: "POST",
      headers: authed,
      body: JSON.stringify({ apiKey: SECRET }),
    });
    const b1 = (await r1.json()) as { ok: boolean; error?: string };
    expect(b1.ok).toBe(false);
    expect(b1.error).toContain("401");
    expect(rejected.credentials.status().connected).toBe(false);

    const unreachable = setup(
      fetchStub({
        "/v1/models": () => {
          throw new Error("fetch failed");
        },
      }),
    );
    const r2 = await unreachable.app.request("/api/credentials/stepfun/validate", {
      method: "POST",
      headers: authed,
      body: JSON.stringify({ apiKey: SECRET }),
    });
    expect(((await r2.json()) as { error?: string }).error).toContain("无法连接");

    const slow = setup(
      fetchStub({
        "/v1/models": async () => {
          throw new DOMException("timed out", "TimeoutError");
        },
      }),
    );
    const r3 = await slow.app.request("/api/credentials/stepfun/validate", {
      method: "POST",
      headers: authed,
      body: JSON.stringify({ apiKey: SECRET }),
    });
    expect(((await r3.json()) as { error?: string }).error).toContain("超时");
  });

  it("disconnect() clears memory; later intent fails closed", async () => {
    const { app } = setup(fetchStub({ "/v1/models": () => modelsOk(), "/v1/chat/completions": () => chatOk({ ok: true }) }));
    await app.request("/api/credentials/stepfun/validate", {
      method: "POST",
      headers: authed,
      body: JSON.stringify({ apiKey: SECRET }),
    });
    await app.request("/api/credentials/stepfun/disconnect", {
      method: "POST",
      headers: authed,
      body: "{}",
    });
    const status = (await (
      await app.request("/api/providers/status", {
        headers: { authorization: authed.authorization },
      })
    ).json()) as { providers: Array<{ connected: boolean }> };
    expect(status.providers[0]!.connected).toBe(false);

    const intent = await app.request("/api/intent", {
      method: "POST",
      headers: authed,
      body: JSON.stringify({ text: "帮我写一首诗", canvasContext: emptyContext() }),
    });
    const body = (await intent.json()) as { kind: string; message?: string };
    expect(body.kind).toBe("unknown");
    expect(body.message).toContain("未连接模型");
  });
});

describe("POST /api/intent decision pipeline", () => {
  it("rules short-circuit: 十分钟倒计时 needs no LLM and no fetch calls", async () => {
    const calls: string[] = [];
    const { app, credentials } = setup(
      fetchStub({}, (url) => calls.push(url)),
    );
    presetCredentials(credentials); // even with a key, rules must win
    const res = await app.request("/api/intent", {
      method: "POST",
      headers: authed,
      body: JSON.stringify({
        text: "十分钟倒计时",
        canvasContext: { ...emptyContext(), stage: "STANDBY" },
      }),
    });
    const body = (await res.json()) as {
      kind: string;
      usedProvider: string;
      envelope?: unknown;
    };
    expect(body.kind).toBe("envelope");
    expect(body.usedProvider).toBe("rules");
    expect(ActionEnvelopeSchema.safeParse(body.envelope).success).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("fail-closed without a key: honest offline message", async () => {
    const { app } = setup(fetchStub({}));
    const res = await app.request("/api/intent", {
      method: "POST",
      headers: authed,
      body: JSON.stringify({
        text: "删掉刚才那个蓝色的卡片",
        canvasContext: emptyContext(),
      }),
    });
    const body = (await res.json()) as { kind: string; message?: string; usedProvider?: string };
    expect(body.kind).toBe("unknown");
    expect(body.usedProvider).toBe("rules-offline");
    expect(body.message).toContain("未连接模型");
  });

  const validPlannerOutput = {
    actions: [{ type: "card.focus", targetId: "cd-1" }],
    spokenText: "已聚焦",
  };

  it("mocked LLM success -> validated envelope", async () => {
    const { app, credentials } = setup(
      fetchStub({ "/v1/chat/completions": () => chatOk(validPlannerOutput) }),
    );
    presetCredentials(credentials);
    const res = await app.request("/api/intent", {
      method: "POST",
      headers: authed,
      body: JSON.stringify({
        text: "放大那个倒计时",
        canvasContext: emptyContext([
          {
            id: "cd-1",
            type: "CountdownCard",
            displayProps: {},
            sourceDataSummary: { targetAt: "2026-10-15T09:00:00.000Z" },
            layout: { x: 0, y: 0 },
          },
        ]),
      }),
    });
    const body = (await res.json()) as {
      kind: string;
      usedProvider?: string;
      envelope?: { canvasId: string; requestId: string; spokenText?: string };
    };
    expect(body.kind).toBe("envelope");
    expect(body.usedProvider).toBe("stepfun");
    expect(ActionEnvelopeSchema.safeParse(body.envelope).success).toBe(true);
    expect(body.envelope?.canvasId).toBe("c1");
    expect(body.envelope?.requestId).toMatch(/^llm_/);
    expect(body.envelope?.spokenText).toBe("已聚焦");
  });

  it("invalid planner output is retried ONCE with zod feedback", async () => {
    let chatCalls = 0;
    const { app, credentials } = setup(
      fetchStub({
        "/v1/chat/completions": () => {
          chatCalls += 1;
          return chatCalls === 1
            ? chatOk({ actions: [{ type: "nonsense" }] })
            : chatOk(validPlannerOutput);
        },
      }),
    );
    presetCredentials(credentials);
    const res = await app.request("/api/intent", {
      method: "POST",
      headers: authed,
      body: JSON.stringify({ text: "放大倒计时", canvasContext: emptyContext([{
        id: "cd-1", type: "CountdownCard", displayProps: {},
        sourceDataSummary: { targetAt: "2026-10-15T09:00:00.000Z" },
        layout: { x: 0, y: 0 },
      }]) }),
    });
    const body = (await res.json()) as { kind: string };
    expect(chatCalls).toBe(2);
    expect(body.kind).toBe("envelope");
  });

  it("twice-invalid planner output -> honest clarify, never throws", async () => {
    const { app, credentials } = setup(
      fetchStub({
        "/v1/chat/completions": () => chatOk({ actions: [{ type: "nonsense" }] }),
      }),
    );
    presetCredentials(credentials);
    const res = await app.request("/api/intent", {
      method: "POST",
      headers: authed,
      body: JSON.stringify({ text: "随便做点什么", canvasContext: emptyContext() }),
    });
    const body = (await res.json()) as { kind: string; message?: string };
    expect(body.kind).toBe("clarify");
    expect(body.message).toContain("换一种说法");
  });

  it("planner transport failure -> kind error with honest reason", async () => {
    const { app, credentials } = setup(
      fetchStub({
        "/v1/chat/completions": () => new Response("boom", { status: 502 }),
      }),
    );
    presetCredentials(credentials);
    const res = await app.request("/api/intent", {
      method: "POST",
      headers: authed,
      body: JSON.stringify({ text: "放大倒计时", canvasContext: emptyContext() }),
    });
    const body = (await res.json()) as { kind: string; message?: string };
    expect(body.kind).toBe("error");
    expect(body.message).toContain("模型暂时不可用");
    expect(body.message).toContain("502");
  });
});
