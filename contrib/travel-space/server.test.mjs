import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createTravelServer } from "./server.mjs";
const ORIGIN = "https://travel.example.test";
async function fixture(options = {}) {
  const server = createTravelServer({ origin: ORIGIN, ...options });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  return { server, request: (pathname, init) => fetch(url + pathname, init), close: () => new Promise(resolve => server.close(resolve)) };
}
test("DEMO capability never claims live; page has restrictive headers", async () => {
  const f = await fixture(); try { const response = await f.request("/api/travel/capabilities"); assert.equal((await response.json()).liveEnabled, false); assert.match(response.headers.get("permissions-policy"), /microphone=\(\)/); assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/); } finally { await f.close(); }
});
test("reject cross-origin, missing sessions, and live even with valid isolated cookie", async () => {
  const f = await fixture(); try {
    assert.equal((await f.request("/api/travel/session", { method: "POST", headers: { origin: "https://other.test" } })).status, 403);
    assert.equal((await f.request("/api/travel/query", { method: "POST", headers: { origin: ORIGIN } })).status, 401);
    const a = await f.request("/api/travel/session", { method: "POST", headers: { origin: ORIGIN } });
    const b = await f.request("/api/travel/session", { method: "POST", headers: { origin: ORIGIN } });
    const cookie = a.headers.get("set-cookie"); assert.match(cookie, /HttpOnly; SameSite=Strict/); assert.match(cookie, /Secure/); assert.notEqual(cookie, b.headers.get("set-cookie"));
    const query = await f.request("/api/travel/query", { method: "POST", headers: { origin: ORIGIN, cookie: cookie.split(";")[0] } });
    assert.equal(query.status, 503); assert.equal((await query.json()).error, "live_not_configured");
  } finally { await f.close(); }
});
test("rate limiting and bounded session capacity reject excess requests", async () => {
  const f = await fixture({ requestLimit: 2, sessionLimit: 1 }); try {
    const init = { method: "POST", headers: { origin: ORIGIN } };
    assert.equal((await f.request("/api/travel/session", init)).status, 200);
    assert.equal((await f.request("/api/travel/session", init)).status, 503);
    assert.equal((await f.request("/api/travel/session", init)).status, 429);
  } finally { await f.close(); }
});
test("forbid traversal, dotfiles, request bodies and unrecognized routes", async () => {
  const f = await fixture(); try {
    assert.equal((await f.request("/.env")).status, 404);
    assert.equal((await f.request("/%2e%2e%5cpackage.json")).status, 404);
    assert.equal((await f.request("/api/travel/session", { method: "POST", headers: { origin: ORIGIN }, body: "{}" })).status, 400);
    assert.equal((await f.request("/api/unknown", { method: "POST", headers: { origin: ORIGIN } })).status, 404);
  } finally { await f.close(); }
});
