import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";

// Creates only fresh verification sessions and synthetic frames. No user canvas,
// model API, audio or real pairing code is read. Never print auth or frame data.
const options = Object.fromEntries(process.argv.slice(2).map(arg => { const i = arg.indexOf("="); return [i < 0 ? arg : arg.slice(0, i), i < 0 ? true : arg.slice(i + 1)]; }));
const origin = options["--origin"];
if (typeof origin !== "string" || new URL(origin).origin !== origin) throw new Error("Use --origin=https://host.");
const url = new URL(origin), loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("HTTPS is required outside loopback.");
const connectHost = options["--connect-host"];
if (connectHost && !["127.0.0.1", "::1"].includes(connectHost)) throw new Error("--connect-host is loopback only.");
const ca = typeof options["--ca"] === "string" ? await fs.readFile(options["--ca"]) : undefined;
const transport = url.protocol === "https:" ? https : http;
const native = { Origin: "https://appassets.androidplatform.net", "Sec-Fetch-Site": "cross-site" };
const report = { startedAt: new Date().toISOString(), origin, checks: [], liveModel: false, physicalPhone: false };
const cookies = [];
const request = (route, { cookie, body = {}, headers = {}, method = "POST" } = {}) => new Promise((resolve, reject) => {
  const data = ["OPTIONS", "DELETE", "GET"].includes(method) ? undefined : JSON.stringify(body);
  const req = transport.request(new URL(route, origin), { method, ca, rejectUnauthorized: true,
    ...(connectHost ? { hostname: connectHost, servername: url.hostname } : {}), headers: {
      Host: url.host, Origin: origin, "Sec-Fetch-Site": "same-origin", ...headers,
      ...(cookie ? { Cookie: cookie } : {}), ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
    } }, res => { let bytes = 0; const parts = [];
    res.on("data", chunk => { bytes += chunk.length; if (bytes > 256 * 1024) req.destroy(new Error("Probe response limit exceeded")); else parts.push(chunk); });
    res.on("end", () => { const text = Buffer.concat(parts).toString(); let json; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, json }); });
    res.on("error", reject);
  });
  req.setTimeout(28_000, () => req.destroy(new Error("Mobile poll timed out"))); req.on("error", reject); req.end(data);
});
const post = (role, action, body, cookie, headers) => request(`/api/online/mobile/${role}/${action}`, { body, cookie, headers });
const send = (peer, frame, cookie) => post(peer.role, "send", { connectionId: peer.connectionId, frame: { ...peer.scope, ...frame } }, cookie, peer.role === "phone" ? native : undefined);
const poll = (peer, cookie) => post(peer.role, "poll", { connectionId: peer.connectionId }, cookie, peer.role === "phone" ? native : undefined);
async function check(name, fn) { const started = Date.now(); try { await fn(); report.checks.push({ name, passed: true, durationMs: Date.now() - started }); console.info(`PASS ${name}`); } catch { report.checks.push({ name, passed: false, durationMs: Date.now() - started }); console.error(`FAIL ${name}`); } }
async function begin() { const r = await request("/api/online/session"); assert.equal(r.status, 200); const cookie = r.headers["set-cookie"]?.find(v => v.startsWith("__Host-vivic_online="))?.split(";")[0]; assert.ok(cookie); cookies.push(cookie); return cookie; }
function peer(role, r, deviceId) { assert.equal(r.status, 200); assert.equal(r.json?.ok, true); const welcome = r.json.frames?.find(f => f.type === "welcome"); assert.ok(welcome); assert.ok(r.json.connectionId); return { role, connectionId: r.json.connectionId, welcome, scope: { v: 1, sessionId: welcome.sessionId, epoch: welcome.epoch, deviceId } }; }
async function owner(cookie, deviceId) { const result = peer("owner", await post("owner", "connect", { frame: { v: 1, type: "hello", role: "computer", deviceId, deviceName: "Isolated Linux verification", accessKey: "online-cookie-owner-boundary" } }, cookie), deviceId); assert.equal((await send(result, { type: "owner.status", available: true }, cookie)).status, 200); return result; }
let a, b, computer, other, phone;
try {
  await check("two fresh owner sessions connect through TLS", async () => { a = await begin(); b = await begin(); computer = await owner(a, "probe-desktop-a"); other = await owner(b, "probe-desktop-b"); assert.notEqual(computer.welcome.sessionId, other.welcome.sessionId); });
  await check("native phone CORS preflight has no credentials", async () => { const r = await request("/api/online/mobile/phone/connect", { method: "OPTIONS", headers: { ...native, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } }); assert.equal(r.status, 204); assert.equal(r.headers["access-control-allow-origin"], native.Origin); assert.equal(r.headers["access-control-allow-credentials"], undefined); });
  await check("native phone pairs without owner cookie", async () => { const r = await post("phone", "connect", { frame: { v: 1, type: "hello", role: "mobile", deviceId: "probe-phone", deviceName: "Synthetic Android transport", pairCode: computer.welcome.pairCode } }, undefined, native); phone = peer("phone", r, "probe-phone"); assert.equal(r.headers["access-control-allow-origin"], native.Origin); assert.equal(r.headers["set-cookie"], undefined); assert.equal(r.headers["cache-control"], "no-store"); assert.notEqual(phone.welcome.token, computer.welcome.token); });
  await check("pairing code is single use", async () => { assert.equal((await post("phone", "connect", { frame: { v: 1, type: "hello", role: "mobile", deviceId: "probe-intruder", deviceName: "Synthetic duplicate", pairCode: computer.welcome.pairCode } }, undefined, native)).status, 401); });
  await check("other owner cookie cannot use first connection", async () => { assert.equal((await send(computer, { type: "pair.rotate" }, b)).status, 401); });
  await check("native phone origin cannot call owner or model API", async () => { assert.equal((await post("owner", "send", { connectionId: computer.connectionId, frame: { ...computer.scope, type: "pair.rotate" } }, a, native)).status, 403); assert.equal((await request("/api/intent", { cookie: a, headers: native })).status, 403); });
  await check("snapshot is delivered as a strict vertical preview", async () => { const frame = { type: "snapshot", sequence: 1, state: { computerName: "Verification", ownerAvailable: true, ownerEpoch: "probe-owner", activeCanvasId: "probe-canvas", version: 0, canvases: [{ id: "probe-canvas", title: "Space", version: 0 }], cards: [{ id: "probe-note", title: "Verification note", type: "note", pinned: false, preview: { kind: "text", body: "Synthetic content only" } }] } }; assert.equal((await send(computer, frame, a)).status, 200); const r = await poll(phone); assert.equal(r.status, 200); assert.equal(r.json.frames?.find(f => f.type === "snapshot")?.state.cards[0].preview.body, "Synthetic content only"); });
  await check("phone command and owner result cross reverse proxy", async () => { assert.equal((await send(phone, { type: "command", requestId: "probe-request", canvasId: "probe-canvas", ownerEpoch: "probe-owner", expectedVersion: 0, operation: { kind: "text.submit", text: "Synthetic verification command" } })).status, 200); const received = await poll(computer, a); assert.ok(received.json.frames?.some(f => f.type === "command" && f.requestId === "probe-request")); assert.equal((await send(computer, { type: "result", requestId: "probe-request", forDeviceId: "probe-phone", status: "succeeded", message: "Synthetic verification result" }, a)).status, 200); assert.ok((await poll(phone)).json.frames?.some(f => f.type === "result" && f.requestId === "probe-request")); });
  await check("idle mobile long poll survives 20 seconds TLS", async () => { await send(computer, { type: "heartbeat", at: Date.now() }, a); await poll(computer, a); const started = Date.now(); const r = await poll(phone); const elapsed = Date.now() - started; assert.equal(r.status, 200); assert.deepEqual(r.json.frames, []); assert.ok(elapsed >= 19_000 && elapsed < 27_000); });
  await check("owner revoke blocks phone reconnect and commands", async () => { assert.equal((await send(computer, { type: "revoke", targetDeviceId: "probe-phone" }, a)).status, 200); assert.ok((await poll(phone)).json.frames?.some(f => f.type === "revoked")); assert.equal((await send(phone, { type: "heartbeat", at: Date.now() })).status, 401); assert.equal((await post("phone", "connect", { frame: { v: 1, type: "hello", role: "mobile", deviceId: "probe-phone", deviceName: "Synthetic Android transport", token: phone.welcome.token } }, undefined, native)).status, 401); });
  await check("deleting owner cancels connected phone poll", async () => { await send(computer, { type: "pair.rotate" }, a); const code = (await poll(computer, a)).json.frames?.find(f => f.type === "pairing")?.pairCode; const replacement = peer("phone", await post("phone", "connect", { frame: { v: 1, type: "hello", role: "mobile", deviceId: "probe-phone-2", deviceName: "Synthetic second phone", pairCode: code } }, undefined, native), "probe-phone-2"); const pending = poll(replacement); await new Promise(resolve => setTimeout(resolve, 200)); assert.equal((await request("/api/online/session", { method: "DELETE", cookie: a })).status, 200); assert.equal((await pending).status, 401); assert.equal((await send(other, { type: "heartbeat", at: Date.now() }, b)).status, 200); });
} finally { await Promise.allSettled(cookies.map(cookie => request("/api/online/session", { method: "DELETE", cookie }))); report.finishedAt = new Date().toISOString(); report.passed = report.checks.every(c => c.passed); if (typeof options["--report"] === "string") await fs.writeFile(options["--report"], JSON.stringify(report, null, 2) + "\n"); }
if (!report.passed) process.exitCode = 1;
