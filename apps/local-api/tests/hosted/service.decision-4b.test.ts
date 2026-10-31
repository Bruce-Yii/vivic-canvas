import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHostedService } from "../../src/hosted/service.js";

const origin = "https://vivic.test";
const modelApiBaseUrl = "http://127.0.0.1:19442/v1";
const modelKey = "test-4b-platform-secret";
const labels = {
  fit: "显示全部卡片", restore: "恢复之前视图", focus: "聚焦一张卡片", delete: "删除卡片",
  expand: "展开便笺", collapse: "收起便笺", other: "不明确或其他操作",
};

type ReplyMode = "native" | "legacy" | "4b-legacy-reply" | "2b-native-reply" | "4b-rejected";

describe("hosted StartLux 4B decision connection", () => {
  let dataDir: string;
  let service: ReturnType<typeof createHostedService>;
  let cookie: string;
  let replyMode: ReplyMode = "native";
  const modelRequests: { path: string; method: string; authorization: string | null; body?: Record<string, unknown> }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    modelRequests.push({ path: url.pathname, method: init?.method ?? "GET", authorization: headers.get("authorization"), ...(body ? { body } : {}) });
    if (url.pathname === "/v1/models") {
      return Response.json({ data: [{ id: "startlux-decision-2b" }, { id: "startlux-decision-4b" }, { id: "gliner2.5-multi-decide" }, { id: "qwen3-asr-1.7b" }] });
    }
    if (url.pathname === "/v1/decisions") {
      if (replyMode === "4b-rejected") return Response.json({ error: "unsupported model" }, { status: 400 });
      const nativeRequest = Boolean(body && typeof body === "object" && "state" in body && "questions" in body);
      if (nativeRequest && replyMode === "4b-legacy-reply") {
        return Response.json({ model: "startlux-decision-2b", choice: "fit", score: 0.93, needs_review: false });
      }
      if (!nativeRequest && replyMode === "2b-native-reply") {
        return Response.json({ answers: { intent: { type: "choice", choice: "fit", confidence: 0.93 } } });
      }
      if (nativeRequest) {
        return Response.json({ answers: { intent: { type: "choice", choice: "fit", confidence: 0.93 } } });
      }
      return Response.json({ model: "startlux-decision-2b", choice: "fit", score: 0.93, needs_review: false });
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
    dataDir = await mkdtemp(join(tmpdir(), "vivic-decision-4b-"));
    replyMode = "native";
    modelRequests.length = 0;
    service = createHostedService({ origin, dataDir, inviteCode: "decision-4b-invite", modelApiBaseUrl,
      allowLoopbackModelApi: true, fetchImpl, autoStartReminders: false });
    const registration = await request("/api/space/register", "POST", {
      invite: "decision-4b-invite", username: "decision_4b_test", password: "decision-4b-test-password", deviceName: "Vitest",
    }, false);
    expect(registration.status).toBe(200);
    cookie = registration.headers.get("set-cookie")!.split(";")[0]!;
  });

  afterEach(async () => {
    await service.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("connects, reports and classifies through the native 4B protocol without exposing the key", async () => {
    await request("/api/space/models/connect", "POST", { apiKey: modelKey });
    const before = await (await request("/api/space/models/status")).json();
    expect(before).toMatchObject({
      configured: true,
      decision: { configured: false, model: null, wireProtocol: null, executionEnabled: false, protocol: "classification-only" },
    });

    const connected = await request("/api/space/models/decision/connect", "POST", { model: "startlux-decision-4b" });
    expect(connected.status).toBe(200);
    const connectedBody = await connected.json();
    expect(connectedBody).toMatchObject({
      configured: true, model: "startlux-decision-4b", wireProtocol: "native",
      executionEnabled: false, protocol: "classification-only",
      probe: { choice: "fit", score: 0.93, needsReview: false },
    });
    expect(JSON.stringify(connectedBody)).not.toContain(modelKey);

    const statusResponse = await request("/api/space/models/status");
    const status = await statusResponse.json();
    expect(status).toMatchObject({
      configured: true,
      decision: { configured: true, model: "startlux-decision-4b", wireProtocol: "native", executionEnabled: false, protocol: "classification-only" },
    });
    expect(JSON.stringify(status)).not.toContain(modelKey);

    const classified = await request("/api/space/models/classify", "POST", { input: "请显示全部卡片", model: "startlux-decision-4b", labels });
    expect(classified.status).toBe(200);
    const classifiedBody = await classified.json();
    expect(classifiedBody).toMatchObject({ model: "startlux-decision-4b", choice: "fit", score: 0.93, needs_review: false });
    expect(JSON.stringify(classifiedBody)).not.toContain(modelKey);

    const decisionCalls = modelRequests.filter(call => call.path === "/v1/decisions");
    expect(decisionCalls).toHaveLength(2);
    expect(decisionCalls[0]!.body).toMatchObject({
      model: "startlux-decision-4b",
      state: { user_message: "请把所有卡片显示在一屏里" },
      questions: { intent: { type: "choice", instructions: expect.any(String), criteria: expect.objectContaining({ fit: expect.any(String), other: expect.any(String) }) } },
    });
    expect(decisionCalls[1]!.body).toEqual({
      model: "startlux-decision-4b",
      state: { user_message: "请显示全部卡片" },
      questions: { intent: { type: "choice", instructions: expect.any(String), criteria: labels } },
    });
    for (const call of decisionCalls) {
      expect(call.authorization).toBe(`Bearer ${modelKey}`);
      expect(call.body).not.toHaveProperty("input");
      expect(call.body).not.toHaveProperty("labels");
    }

    const wrongModel = await request("/api/space/models/classify", "POST", { input: "请显示全部卡片", model: "startlux-decision-2b", labels });
    expect(wrongModel.status).toBe(409);
    expect((await wrongModel.json()).code).toBe("decision-model-mismatch");
    expect(modelRequests.filter(call => call.path === "/v1/decisions")).toHaveLength(2);

    const disconnected = await request("/api/space/models/decision/disconnect", "POST", {});
    expect(disconnected.status).toBe(200);
    expect(await (await request("/api/space/models/status")).json()).toMatchObject({
      decision: { configured: false, model: null, wireProtocol: null, executionEnabled: false },
    });
  });

  it("keeps 2B on the legacy protocol and allows an explicit switch to 4B", async () => {
    await request("/api/space/models/connect", "POST", { apiKey: modelKey });
    const connected = await request("/api/space/models/decision/connect", "POST", { model: "startlux-decision-2b" });
    expect(connected.status).toBe(200);
    expect(await connected.json()).toMatchObject({ configured: true, model: "startlux-decision-2b", wireProtocol: "legacy", executionEnabled: false });
    expect(modelRequests.at(-1)!.body).toEqual({
      model: "startlux-decision-2b", input: "请把所有卡片显示在一屏里",
      labels: {
        fit: "在一屏显示全部卡片", restore: "恢复之前的画布视图", focus: "聚焦一张卡片", delete: "删除卡片",
        expand: "展开便笺并查看全文", collapse: "收起便笺只显示摘要", other: "不明确、否定、复合或其他要求",
      },
      threshold: 0.9,
    });

    const classified = await request("/api/space/models/classify", "POST", { input: "请显示全部卡片", model: "startlux-decision-2b", labels });
    expect(classified.status).toBe(200);
    expect(await classified.json()).toMatchObject({ model: "startlux-decision-2b", choice: "fit", score: 0.93, needs_review: false, scoreKind: "startlux-choice-score" });

    const switched = await request("/api/space/models/decision/connect", "POST", { model: "startlux-decision-4b" });
    expect(switched.status).toBe(200);
    expect(await (await request("/api/space/models/status")).json()).toMatchObject({
      decision: { configured: true, model: "startlux-decision-4b", wireProtocol: "native", executionEnabled: false },
    });
  });

  it("rejects a 4B connection when the platform answers with the legacy protocol", async () => {
    replyMode = "4b-legacy-reply";
    await request("/api/space/models/connect", "POST", { apiKey: modelKey });
    const response = await request("/api/space/models/decision/connect", "POST", { model: "startlux-decision-4b" });
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, code: "decision-native-protocol-unsupported" });
    expect(body.message).toContain("未连接");
    expect(JSON.stringify(body)).not.toContain(modelKey);
    expect(modelRequests.filter(call => call.path === "/v1/decisions")).toHaveLength(1);
    expect(await (await request("/api/space/models/status")).json()).toMatchObject({
      decision: { configured: false, model: null, wireProtocol: null, executionEnabled: false },
    });
  });

  it("rejects a 4B connection when the platform refuses the native body", async () => {
    replyMode = "4b-rejected";
    await request("/api/space/models/connect", "POST", { apiKey: modelKey });
    const response = await request("/api/space/models/decision/connect", "POST", { model: "startlux-decision-4b" });
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, code: "decision-native-protocol-unsupported" });
    expect(body.message).toContain("不会静默改用旧协议");
    expect(await (await request("/api/space/models/status")).json()).toMatchObject({ decision: { configured: false, model: null } });
  });

  it("rejects a 2B connection when the platform answers with the 4B native protocol", async () => {
    replyMode = "2b-native-reply";
    await request("/api/space/models/connect", "POST", { apiKey: modelKey });
    const response = await request("/api/space/models/decision/connect", "POST", { model: "startlux-decision-2b" });
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, code: "decision-protocol-mismatch" });
    expect(body.message).toContain("不会静默改用 4B");
    expect(modelRequests.filter(call => call.path === "/v1/decisions")).toHaveLength(1);
    expect(await (await request("/api/space/models/status")).json()).toMatchObject({ decision: { configured: false, model: null } });
  });

  it("does not accept 4B before a platform key is configured", async () => {
    const response = await request("/api/space/models/decision/connect", "POST", { model: "startlux-decision-4b" });
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("model-not-connected");
    expect(modelRequests.filter(call => call.path === "/v1/decisions")).toHaveLength(0);
  });
});
