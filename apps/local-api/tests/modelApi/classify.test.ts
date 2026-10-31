import { describe, expect, it } from "vitest";
import { createModelApiClient } from "../../src/modelApi/index.js";

const baseUrl = "http://127.0.0.1:19441/v1";
const token = "test-platform-secret-key";
const labels = {
  fit: "显示全部卡片", restore: "恢复之前视图", focus: "聚焦一张卡片", delete: "删除卡片",
  expand: "展开便笺", collapse: "收起便笺", other: "不明确或其他操作",
};

interface ModelCall { path: string; authorization: string | null; body?: unknown }

function client(reply: () => Response, calls: ModelCall[] = []) {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ path: url.pathname, authorization: new Headers(init?.headers).get("authorization"), ...(body === undefined ? {} : { body }) });
    return reply();
  };
  return createModelApiClient({ baseUrl, token, fetchImpl, timeoutMs: 5_000, allowLoopbackHttp: true });
}

describe("model API 4B decision protocol", () => {
  it("sends the native state/questions body and maps choice/confidence to the existing result", async () => {
    const calls: ModelCall[] = [];
    const api = client(() => Response.json({ answers: { intent: { type: "choice", choice: "fit", confidence: 0.93 } } }), calls);
    const result = await api.classify("请显示全部卡片", { model: "startlux-decision-4b", labels });
    expect(result).toMatchObject({
      ok: true, value: {
        model: "startlux-decision-4b", choice: "fit", score: 0.93, needs_review: false,
        scoreKind: "startlux-4b-choice-confidence",
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      path: "/v1/decisions", authorization: `Bearer ${token}`,
      body: {
        model: "startlux-decision-4b", state: { user_message: "请显示全部卡片" },
        questions: { intent: { type: "choice", instructions: expect.any(String), criteria: labels } },
      },
    });
    // The old flat input/labels fields must not be sent to a native model.
    expect(calls[0]!.body).not.toHaveProperty("input");
    expect(calls[0]!.body).not.toHaveProperty("labels");
  });

  it("accepts the resident native probability distribution and flags abstention for review", async () => {
    const scores = { fit: 0.12, restore: 0.03, focus: 0.7, delete: 0.02, expand: 0.05, collapse: 0.03, other: 0.05 };
    const chosen = await client(() => Response.json({
      answers: { intent: { type: "choice", choice: "focus", probabilities: scores, none_probability: 0.05 } },
    })).classify("聚焦这张卡片", { model: "startlux-decision-4b", labels });
    expect(chosen).toMatchObject({ ok: true, value: { choice: "focus", score: 0.7, needs_review: true } });

    const abstained = await client(() => Response.json({
      answers: { intent: { type: "choice", choice: null, probabilities: scores, none_probability: 0.62 } },
    })).classify("随便看看", { model: "startlux-decision-4b", labels });
    expect(abstained).toMatchObject({ ok: true, value: { choice: null, score: 0.62, needs_review: true } });
  });

  it("keeps the 2B legacy input/labels protocol unchanged", async () => {
    const calls: ModelCall[] = [];
    const api = client(() => Response.json({ model: "startlux-decision-2b", choice: "fit", score: 0.91, needs_review: false }), calls);
    const result = await api.classify("请显示全部卡片", { model: "startlux-decision-2b", labels });
    expect(result).toMatchObject({ ok: true, value: { model: "startlux-decision-2b", choice: "fit", score: 0.91, scoreKind: "startlux-choice-score" } });
    expect(calls[0]!.body).toEqual({ model: "startlux-decision-2b", input: "请显示全部卡片", labels, threshold: 0.9 });
  });

  it("rejects an explicit protocol that contradicts the model without sending a request", async () => {
    const calls: ModelCall[] = [];
    const api = client(() => Response.json({}), calls);
    const fourB = await api.classify("请显示全部卡片", { model: "startlux-decision-4b", labels, protocol: "legacy" });
    expect(fourB).toMatchObject({ ok: false, error: { code: "protocol-mismatch" } });
    expect((fourB as { error: { message: string } }).error.message).toContain("StartLux 4B 只使用原生");
    const twoB = await api.classify("请显示全部卡片", { model: "startlux-decision-2b", labels, protocol: "native" });
    expect(twoB).toMatchObject({ ok: false, error: { code: "protocol-mismatch" } });
    expect(calls).toHaveLength(0);
  });

  it("rejects a reply from the other protocol instead of silently reparsing it", async () => {
    const fourB = await client(() => Response.json({ choice: "fit", score: 0.9, needs_review: false }))
      .classify("请显示全部卡片", { model: "startlux-decision-4b", labels });
    expect(fourB).toMatchObject({ ok: false, error: { code: "protocol-mismatch" } });

    const twoB = await client(() => Response.json({ answers: { intent: { type: "choice", choice: "fit", confidence: 0.9 } } }))
      .classify("请显示全部卡片", { model: "startlux-decision-2b", labels });
    expect(twoB).toMatchObject({ ok: false, error: { code: "protocol-mismatch" } });
  });

  it("rejects malformed native answers without guessing a choice", async () => {
    const missingConfidence = await client(() => Response.json({ answers: { intent: { type: "choice", choice: "fit" } } }))
      .classify("请显示全部卡片", { model: "startlux-decision-4b", labels });
    expect(missingConfidence).toMatchObject({ ok: false, error: { code: "invalid-response" } });

    const unlistedChoice = await client(() => Response.json({ answers: { intent: { type: "choice", choice: "invented", confidence: 0.9 } } }))
      .classify("请显示全部卡片", { model: "startlux-decision-4b", labels });
    expect(unlistedChoice).toMatchObject({ ok: false, error: { code: "invalid-response" } });
  });

  it("lists a platform-advertised 4B in status without exposing the credential", async () => {
    const api = client(() => Response.json({ data: [{ id: "startlux-decision-4b" }, { id: "qwen3-asr-1.7b" }] }));
    const result = await api.status();
    expect(result).toEqual({ ok: true, value: {
      reachable: true, models: [{ id: "startlux-decision-4b" }, { id: "qwen3-asr-1.7b" }],
      inference: "not-tested", quality: "not-tested",
    } });
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("does not echo the credential or the upstream body in a failure", async () => {
    const api = client(() => Response.json({ detail: `invalid ${token}` }, { status: 400 }));
    const result = await api.classify("请显示全部卡片", { model: "startlux-decision-4b", labels });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("invalid test-platform-secret-key");
  });
});
