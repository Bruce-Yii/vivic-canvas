import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { CredentialStore } from "../src/credentials.js";
import { STEPFUN_PLAN_BASE_URL } from "../src/config.js";
import { authed, chatOk, emptyContext, fetchStub, modelsOk, testConfig } from "./helpers.js";
import { describeProviderError } from "../src/providerError.js";

const KEY = "unit-test-private-key";

describe("Plan connection and permission diagnostics", () => {
  it("a readable model directory plus a forbidden Plan request never reports connected", async () => {
    const credentials = new CredentialStore();
    const calls: string[] = [];
    const app = createApp({ credentials, config: testConfig({ stepfunBaseUrl: STEPFUN_PLAN_BASE_URL }), fetchImpl: fetchStub({
      "/models": () => modelsOk(["step-3.5-flash"]),
      "/chat/completions": () => Response.json({ error: { code: "permission_denied", message: "No active Plan subscription" } }, { status: 403, headers: { "x-trace-id": "trace-123" } }),
    }, url => calls.push(url)) });
    const response = await app.request("/api/credentials/stepfun/validate", {
      method: "POST", headers: authed, body: JSON.stringify({ apiKey: KEY }),
    });
    const body = await response.json() as { error: string };
    expect(body).toMatchObject({ ok: false, connected: false });
    expect(body.error).toContain("HTTP 403");
    expect(body.error).toContain("No active Plan subscription");
    expect(body.error).toContain("trace-123");
    expect(JSON.stringify(body)).not.toContain(KEY);
    expect(credentials.status().connected).toBe(false);
    expect(credentials.status().lastError).toContain("No active Plan subscription");
    expect(calls).toEqual(["https://api.stepfun.com/v1/models", `${STEPFUN_PLAN_BASE_URL}/chat/completions`]);
  });

  it("only stores the key after a successful bounded Plan JSON probe", async () => {
    const credentials = new CredentialStore();
    const app = createApp({ credentials, config: testConfig(), fetchImpl: fetchStub({
      "/models": () => modelsOk(["step-3.5-flash"]),
      "/chat/completions": init => {
        const body = JSON.parse(String(init?.body));
        expect(body.model).toBe("step-3.5-flash");
        expect(body.max_tokens).toBe(256);
        expect(credentials.getSecret()).toBeUndefined();
        return chatOk({ ok: true });
      },
    }) });
    const response = await app.request("/api/credentials/stepfun/validate", {
      method: "POST", headers: authed, body: JSON.stringify({ apiKey: KEY }),
    });
    expect(await response.json()).toMatchObject({ ok: true, connected: true });
    expect(credentials.getSecret()?.apiKey).toBe(KEY);
  });

  it.each([
    ["no content after thinking", { choices: [{ finish_reason: "length", message: { content: "", reasoning: "TEST thinking" } }] }],
    ["prose instead of JSON", { choices: [{ finish_reason: "stop", message: { content: "好的" } }] }],
  ])("an accepted Plan generation with %s still connects", async (_label, reply) => {
    const credentials = new CredentialStore();
    const app = createApp({ credentials, config: testConfig(), fetchImpl: fetchStub({
      "/models": () => modelsOk(["step-3.5-flash"]),
      "/chat/completions": () => Response.json(reply),
    }) });
    const response = await app.request("/api/credentials/stepfun/validate", {
      method: "POST", headers: authed, body: JSON.stringify({ apiKey: KEY }),
    });
    expect(await response.json()).toMatchObject({ ok: true, connected: true });
    expect(credentials.getSecret()?.apiKey).toBe(KEY);
  });

  it("a transient model-directory failure is retried once before the probe", async () => {
    const credentials = new CredentialStore();
    const calls: string[] = [];
    let catalog = 0;
    const app = createApp({ credentials, config: testConfig(), fetchImpl: fetchStub({
      "/models": () => ++catalog === 1 ? new Response("busy", { status: 503 }) : modelsOk(["step-3.5-flash"]),
      "/chat/completions": () => chatOk({ ok: true }),
    }, url => calls.push(url)) });
    const response = await app.request("/api/credentials/stepfun/validate", {
      method: "POST", headers: authed, body: JSON.stringify({ apiKey: KEY }),
    });
    expect(await response.json()).toMatchObject({ ok: true, connected: true });
    expect(calls.filter(url => url.endsWith("/models"))).toHaveLength(2);
  });

  it("a rejected key's model directory is not retried", async () => {
    const credentials = new CredentialStore();
    const calls: string[] = [];
    const app = createApp({ credentials, config: testConfig(), fetchImpl: fetchStub({
      "/models": () => Response.json({ error: { message: "invalid key" } }, { status: 401 }),
    }, url => calls.push(url)) });
    const response = await app.request("/api/credentials/stepfun/validate", {
      method: "POST", headers: authed, body: JSON.stringify({ apiKey: KEY }),
    });
    expect(await response.json()).toMatchObject({ ok: false, connected: false });
    expect(calls).toHaveLength(1);
  });

  it("planner 403 preserves a redacted reason and does not recommend reconnecting", async () => {
    const credentials = new CredentialStore();
    credentials.set({ apiKey: KEY, models: ["step-3.5-flash"], defaultModel: "step-3.5-flash", checkedAt: "now" });
    const app = createApp({ credentials, config: testConfig(), fetchImpl: fetchStub({
      "/chat/completions": () => Response.json({ error: { code: "permission_denied", message: `No active Plan. Key=${KEY}; Authorization: Bearer ${KEY}` } }, { status: 403 }),
    }) });
    const response = await app.request("/api/intent", { method: "POST", headers: authed,
      body: JSON.stringify({ text: "10分钟后提醒我", canvasContext: emptyContext() }),
    });
    const body = await response.json() as { kind: string; message: string };
    expect(body.kind).toBe("error");
    expect(body.message).toContain("No active Plan");
    expect(body.message).toContain("模型权限");
    expect(body.message).not.toContain("请稍后重试或断开重连");
    expect(JSON.stringify(body)).not.toContain(KEY);
  });

  it("does not forward HTML gateway error pages or oversized JSON", async () => {
    for (const body of ["<html>Forbidden details</html>", JSON.stringify({ error: { message: "a".repeat(9000) } })]) {
      const text = await describeProviderError(new Response(body, { status: 403 }), KEY);
      expect(text).toBe("模型服务返回 HTTP 403");
    }
  });

  it("omits key material in codes and trace headers as well as messages", async () => {
    const text = await describeProviderError(Response.json({ error: { code: KEY, message: `Bad key sk-other-secret ${KEY}` } }, {
      status: 403, headers: { "x-trace-id": KEY },
    }), KEY);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("sk-other-secret");
  });
});
