import { describe, expect, it } from "vitest";
import { ActionEnvelopeSchema } from "@vivic/contracts";
import { CredentialStore } from "../../src/credentials.js";
import { runIntent } from "../../src/intent/pipeline.js";
import { emptyContext } from "../helpers.js";
import { chatJson, parseModelJson, validateKey } from "../../src/stepfun.js";
import { STEPFUN_PLAN_BASE_URL } from "../../src/config.js";

/**
 * LIVE StepFun roundtrip. BLOCKED until the user's key exists:
 *
 *   STEPFUN_KEY=sk-... pnpm --filter @vivic/local-api test:live
 *
 * No mocking anywhere in this file. A red test here means the provider call
 * really failed — never fake this green.
 */
const KEY = process.env.STEPFUN_KEY;
const live = KEY ? describe : describe.skip;

const BASE = process.env.STEPFUN_BASE_URL ?? STEPFUN_PLAN_BASE_URL;

live("StepFun live connection (requires STEPFUN_KEY)", () => {
  it("validateKey performs a real connection test", async () => {
    const res = await validateKey(KEY!, { baseUrl: BASE });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.models.length).toBeGreaterThan(0);
      console.log(
        "[live] models:",
        res.value.models.slice(0, 8).join(", "),
        "| default:",
        res.value.defaultModel,
      );
    }
  });

  it("one real intent roundtrip returns a schema-valid envelope", async () => {
    const validated = await validateKey(KEY!, { baseUrl: BASE });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const credentials = new CredentialStore();
    credentials.set({ apiKey: KEY!, ...validated.value });

    const result = await runIntent(
      {
        text: "帮我把左边的倒计时放大一点",
        canvasContext: {
          ...emptyContext(),
          cards: [
            {
              id: "cd-live",
              type: "CountdownCard",
              displayProps: {},
              sourceDataSummary: { targetAt: new Date(Date.now() + 600_000).toISOString() },
              layout: { x: 0, y: 0 },
            },
          ],
        },
      },
      { credentials, stepfun: { baseUrl: BASE, timeoutMs: 20_000 } },
    );
    console.log("[live] intent kind:", result.kind, "| message:", result.message ?? "-");
    expect(["envelope", "clarify"]).toContain(result.kind);
    if (result.kind === "envelope") {
      expect(ActionEnvelopeSchema.safeParse(result.envelope).success).toBe(true);
    }
  });

  it("chatJson JSON-mode is honored by the provider", async () => {
    const validated = await validateKey(KEY!, { baseUrl: BASE });
    if (!validated.ok) throw new Error(validated.error);
    const res = await chatJson(
      { apiKey: KEY!, ...validated.value },
      [
        { role: "system", content: "只输出 JSON。" },
        { role: "user", content: '返回 {"pong": true}' },
      ],
      { baseUrl: BASE, timeoutMs: 20_000 },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.value as { pong?: boolean }).pong).toBe(true);
    }
  });

  // F8: the only experiment that proves StepFun Plan accepts `stream:true`
  // together with `response_format: json_object`. Unit tests only cover a
  // synthetic SSE reader; every other live case above uses non-streaming.
  it("chatJson streams JSON mode and emits content deltas (real StepFun)", async () => {
    const validated = await validateKey(KEY!, { baseUrl: BASE });
    if (!validated.ok) throw new Error(validated.error);

    const startedAt = Date.now();
    const deltas: string[] = [];
    let firstDeltaMs: number | undefined;
    let streamResets = 0;
    const onTextDelta = Object.assign(
      (delta: string) => {
        firstDeltaMs ??= Date.now() - startedAt;
        deltas.push(delta);
      },
      {
        reset: () => {
          streamResets += 1;
        },
      },
    );

    const res = await chatJson(
      { apiKey: KEY!, ...validated.value },
      [
        { role: "system", content: "只输出 JSON。" },
        { role: "user", content: '返回 {"streamed": true}' },
      ],
      { baseUrl: BASE, timeoutMs: 20_000 },
      { onTextDelta },
    );

    const streamed = deltas.join("");
    console.log(
      "[live] stream deltas:",
      deltas.length,
      "| bytes:",
      streamed.length,
      "| resets:",
      streamResets,
      "| first delta ms:",
      firstDeltaMs ?? "-",
      "| total ms:",
      Date.now() - startedAt,
    );

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(`流式请求失败：${res.error}`);

    // `reset` runs only after a real `text/event-stream` response is received.
    // Zero deltas with `ok:true` means the provider ignored `stream:true`, or
    // the stream attempt failed and chatJson silently fell back to JSON.
    expect(streamResets).toBeGreaterThan(0);
    expect(deltas.length).toBeGreaterThan(0);
    expect(streamed.length).toBeGreaterThan(0);

    // Independently prove the accumulated stream is parseable JSON, then check
    // the contract the prompt asked for.
    let streamedValue: unknown;
    try {
      streamedValue = parseModelJson(streamed);
    } catch {
      throw new Error(
        "流式内容不是完整 JSON：流式读取可能已失败并回退到非流式（检查上游 SSE framing / finish_reason / [DONE]）",
      );
    }
    expect((streamedValue as { streamed?: boolean }).streamed).toBe(true);
    expect((res.value as { streamed?: boolean }).streamed).toBe(true);
  });
});
