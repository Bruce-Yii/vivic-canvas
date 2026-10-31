import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, STEPFUN_PLAN_BASE_URL } from "../src/config.js";
import { CredentialStore } from "../src/credentials.js";
import { createApp } from "../src/app.js";
import { chatJson, validateKey } from "../src/stepfun.js";
import { authed, chatOk, fetchStub, modelsOk, testConfig, TEST_TOKEN } from "./helpers.js";

const SECRET = "unit-plan-key-only";

describe("StepFun Plan routing and fail-closed model selection", () => {
  it("defaults to the official Plan base and preserves the stub override", () => {
    // Empty isolated directory: never read the user's .env files.
    const dir = mkdtempSync(path.join(tmpdir(), "vivic-plan-config-"));
    try {
      expect(loadConfig({ VIVIC_LOCAL_TOKEN: TEST_TOKEN }, dir).stepfunBaseUrl).toBe(STEPFUN_PLAN_BASE_URL);
      expect(loadConfig({ VIVIC_LOCAL_TOKEN: TEST_TOKEN, STEPFUN_BASE_URL: "http://127.0.0.1:8888/v1/" }, dir).stepfunBaseUrl)
        .toBe("http://127.0.0.1:8888/v1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the documented metadata endpoint and Plan endpoint for generation", async () => {
    const calls: string[] = [];
    const fetchImpl = fetchStub({
      "/models": () => modelsOk(["step-tts-mini", "step-3", "step-3.5-flash"]),
      "/chat/completions": (init) => {
        expect(JSON.parse(String(init?.body)).model).toBe("step-3.5-flash");
        expect(init?.redirect).toBe("error");
        return chatOk({ pong: true });
      },
    }, (url) => calls.push(url));
    const deps = { baseUrl: STEPFUN_PLAN_BASE_URL, fetchImpl };
    const validated = await validateKey(SECRET, deps);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const chat = await chatJson({ apiKey: SECRET, ...validated.value }, [], deps);
    expect(chat).toEqual({ ok: true, value: { pong: true } });
    expect(calls).toEqual([
      "https://api.stepfun.com/v1/models",
      "https://api.stepfun.com/step_plan/v1/chat/completions",
    ]);
  });

  it("media-only catalog clears stale credentials instead of connecting", async () => {
    const credentials = new CredentialStore();
    credentials.set({ apiKey: SECRET, models: ["step-3"], defaultModel: "step-3", checkedAt: "now" });
    const app = createApp({ config: testConfig(), credentials,
      fetchImpl: fetchStub({ "/models": () => modelsOk(["step-tts-mini", "stepaudio-2.5-tts"]) }),
    });
    const res = await app.request("/api/credentials/stepfun/validate", {
      method: "POST", headers: authed, body: JSON.stringify({ apiKey: SECRET }),
    });
    expect(await res.json()).toMatchObject({ ok: false, connected: false });
    expect(credentials.getSecret()).toBeUndefined();
  });

  it("the official Plan base never selects an unlisted legacy chat model", async () => {
    const result = await validateKey(SECRET, { baseUrl: STEPFUN_PLAN_BASE_URL,
      fetchImpl: fetchStub({ "/models": () => modelsOk(["step-3", "step-1-8k"]) }),
    });
    expect(result.ok).toBe(false);
  });

  it.each([null, { data: "not-an-array" }, { data: [null, { id: 123 }] }])(
    "malformed metadata %j fails without throwing", async (body) => {
      const result = await validateKey(SECRET, { baseUrl: STEPFUN_PLAN_BASE_URL,
        fetchImpl: fetchStub({ "/models": () => Response.json(body) }),
      });
      expect(result.ok).toBe(false);
    },
  );

  it("transport errors cannot echo the key in connection or planner responses", async () => {
    const fetchImpl = fetchStub({ "/models": () => { throw new Error(SECRET); },
      "/chat/completions": () => { throw new Error(SECRET); },
    });
    const deps = { baseUrl: STEPFUN_PLAN_BASE_URL, fetchImpl };
    expect(JSON.stringify(await validateKey(SECRET, deps))).not.toContain(SECRET);
    expect(JSON.stringify(await chatJson({ apiKey: SECRET, models: [], defaultModel: "step-3.5-flash", checkedAt: "now" }, [], deps)))
      .not.toContain(SECRET);
  });
});
