import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, type LocalApiConfig } from "../src/config.js";
import { testConfig, TEST_TOKEN } from "./helpers.js";

const isolatedConfig = (env: NodeJS.ProcessEnv = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), "vivic-timeouts-"));
  try { return loadConfig({ VIVIC_LOCAL_TOKEN: TEST_TOKEN, ...env }, dir); }
  finally { rmSync(dir, { recursive: true, force: true }); }
};
describe("independent request budgets", () => {
  it("preserves the native StartLux protocol selection", () => {
    expect(isolatedConfig({ VIVIC_DECISION_PROVIDER_PROTOCOL: "startlux" }).decisionProviderProtocol).toBe("startlux");
    expect(isolatedConfig({ VIVIC_MANAGED_DECISION: "off" }).managedDecisionEnabled).toBe(false);
  });
  it("allows the dedicated daily origin while keeping tests and explicit origin overrides bounded", () => {
    const config = isolatedConfig();
    expect(config.allowedOrigins).toContain("http://localhost:5175");
    expect(config.allowedOrigins).toContain("http://127.0.0.1:5175");
    expect(config.allowedOrigins).toContain("http://localhost:5174");
    expect(config.allowedOrigins).not.toContain("http://localhost:5176");
    expect(isolatedConfig({ VIVIC_ALLOWED_ORIGINS: "http://localhost:5174" }).allowedOrigins).toEqual(["http://localhost:5174"]);
  });
  it("defaults to inference 60s, connection 30s and speech 15s", () => {
    expect(isolatedConfig()).toMatchObject({ requestTimeoutMs: 60_000,
      connectionTimeoutMs: 30_000, speechTimeoutMs: 15_000 });
  });
  it("overrides each budget independently", () => {
    expect(isolatedConfig({ VIVIC_REQUEST_TIMEOUT_MS: "28000" })).toMatchObject({
      requestTimeoutMs: 28_000, connectionTimeoutMs: 30_000, speechTimeoutMs: 15_000 });
    expect(isolatedConfig({ VIVIC_CONNECTION_TIMEOUT_MS: "3000", VIVIC_SPEECH_TIMEOUT_MS: "5000" })).toMatchObject({
      requestTimeoutMs: 60_000, connectionTimeoutMs: 3000, speechTimeoutMs: 5000 });
  });
  it.each(["NaN", "Infinity", "0", "-1", "", "0.5"])("rejects invalid override %j", (value) => {
    expect(isolatedConfig({ VIVIC_REQUEST_TIMEOUT_MS: value, VIVIC_CONNECTION_TIMEOUT_MS: value,
      VIVIC_SPEECH_TIMEOUT_MS: value })).toMatchObject({ requestTimeoutMs: 60_000,
      connectionTimeoutMs: 30_000, speechTimeoutMs: 15_000 });
  });
  it("caps overrides at the 90s turn limit", () => {
    expect(isolatedConfig({ VIVIC_REQUEST_TIMEOUT_MS: "900000" }).requestTimeoutMs).toBe(90_000);
  });
  it("keeps old configuration fixtures without new optional fields valid", () => {
    const old: LocalApiConfig = testConfig();
    expect(old.connectionTimeoutMs).toBeUndefined();
    expect(old.speechTimeoutMs).toBeUndefined();
  });
});
