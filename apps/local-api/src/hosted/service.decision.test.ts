import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHostedService } from "./service.js";

const origin = "https://vivic.test";
const modelApiBaseUrl = "http://127.0.0.1:19441/v1";
const modelKey = "test-decision-platform-key";
const labels = {
  fit: "显示全部卡片", restore: "恢复之前视图", focus: "聚焦一张卡片", delete: "删除卡片",
  expand: "展开便笺", collapse: "收起便笺", other: "不明确或其他操作",
};

describe("hosted decision classifier connection", () => {
  let dataDir: string;
  let service: ReturnType<typeof createHostedService>;
  let cookie: string;
  let modelApiStatus = 200;
  let decisionApiStatus = 200;
  const modelRequests: { path: string; method: string; authorization: string | null; body?: Record<string, unknown> }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    modelRequests.push({ path: url.pathname, method: init?.method ?? "GET", authorization: headers.get("authorization"), ...(body ? { body } : {}) });
    if (url.pathname === "/v1/models") {
      return Response.json({ data: [{ id: "startlux-decision-2b" }, { id: "qwen3-asr-1.7b" }] }, { status: modelApiStatus });
    }
    if (url.pathname === "/v1/decisions") {
      return Response.json({ model: "startlux-decision-2b", choice: "fit", score: 0.93, needs_review: false }, { status: decisionApiStatus });
    }
    return Response.json({ error: "unexpected route" }, { status: 404 });
  };

  const request = (path: string, method = "GET", body?: unknown, authenticated = true) => service.fetch(new Request(`${origin}${path}`, {
    method,
    headers: {
      origin,
      ...(authenticated && cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "vivic-decision-"));
    modelApiStatus = 200;
    decisionApiStatus = 200;
    modelRequests.length = 0;
    service = createHostedService({ origin, dataDir, inviteCode: "decision-test-invite", modelApiBaseUrl,
      allowLoopbackModelApi: true, fetchImpl, autoStartReminders: false });
    const registration = await request("/api/space/register", "POST", {
      invite: "decision-test-invite", username: "decision_test", password: "decision-test-password", deviceName: "Vitest",
    }, false);
    expect(registration.status).toBe(200);
    cookie = registration.headers.get("set-cookie")!.split(";")[0]!;
  });

  afterEach(async () => {
    await service.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("reports decision connectivity, classifies through the connected platform key, and disconnects", async () => {
    const before = await request("/api/space/models/status");
    expect(before.status).toBe(200);
    expect(await before.json()).toMatchObject({
      configured: false,
      decision: { configured: false, model: null, executionEnabled: false, protocol: "classification-only" },
    });
    const notConnected = await request("/api/space/models/classify", "POST", {
      input: "请显示全部卡片", model: "startlux-decision-2b", labels,
    });
    expect(notConnected.status).toBe(503);
    expect((await notConnected.json()).code).toBe("model-not-connected");

    const connected = await request("/api/space/models/connect", "POST", { apiKey: modelKey });
    expect(connected.status).toBe(200);
    expect(await (await request("/api/space/models/status")).json()).toMatchObject({
      configured: true, decision: { configured: false, model: null, executionEnabled: false },
    });
    const decisionConnected = await request("/api/space/models/decision/connect", "POST", { model: "startlux-decision-2b" });
    expect(decisionConnected.status).toBe(200);
    expect(await decisionConnected.json()).toMatchObject({ configured: true, model: "startlux-decision-2b", executionEnabled: false });
    const after = await request("/api/space/models/status");
    const status = await after.json();
    expect(status).toMatchObject({ configured: true, decision: { configured: true, model: "startlux-decision-2b", executionEnabled: false } });
    expect(JSON.stringify(status)).not.toContain(modelKey);

    const resultResponse = await request("/api/space/models/classify", "POST", {
      input: "请显示全部卡片", model: "startlux-decision-2b", labels,
    });
    expect(resultResponse.status).toBe(200);
    expect(await resultResponse.json()).toMatchObject({ model: "startlux-decision-2b", choice: "fit", score: 0.93, needs_review: false });
    expect(modelRequests.filter(call => call.path === "/v1/decisions")).toHaveLength(2);
    expect(modelRequests.at(-1)).toMatchObject({
      method: "POST", authorization: `Bearer ${modelKey}`,
      body: { model: "startlux-decision-2b", input: "请显示全部卡片", labels },
    });
    const mismatchedModel = await request("/api/space/models/classify", "POST", {
      input: "请显示全部卡片", model: "gliner2.5-multi-decide", labels,
    });
    expect(mismatchedModel.status).toBe(409);
    expect((await mismatchedModel.json()).code).toBe("decision-model-mismatch");
    expect(modelRequests.filter(call => call.path === "/v1/decisions")).toHaveLength(2);

    const decisionDisconnected = await request("/api/space/models/decision/disconnect", "POST", {});
    expect(decisionDisconnected.status).toBe(200);
    expect(await (await request("/api/space/models/status")).json()).toMatchObject({
      configured: true, decision: { configured: false, model: null, executionEnabled: false },
    });
    const decisionDisabled = await request("/api/space/models/classify", "POST", {
      input: "请显示全部卡片", model: "startlux-decision-2b", labels,
    });
    expect(decisionDisabled.status).toBe(503);
    expect((await decisionDisabled.json()).code).toBe("decision-model-not-connected");

    const disconnected = await request("/api/space/models/disconnect", "POST", {});
    expect(disconnected.status).toBe(200);
    expect(await (await request("/api/space/models/status")).json()).toMatchObject({
      configured: false, decision: { configured: false, model: null, executionEnabled: false },
    });
  });

  it("does not report or retain a decision connection when platform validation fails", async () => {
    modelApiStatus = 401;
    const response = await request("/api/space/models/connect", "POST", { apiKey: modelKey });
    expect(response.status).toBe(401);
    const status = await request("/api/space/models/status");
    expect(await status.json()).toMatchObject({ configured: false, decision: { configured: false } });
  });

  it("requires a platform key and a responding classifier before marking a decision model connected", async () => {
    const missingKey = await request("/api/space/models/decision/connect", "POST", { model: "startlux-decision-2b" });
    expect(missingKey.status).toBe(503);
    expect((await missingKey.json()).code).toBe("model-not-connected");

    await request("/api/space/models/connect", "POST", { apiKey: modelKey });
    decisionApiStatus = 503;
    const failedProbe = await request("/api/space/models/decision/connect", "POST", { model: "startlux-decision-2b" });
    expect(failedProbe.status).toBe(503);
    expect(await (await request("/api/space/models/status")).json()).toMatchObject({
      configured: true, decision: { configured: false, model: null, executionEnabled: false },
    });
  });

  it("rejects unsupported decision model ids without calling the classifier", async () => {
    await request("/api/space/models/connect", "POST", { apiKey: modelKey });
    const response = await request("/api/space/models/decision/connect", "POST", { model: "invented-model" });
    expect(response.status).toBe(400);
    expect(modelRequests.filter(call => call.path === "/v1/decisions")).toHaveLength(0);
  });

  it("requires an authenticated model session before exposing decision status", async () => {
    const response = await request("/api/space/models/status", "GET", undefined, false);
    expect(response.status).toBe(401);
    const decisionResponse = await request("/api/space/models/decision/connect", "POST", { model: "startlux-decision-2b" }, false);
    expect(decisionResponse.status).toBe(401);
  });
});
