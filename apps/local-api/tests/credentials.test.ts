import { describe, expect, it } from "vitest";
import { CredentialStore } from "../src/credentials.js";

const SECRET = "[redacted]";

const credential = {
  apiKey: SECRET,
  models: ["step-3", "step-1-8k"],
  defaultModel: "step-3",
  checkedAt: "2026-10-15T00:00:00.000Z",
};

describe("CredentialStore (memory-only)", () => {
  it("holds the key in memory and never serializes it via status()", () => {
    const store = new CredentialStore();
    store.set(credential);
    const status = store.status();
    expect(status.connected).toBe(true);
    expect(status.models).toContain("step-3");
    // C10 redaction: the raw key must not appear in any status payload.
    expect(JSON.stringify(status)).not.toContain(SECRET);
    expect(status).not.toHaveProperty("apiKey");
  });

  it("clear() disconnects and later intent flows fail closed", () => {
    const store = new CredentialStore();
    store.set(credential);
    store.clear();
    expect(store.getSecret()).toBeUndefined();
    expect(store.status().connected).toBe(false);
    expect(JSON.stringify(store.status())).not.toContain(SECRET);
  });

  it("starts disconnected", () => {
    const store = new CredentialStore();
    expect(store.status()).toEqual({
      name: "stepfun",
      connected: false,
      capabilities: ["structured", "chat"],
    });
  });
});
