import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { authed, emptyContext, testConfig } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

describe("invalid decision provider configuration", () => {
  it.each([
    { decisionProviderUrl: "http://192.168.1.10:8790/private" },
    { decisionProviderUrl: "http://127.0.0.1:8790/v1/chat/completions", decisionProviderProtocol: "local-chat" as const },
    { decisionProviderUrl: "http://127.0.0.1:8790/v1/chat/completions", decisionProviderProtocol: "local-chat" as const, decisionProviderKind: "local" as const },
    { decisionProviderUrl: "https://TEST-user:TEST-password@invalid.example/decide" },
    { decisionProviderUrl: "https://invalid.example/decide", decisionProviderFallbackUrl: "https://remote.example/decide" },
  ])("keeps the API and local commands available while reporting the configuration issue", async config => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn<typeof fetch>();
    const app = createApp({ config: testConfig({ ...config, decisionProviderToken: "TEST-private-bridge-token" }), fetchImpl });
    try {
      expect((await app.request("/healthz")).status).toBe(200);
      const status = await (await app.request("/api/decision/status", { headers: authed })).json();
      expect(status).toMatchObject({ enabled: false, configurationError: expect.stringContaining("配置无效") });
      const response = await app.request("/api/intent", { method: "POST", headers: authed,
        body: JSON.stringify({ text: "倒计时一分钟", canvasContext: emptyContext() }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ kind: "envelope", usedProvider: "rules" });
      expect(fetchImpl).not.toHaveBeenCalled();
      const surfaced = JSON.stringify({ status, warnings: warning.mock.calls });
      for (const secret of ["TEST-password", "192.168.1.10", "invalid.example", "remote.example", "TEST-private-bridge-token"]) {
        expect(surfaced).not.toContain(secret);
      }
      expect(warning).toHaveBeenCalledOnce();
    } finally { app.dispose(); }
  });
});
