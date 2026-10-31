import { describe, expect, it } from "vitest";
import { createSearchRoutes, type SearchEvidence } from "../src/search/index.js";

// Explicit opt-in; no .env loading, provider credentials, browser, listen() or local server.
describe.skipIf(process.env.VIVIC_SEARCH_LIVE !== "1")("live search diagnostics (no mocks)", () => {
  it("records real source evidence or an explicit BLOCKED result", async () => {
    const app = createSearchRoutes();
    const request = { query: "React Flow React canvas library" };
    const started = Date.now();
    const response = await app.request("/search", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
    });
    const body = await response.json() as { ok: boolean; results?: SearchEvidence[]; code?: string };
    console.info(JSON.stringify({ diagnostic: "real-search", at: new Date().toISOString(),
      status: response.status, elapsedMs: Date.now() - started, request,
      outcome: response.status === 200 ? "SEARCH_RESPONSE" : "BLOCKED", body }));
    if (response.status === 200) {
      expect(body.ok).toBe(true);
      expect(body.results!.length).toBeGreaterThan(0);
      for (const row of body.results!) expect(row).toMatchObject({
        title: expect.any(String), url: expect.stringMatching(/^https:\/\//),
        snippet: expect.any(String), fetchedAt: expect.any(String),
        provider: "pi-web-access/exa-mcp-keyless", readFullPage: false,
      });
    } else {
      expect([400, 429, 502, 503, 504]).toContain(response.status);
      expect(body.ok).toBe(false);
      expect(body.code).toMatch(/^search-/);
      expect(body).not.toHaveProperty("results");
    }
  }, 35_000);

  it("probes real fetch and public DNS/redirect/size/deadline boundaries without exemptions", async () => {
    for (const probe of [
      { name: "public-page", url: "https://example.com/", config: {} },
      { name: "private-literal", url: "https://127.0.0.1/", config: {} },
      { name: "private-dns", url: "https://127.0.0.1.nip.io/", config: {} },
      // httpbingo refuses this target upstream with 403 (verified 2026-10-24).
      // httpbin supplies a real 302 so Vivic's destination guard is exercised.
      { name: "private-redirect", url: "https://httpbin.org/redirect-to?url=https%3A%2F%2F127.0.0.1%2F", config: {} },
      { name: "byte-limit", url: "https://example.com/", config: { maxResponseBytes: 64 } },
      { name: "total-deadline", url: "https://example.com/", config: { fetchTimeoutMs: 1 } },
    ]) {
      const started = Date.now();
      const response = await createSearchRoutes({ config: probe.config }).request("/fetch", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: probe.url }),
      });
      const body = await response.json() as { ok: boolean; text?: string; trust?: string };
      console.info(JSON.stringify({ diagnostic: probe.name, at: new Date().toISOString(),
        status: response.status, elapsedMs: Date.now() - started,
        outcome: response.status === 200 ? "FETCH_RESPONSE" : "BLOCKED",
        body: body.ok ? { ...body, text: body.text!.slice(0, 120) } : body }));
      if (probe.name === "private-literal" || probe.name === "private-dns" || probe.name === "private-redirect") {
        expect(response.status).toBe(400);
        expect(body).toMatchObject({ ok: false, code: "search-blocked-url" });
      }
      // BLOCKED by the initial DNS guard does not count as exercising a later boundary.
      expect(response.status === 200 ? body.trust === "untrusted-web-data" : body.ok === false).toBe(true);
    }
  }, 90_000);
});
