import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";

// Non-invasive HTTP checks. Cookies exist only in memory and are destroyed at
// completion. Never accept a model credential or print a response body/header.
const options = Object.fromEntries(process.argv.slice(2).map(arg => {
  const i = arg.indexOf("=");
  return [i < 0 ? arg : arg.slice(0, i), i < 0 ? true : arg.slice(i + 1)];
}));
const origin = options["--origin"];
if (typeof origin !== "string" || new URL(origin).origin !== origin) throw new Error("Use --origin=https://host (no trailing slash).");
const url = new URL(origin);
const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("HTTPS is required outside loopback.");
const connectHost = options["--connect-host"];
if (connectHost && !["127.0.0.1", "::1"].includes(connectHost)) throw new Error("--connect-host may only target loopback.");
const ca = typeof options["--ca"] === "string" ? await fs.readFile(options["--ca"]) : undefined;
const transport = url.protocol === "https:" ? https : http;
const report = { startedAt: new Date().toISOString(), origin, checks: [], fixture: false, liveModel: false };
function request(route, { method = "GET", cookie, body, headers = {}, timeout = 30_000, onChunk } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = transport.request(new URL(route, origin), { method,
      ...(connectHost ? { hostname: connectHost, servername: url.hostname } : {}), ca,
      headers: { Host: url.host, Origin: origin, "Sec-Fetch-Site": "same-origin", ...headers,
        ...(cookie ? { Cookie: cookie } : {}), ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}) },
      rejectUnauthorized: true,
    }, res => {
      let bytes = 0; const chunks = [];
      res.on("data", chunk => { onChunk?.(); bytes += chunk.length; if (bytes > 1024 * 1024) req.destroy(new Error("Probe response exceeded limit")); else chunks.push(chunk); });
      res.on("end", () => { const text = Buffer.concat(chunks).toString(); let json; try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json }); });
      res.on("error", reject);
    });
    req.setTimeout(timeout, () => req.destroy(new Error("Probe request timed out")));
    req.on("error", reject); req.end(data);
  });
}
async function check(name, fn) {
  const started = Date.now();
  try { await fn(); report.checks.push({ name, passed: true, durationMs: Date.now() - started }); console.info(`PASS ${name}`); }
  catch { report.checks.push({ name, passed: false, durationMs: Date.now() - started }); console.error(`FAIL ${name}`); }
}
const cookies = [];
const begin = async () => {
  const result = await request("/api/online/session", { method: "POST", body: {} });
  assert.equal(result.status, 200);
  const header = result.headers["set-cookie"]?.find(v => v.startsWith("__Host-vivic_online="));
  assert.ok(header); assert.match(header, /; Path=\/;.*HttpOnly; Secure; SameSite=Strict/); assert.doesNotMatch(header, /Domain=/i);
  const cookie = header.split(";")[0]; cookies.push(cookie); return cookie;
};
let a, b;
try {
  await check("health service identity", async () => { const r = await request("/healthz"); assert.equal(r.status, 200); assert.equal(r.json?.service, "vivic-online-api"); });
  if (!options["--fixture"]) await check("online and remote documents plus Hark styles are served", async () => {
    const page = await request("/"); assert.equal(page.status, 200); assert.match(page.text, /<div id="root"><\/div>/);
    for (const route of ["/remote", "/remote/", "/remote/index.html"]) {
      const remote = await request(route); assert.equal(remote.status, 200); assert.match(remote.text, /<div id="root"><\/div>/);
    }
    const style = page.text.match(/href="(\/assets\/HarkPrimitives-[^"/]+\.css)"/)?.[1]; assert.ok(style);
    const asset = await request(style); assert.equal(asset.status, 200); assert.match(asset.headers["content-type"] ?? "", /text\/css/); assert.ok(asset.text.length > 100);
    assert.match(asset.headers["cache-control"] ?? "", /immutable/);
  });
  await check("online runtime metadata", async () => { const r = await request("/api/runtime"); assert.equal(r.status, 200); assert.equal(r.json?.mode, "online"); assert.equal(r.json?.session, "missing"); assert.equal(r.headers["cache-control"], "no-store"); });
  await check("independent secure host-only cookies", async () => { a = await begin(); b = await begin(); assert.notEqual(a, b); });
  await check("missing cookie is rejected", async () => { assert.equal((await request("/api/providers/status")).status, 401); });
  await check("same-origin sessions are ready without saved keys", async () => {
    for (const cookie of [a, b]) { assert.ok(cookie); const r = await request("/api/providers/status", { cookie }); assert.equal(r.status, 200); assert.equal(r.headers["cache-control"], "no-store"); assert.equal(r.json?.providers?.[0]?.connected, false); }
  });
  await check("cross-origin mutation is rejected", async () => { assert.equal((await request("/api/online/session", { method: "POST", body: {}, headers: { Origin: "https://probe-attacker.invalid", "Sec-Fetch-Site": "cross-site" } })).status, 403); });
  await check("browser bearer bypass is rejected", async () => { assert.equal((await request("/api/providers/status", { cookie: a, headers: { Authorization: "Bearer TEST-not-a-session" } })).status, 400); });
  await check("local launcher routes are unavailable", async () => { assert.equal((await request("/api/decision/prepare", { method: "POST", cookie: a, body: {} })).status, 404); });
  await check("real built-in intent stream reaches client", async () => {
    const r = await request("/api/intent/stream", { method: "POST", cookie: a, body: { text: "新建便笺：隔离部署验收", canvasContext: { canvasId: "online-probe", stage: "WORKSPACE", viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], cards: [] } } });
    assert.equal(r.status, 200); assert.match(r.headers["content-type"] ?? "", /text\/event-stream/); assert.match(r.text, /event: result/); assert.match(r.text, /card\.create/);
  });
  if (options["--fixture"]) {
    const r = await request("/__verification/identity");
    assert.equal(r.json?.fixture, "vivic-real-online-app-test-upstream"); report.fixture = true;
    await check("fixture key stays in session A only", async () => {
      const v = await request("/api/credentials/stepfun/validate", { method: "POST", cookie: a, body: { apiKey: "TEST-online-probe-session-A" } });
      assert.equal(v.status, 200); assert.equal(v.json?.connected, true);
      assert.equal((await request("/api/providers/status", { cookie: a })).json?.providers?.[0]?.connected, true);
      assert.equal((await request("/api/providers/status", { cookie: b })).json?.providers?.[0]?.connected, false);
    });
    await check("fixture session B survives A disconnect", async () => {
      assert.equal((await request("/api/credentials/stepfun/validate", { method: "POST", cookie: b, body: { apiKey: "TEST-online-probe-session-B" } })).json?.connected, true);
      assert.equal((await request("/api/credentials/stepfun/disconnect", { method: "POST", cookie: a, body: {} })).status, 200);
      const r = await request("/api/providers/status", { cookie: b }); assert.equal(r.json?.providers?.[0]?.connected, true); assert.doesNotMatch(r.text, /TEST-online-probe|Bearer/);
    });
    await check("fixture SSE accepted event arrives before delayed model result", async () => {
      const started = Date.now(); let first = 0;
      const r = await request("/api/intent/stream", { method: "POST", cookie: b,
        onChunk() { first ||= Date.now() - started; },
        body: { text: "请分析 ONLINE_PROXY_STREAM_PROBE 的项目进度，并给我一份新的计划", canvasContext: { canvasId: "online-stream-probe", stage: "WORKSPACE", viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], cards: [] } },
      });
      const elapsed = Date.now() - started;
      assert.equal(r.status, 200); assert.match(r.text, /event: accepted/); assert.match(r.text, /event: result/);
      assert.ok(elapsed >= 800); assert.ok(first < elapsed - 500);
    });
    await check("fixture idle expiration forgets credentials", async () => {
      assert.equal((await request("/__verification/advance", { method: "POST", body: {} })).status, 200);
      assert.equal((await request("/api/providers/status", { cookie: b })).status, 401);
      const fresh = await begin(); assert.equal((await request("/api/providers/status", { cookie: fresh })).json?.providers?.[0]?.connected, false);
    });
  }
  await check("deleting A does not delete B", async () => {
    a = await begin(); b = await begin();
    assert.equal((await request("/api/online/session", { method: "DELETE", cookie: a })).status, 200);
    assert.equal((await request("/api/providers/status", { cookie: a })).status, 401);
    assert.equal((await request("/api/providers/status", { cookie: b })).status, 200);
  });
} finally {
  await Promise.allSettled(cookies.map(cookie => request("/api/online/session", { method: "DELETE", cookie })));
  report.finishedAt = new Date().toISOString(); report.passed = report.checks.every(c => c.passed);
  if (typeof options["--report"] === "string") await fs.writeFile(options["--report"], JSON.stringify(report, null, 2) + "\n");
}
if (!report.passed) process.exitCode = 1;
