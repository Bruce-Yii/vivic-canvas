import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { MobileSessionBroker } from "../src/mobile/session.js";
import { authed, testConfig } from "./helpers.js";
describe("private local mobile bootstrap", () => {
  it("requires local authorization and keeps missing provisioning separate from an active connection", async () => {
    const app = createApp({ config: testConfig(), mobileBroker: new MobileSessionBroker("/nonexistent/vivic-relay-fixture.json") });
    try {
      expect((await app.request("/api/mobile/status")).status).toBe(401);
      expect((await app.request("/api/mobile/session", { method: "POST" })).status).toBe(401);
      const status = await app.request("/api/mobile/status", { headers: authed });
      expect(await status.json()).toEqual({ configured: false, mobileUrl: null });
      expect(status.headers.get("cache-control")).toBe("no-store");
      const result = await app.request("/api/mobile/session", { method: "POST", headers: authed });
      expect(result.status).toBe(503);
      expect(await result.text()).not.toContain("nonexistent");
    } finally { app.dispose(); }
  });
});
