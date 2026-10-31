import { describe, expect, it, vi } from "vitest";
import { HttpDecisionProvider, parseStartluxPrediction, startluxRequest } from "../src/decision/provider.js";
import { DECISION_ACTIONS } from "../src/decision/intent.js";
import { createApp } from "../src/app.js";
import { authed, testConfig } from "./helpers.js";

function reply(choice: string | null = "fit", none = .01) {
  return { answers: { intent: { type: "choice", choice, none_probability: none,
    probabilities: Object.fromEntries(DECISION_ACTIONS.map(id => [id, id === "fit" ? .94 : .01])) } },
    model: "StartLux-Decision-v1.1-4B-Instant", usage: { input_tokens: 100, output_tokens: 0 } };
}
describe("StartLux native decision protocol", () => {
  it("uses official typed questions with no generated reasoning or action capabilities", async () => {
    const fetchImpl = vi.fn(async () => Response.json(reply()));
    const provider = new HttpDecisionProvider("http://127.0.0.1:8090/v1/decisions", { name: "local", protocol: "startlux", fetchImpl, getToken: () => "test-secret" });
    expect(await provider.decide("显示全部卡片")).toMatchObject({ state: "accepted", choiceId: "fit", provider: "local" });
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toEqual(startluxRequest("显示全部卡片"));
    expect(init.headers).toMatchObject({ authorization: "Bearer test-secret" });
    expect(init.body).not.toContain("test-secret");
    expect(init.redirect).toBe("error");
  });
  it("defers a null choice or missing-option mass before accepting renormalised probabilities", () => {
    expect(parseStartluxPrediction(reply(null, .9), "显示全部卡片")).toMatchObject({ state: "deferred", reason: "no_suitable_choice" });
    expect(parseStartluxPrediction(reply("fit", .2), "显示全部卡片").state).toBe("deferred");
    expect(parseStartluxPrediction(reply("fit", .199), "显示全部卡片").state).toBe("accepted");
    expect(parseStartluxPrediction(reply(), "不要显示全部卡片").state).toBe("deferred");
  });
  it("rejects malformed, unscored or inconsistent answers", () => {
    const missing = reply(); delete (missing.answers.intent as Partial<typeof missing.answers.intent>).none_probability;
    const extra = reply(); (extra.answers.intent.probabilities as Record<string, number>).extra = 0;
    const badSum = reply(); badSum.answers.intent.probabilities.fit = .9;
    for (const value of [missing, extra, badSum, reply("expand"), reply("execute"), reply("fit", NaN), {}]) {
      expect(parseStartluxPrediction(value, "显示全部卡片").state).toBe("error");
    }
  });
  it("fails closed on service errors and preserves cancellation", async () => {
    const provider = new HttpDecisionProvider("http://127.0.0.1:8090/v1/decisions", { name: "local", protocol: "startlux", fetchImpl: async () => new Response("unavailable", { status: 503 }) });
    expect(await provider.decide("显示全部卡片")).toMatchObject({ state: "error", reason: "http_503" });
    expect(await provider.decide("显示全部卡片", AbortSignal.abort())).toEqual({ state: "cancelled" });
  });
  it("wires configuration through the real app without starting a managed model", async () => {
    const fetchImpl = vi.fn(async () => Response.json(reply()));
    const app = createApp({ config: testConfig({ decisionProviderUrl: "http://127.0.0.1:8090/v1/decisions", decisionProviderProtocol: "startlux", decisionProviderKind: "local" }), fetchImpl });
    try {
      const status = await app.request("/api/decision/status", { headers: authed });
      expect(await status.json()).toMatchObject({ mode: "provider" });
      const models = await app.request("/api/decision/models", { headers: authed });
      expect(await models.json()).toMatchObject({ defaultProfileId: "startlux-4b", recommendation: { basis: "vivic-estimate" } });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally { app.dispose(); }
  });
});
