import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createRelayServer, type RelayOptions } from "../relay.js";
import type { Frame, Welcome } from "../protocol.js";

const origin = "http://127.0.0.1:5174";
const admissionSecret = "independent-test-relay-admission-secret";
const resources: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of resources.splice(0).reverse()) await close(); });
class Socket {
  frames: Frame[] = [];
  private listeners = new Set<() => void>();
  constructor(readonly ws: WebSocket) {
    ws.on("message", data => { this.frames.push(JSON.parse(data.toString()) as Frame); this.listeners.forEach(f => f()); });
  }
  send(frame: unknown) { this.ws.send(JSON.stringify(frame)); }
  async take<T extends Frame["type"]>(type: T): Promise<Extract<Frame, { type: T }>> {
    const take = () => { const index = this.frames.findIndex(f => f.type === type); return index < 0 ? undefined : this.frames.splice(index, 1)[0] as Extract<Frame, { type: T }>; };
    const current = take(); if (current) return current;
    return new Promise((resolve, reject) => {
      const done = () => { const f = take(); if (f) { clearTimeout(timer); this.listeners.delete(done); resolve(f); } };
      const timer = setTimeout(() => { this.listeners.delete(done); reject(new Error(`No ${type} frame`)); }, 2000);
      this.listeners.add(done);
    });
  }
}
const scoped = (w: Welcome) => ({ v: 1, sessionId: w.sessionId, deviceId: w.deviceId, epoch: w.epoch });
const command = (w: Welcome, requestId = "request_1") => ({ ...scoped(w), type: "command", requestId, canvasId: "canvas_1", ownerEpoch: "owner_epoch_1", expectedVersion: 0, operation: { kind: "text.submit", text: "创建便笺" } });
async function setup(extra: Partial<RelayOptions> = {}) {
  const relay = createRelayServer({ admissionSecret, allowedOrigins: [origin], ...extra });
  resources.push(() => relay.close());
  const address = await relay.listen(0);
  const url = `ws://127.0.0.1:${address.port}/relay`;
  const connect = async (target = url, requestOrigin = origin, headers: Record<string, string> = {}) => {
    const ws = new WebSocket(target, { origin: requestOrigin, headers });
    const socket = new Socket(ws);
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    return socket;
  };
  const computer = async (deviceId = "computer_1") => {
    const socket = await connect(); socket.send({ v: 1, type: "hello", role: "computer", deviceId, deviceName: "我的电脑", accessKey: admissionSecret });
    const welcome = await socket.take("welcome");
    socket.send({ ...scoped(welcome), type: "owner.status", available: true });
    socket.send({ ...scoped(welcome), type: "heartbeat", at: 1 }); await socket.take("pong");
    return { socket, welcome };
  };
  const mobile = async (pairCode: string, deviceId = "mobile_1") => {
    const socket = await connect(); socket.send({ v: 1, type: "hello", role: "mobile", deviceId, deviceName: "我的手机", pairCode });
    const welcome = await socket.take("welcome"); return { socket, welcome };
  };
  return { relay, connect, computer, mobile, url };
}

describe("ephemeral authenticated WebSocket relay", () => {
  it("requires a dedicated admission secret and explicit origins", () => {
    expect(() => createRelayServer({ admissionSecret: "short", allowedOrigins: [origin] })).toThrow("32");
    expect(() => createRelayServer({ admissionSecret, allowedOrigins: ["*"] })).toThrow("origins");
    expect(() => createRelayServer({ admissionSecret, allowedOrigins: [origin], publicMode: true })).toThrow("HTTPS");
    expect(() => createRelayServer({ admissionSecret, allowedOrigins: ["https://console.example.test"], publicMode: true })).toThrow("trusted proxy");
    expect(() => createRelayServer({ admissionSecret, allowedOrigins: [origin], trustedProxyIps: ["127.0.0.0/8"] })).toThrow("exact IP");
  });
  it("rejects foreign origins and query-string credentials before upgrading", async () => {
    const { connect, url } = await setup();
    await expect(connect(url, "https://attacker.invalid")).rejects.toThrow("403");
    await expect(connect(`${url}?token=must-not-be-accepted`)).rejects.toThrow("403");
  });
  it("allows explicitly provisioned desktop loopback origins while public origins still require HTTPS", async () => {
    const relay = createRelayServer({ admissionSecret, allowedOrigins: ["http://127.0.0.1:18787", "https://console.example.test"],
      publicMode: true, allowLoopbackOrigins: true, trustedProxyIps: ["127.0.0.1"] });
    resources.push(() => relay.close());
    const address = await relay.listen(0);
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/relay`, { origin: "http://127.0.0.1:18787",
      headers: { "x-forwarded-for": "203.0.113.4", "x-forwarded-proto": "https" } });
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    socket.close();
    expect(() => createRelayServer({ admissionSecret, allowedOrigins: ["http://attacker.invalid"], publicMode: true,
      allowLoopbackOrigins: true, trustedProxyIps: ["127.0.0.1"] })).toThrow("HTTPS");
  });
  it("keeps plaintext upstream on loopback and requires the trusted TLS proxy header in public mode", async () => {
    const relay = createRelayServer({ admissionSecret, allowedOrigins: ["https://console.example.test"], publicMode: true, trustedProxyIps: ["127.0.0.1"] });
    resources.push(() => relay.close());
    await expect(relay.listen(0, "0.0.0.0")).rejects.toThrow("loopback");
    const address = await relay.listen(0); const url = `ws://127.0.0.1:${address.port}/relay`;
    for (const proto of [undefined, "http", "https, http"]) {
      const insecure = new WebSocket(url, { origin: "https://console.example.test", headers: {
        "X-Forwarded-For": "198.51.100.1", ...(proto ? { "X-Forwarded-Proto": proto } : {}),
      } });
      await expect(new Promise((resolve, reject) => { insecure.once("open", resolve); insecure.once("error", reject); })).rejects.toThrow("403");
    }
    // A reverse-proxy upstream simulation; this test does not claim an actual TLS deployment.
    const trusted = new WebSocket(url, { origin: "https://console.example.test", headers: { "X-Forwarded-Proto": "https", "X-Forwarded-For": "198.51.100.1" } });
    await new Promise<void>((resolve, reject) => { trusted.once("open", resolve); trusted.once("error", reject); });
    trusted.close();
  });
  it("rejects spoofed public proxy headers from an untrusted peer", async () => {
    const httpsOrigin = "https://console.example.test";
    const { connect, url } = await setup({ allowedOrigins: [httpsOrigin], publicMode: true, trustedProxyIps: ["127.0.0.2"] });
    await expect(connect(url, httpsOrigin, { "X-Forwarded-Proto": "https", "X-Forwarded-For": "198.51.100.1" })).rejects.toThrow("403");
  });
  it("rejects missing, malformed, or chained client identities from a trusted proxy", async () => {
    const { connect, url } = await setup({ trustedProxyIps: ["127.0.0.1"] });
    for (const forwarded of [undefined, "not-an-ip", "198.51.100.1, 198.51.100.2", "198.51.100.1:443"]) {
      await expect(connect(url, origin, forwarded ? { "X-Forwarded-For": forwarded } : {})).rejects.toThrow("403");
    }
  });
  it("ignores untrusted forwarded identities so rotating spoofed headers cannot bypass authentication limits", async () => {
    const { connect, url } = await setup();
    const first = await connect(url, origin, { "X-Forwarded-For": "198.51.100.1" });
    const hello = { v: 1, type: "hello", role: "mobile", deviceId: "mobile", deviceName: "手机", pairCode: "WRONGCODE" };
    for (let i = 0; i < 20; i++) { first.send(hello); expect((await first.take("error")).code).toBe("invalid-pairing"); }
    const spoofed = await connect(url, origin, { "X-Forwarded-For": "198.51.100.2" });
    spoofed.send(hello); expect((await spoofed.take("error")).code).toBe("rate-limit");
  });
  it("limits each proxied client separately and preserves its bucket across connections and mapped IP spellings", async () => {
    const { connect, url } = await setup({ trustedProxyIps: ["::ffff:127.0.0.1"] });
    const first = await connect(url, origin, { "X-Forwarded-For": "198.51.100.1" });
    const hello = { v: 1, type: "hello", role: "mobile", deviceId: "mobile", deviceName: "手机", pairCode: "WRONGCODE" };
    for (let i = 0; i < 20; i++) { first.send(hello); expect((await first.take("error")).code).toBe("invalid-pairing"); }
    const sameClient = await connect(url, origin, { "X-Forwarded-For": "::ffff:198.51.100.1" });
    sameClient.send(hello); expect((await sameClient.take("error")).code).toBe("rate-limit");
    const secondClient = await connect(url, origin, { "X-Forwarded-For": "198.51.100.2" });
    secondClient.send(hello); expect((await secondClient.take("error")).code).toBe("invalid-pairing");
  });
  it("does not register a computer with a wrong admission secret or unauthenticated command", async () => {
    const { connect } = await setup(); const s = await connect();
    s.send({ v: 1, type: "hello", role: "computer", deviceId: "computer", deviceName: "电脑", accessKey: "not-the-relay-secret-at-all" });
    expect((await s.take("error")).code).toBe("unauthorized");
    s.send({ v: 1, type: "snapshot.request", sessionId: "fake", deviceId: "fake", epoch: "fake" });
    expect((await s.take("error")).code).toBe("unauthorized");
  });
  it("pairs once, binds a trusted controller identity, and forwards commands with transport ACK only", async () => {
    const { computer, mobile, connect } = await setup(); const c = await computer(); const m = await mobile(c.welcome.pairCode!);
    const joined = await c.socket.take("controller"); expect(joined.deviceId).toBe(m.welcome.deviceId);
    expect(joined.permissions).toEqual(["text.submit", "canvas.switch", "card.pin", "card.surface", "file.read"]);
    m.socket.send(command(m.welcome));
    expect(await c.socket.take("command")).toEqual(command(m.welcome));
    expect((await m.socket.take("accepted")).requestId).toBe("request_1");
    expect(m.socket.frames.some(f => f.type === "result")).toBe(false);
    const second = await connect(); second.send({ v: 1, type: "hello", role: "mobile", deviceId: "mobile_2", deviceName: "手机2", pairCode: c.welcome.pairCode });
    expect((await second.take("error")).code).toBe("invalid-pairing");
  });
  it("rejects expired pairing and rotates to a fresh one without extending session lifetime", async () => {
    let clock = 100_000; const { computer, mobile, connect } = await setup({ now: () => clock, pairTtlMs: 100 }); const c = await computer();
    clock += 101; const invalid = await connect(); invalid.send({ v: 1, type: "hello", role: "mobile", deviceId: "mobile_old", deviceName: "手机", pairCode: c.welcome.pairCode });
    expect((await invalid.take("error")).code).toBe("invalid-pairing");
    c.socket.send({ ...scoped(c.welcome), type: "pair.rotate" }); const pair = await c.socket.take("pairing");
    expect(pair.pairCode).not.toBe(c.welcome.pairCode);
    const m = await mobile(pair.pairCode); expect(m.welcome.expiresAt).toBe(c.welcome.expiresAt);
  });
  it("rejects schema overflow, injected fields, wrong session/epoch/device, and mobile result forgery", async () => {
    const { computer, mobile } = await setup(); const c = await computer(); const m = await mobile(c.welcome.pairCode!);
    for (const frame of [{ ...command(m.welcome), arbitraryApi: "/dangerous" }, { ...command(m.welcome), operation: { kind: "text.submit", text: "x".repeat(4001) } }]) {
      m.socket.send(frame); expect((await m.socket.take("error")).code).toBe("invalid-frame");
    }
    for (const patch of [{ sessionId: "other" }, { epoch: "old" }, { deviceId: c.welcome.deviceId }]) {
      m.socket.send({ ...command(m.welcome), ...patch }); expect((await m.socket.take("error")).code).toBe("scope-mismatch");
    }
    m.socket.send({ ...scoped(m.welcome), type: "result", forDeviceId: m.welcome.deviceId, requestId: "forged", status: "succeeded", message: "伪造" });
    expect((await m.socket.take("error")).code).toBe("forbidden");
    expect(c.socket.frames.some(f => f.type === "command" || f.type === "result")).toBe(false);
  });
  it("isolates two paired sessions and routes results to the intended device", async () => {
    const { computer, mobile } = await setup(); const c1 = await computer("computer_1"); const c2 = await computer("computer_2");
    const m1 = await mobile(c1.welcome.pairCode!, "mobile_1"); const m2 = await mobile(c2.welcome.pairCode!, "mobile_2");
    m1.socket.send({ ...command(m1.welcome), sessionId: m2.welcome.sessionId }); expect((await m1.socket.take("error")).code).toBe("scope-mismatch");
    c1.socket.send({ ...scoped(c1.welcome), type: "result", forDeviceId: m1.welcome.deviceId, requestId: "real", status: "succeeded", message: "电脑确认完成", version: 1 });
    expect((await m1.socket.take("result")).message).toBe("电脑确认完成");
    c2.socket.send({ ...scoped(c2.welcome), type: "heartbeat", at: 1 }); await c2.socket.take("pong");
    expect(m2.socket.frames.some(f => f.type === "result")).toBe(false);
  });
  it("marks owner unavailable and never queues an offline write", async () => {
    const { computer, mobile, connect } = await setup(); const c = await computer(); const m = await mobile(c.welcome.pairCode!);
    await m.socket.take("status"); c.socket.ws.close();
    expect((await m.socket.take("status")).ownerAvailable).toBe(false);
    m.socket.send(command(m.welcome)); expect((await m.socket.take("error")).code).toBe("owner-offline");
    const resumed = await connect(); resumed.send({ v: 1, type: "hello", role: "computer", deviceId: c.welcome.deviceId, deviceName: "电脑", token: c.welcome.token });
    expect((await resumed.take("welcome")).sessionId).toBe(c.welcome.sessionId);
    resumed.send({ ...scoped(c.welcome), type: "heartbeat", at: 4 }); await resumed.take("pong");
    expect(resumed.frames.some(f => f.type === "command")).toBe(false);
  });
  it("supports mobile token resume and status/result queries without replaying commands", async () => {
    const { computer, mobile, connect } = await setup(); const c = await computer(); const m = await mobile(c.welcome.pairCode!);
    await c.socket.take("controller"); m.socket.ws.close(); await c.socket.take("controller");
    const resumed = await connect(); resumed.send({ v: 1, type: "hello", role: "mobile", deviceId: m.welcome.deviceId, deviceName: "手机", token: m.welcome.token });
    expect((await resumed.take("welcome")).epoch).toBe(m.welcome.epoch);
    resumed.send({ ...scoped(m.welcome), type: "query", requestId: "uncertain_request", canvasId: "canvas_1" });
    expect((await c.socket.take("query")).requestId).toBe("uncertain_request");
    expect(c.socket.frames.some(f => f.type === "command")).toBe(false);
  });
  it("replaces the old authenticated socket when a mobile resumes with its current memory token", async () => {
    const { computer, mobile, connect } = await setup(); const c = await computer(); const m = await mobile(c.welcome.pairCode!);
    const closed = new Promise<number>(resolve => m.socket.ws.once("close", resolve));
    const fresh = await connect(); fresh.send({ v: 1, type: "hello", role: "mobile", deviceId: m.welcome.deviceId, deviceName: "手机", token: m.welcome.token });
    await fresh.take("welcome"); expect(await closed).toBe(4001);
    fresh.send(command(m.welcome, "current_socket"));
    expect((await c.socket.take("command")).requestId).toBe("current_socket");
    expect((await fresh.take("accepted")).requestId).toBe("current_socket");
  });
  it("revokes tokens and drops late results for removed devices", async () => {
    const { computer, mobile, connect } = await setup(); const c = await computer(); const m = await mobile(c.welcome.pairCode!);
    c.socket.send({ ...scoped(c.welcome), type: "revoke", targetDeviceId: m.welcome.deviceId });
    expect((await m.socket.take("revoked")).reason).toContain("撤销");
    c.socket.send({ ...scoped(c.welcome), type: "result", forDeviceId: m.welcome.deviceId, requestId: "late", status: "succeeded", message: "迟到" });
    const old = await connect(); old.send({ v: 1, type: "hello", role: "mobile", deviceId: m.welcome.deviceId, deviceName: "手机", token: m.welcome.token });
    expect((await old.take("error")).code).toBe("invalid-session"); expect(m.socket.frames.some(f => f.type === "result")).toBe(false);
  });
  it("expires the whole session and invalidates computer/mobile resume credentials", async () => {
    let clock = 100_000; const { computer, mobile, connect } = await setup({ now: () => clock, sessionTtlMs: 100 });
    const c = await computer(); const m = await mobile(c.welcome.pairCode!); clock += 101;
    m.socket.send(command(m.welcome)); expect((await m.socket.take("revoked")).reason).toContain("过期");
    const old = await connect(); old.send({ v: 1, type: "hello", role: "computer", deviceId: c.welcome.deviceId, deviceName: "电脑", token: c.welcome.token });
    expect((await old.take("error")).code).toBe("invalid-session");
  });
  it("revokes the entire session while a command is pending and invalidates both roles", async () => {
    const { computer, mobile, connect } = await setup(); const c = await computer(); const m = await mobile(c.welcome.pairCode!);
    m.socket.send(command(m.welcome)); await c.socket.take("command"); await m.socket.take("accepted");
    c.socket.send({ ...scoped(c.welcome), type: "revoke" });
    expect((await m.socket.take("revoked")).reason).toContain("关闭");
    expect((await c.socket.take("revoked")).reason).toContain("关闭");
    for (const [role, welcome] of [["computer", c.welcome], ["mobile", m.welcome]] as const) {
      const old = await connect(); old.send({ v: 1, type: "hello", role, deviceId: welcome.deviceId, deviceName: "旧设备", token: welcome.token });
      expect((await old.take("error")).code).toBe("invalid-session");
    }
    expect(m.socket.frames.some(f => f.type === "result")).toBe(false);
  });
  it("limits failed pairing attempts and rejects oversized transport frames", async () => {
    const { connect } = await setup(); const s = await connect();
    for (let attempt = 0; attempt < 20; attempt++) {
      s.send({ v: 1, type: "hello", role: "mobile", deviceId: "mobile", deviceName: "手机", pairCode: "WRONGCODE" }); await s.take("error");
    }
    s.send({ v: 1, type: "hello", role: "mobile", deviceId: "mobile", deviceName: "手机", pairCode: "WRONGCODE" });
    expect((await s.take("error")).code).toBe("rate-limit");
    const large = await connect(); const closed = new Promise<number>(resolve => large.ws.once("close", resolve)); large.ws.send("x".repeat(32769));
    expect(await closed).toBe(1009);
  });
  it("counts malformed JSON and schema-invalid messages before issuing error responses", async () => {
    const { connect } = await setup(); const socket = await connect();
    const closed = new Promise<number>(resolve => socket.ws.once("close", resolve));
    for (let i = 0; i < 100; i++) {
      socket.ws.send(i % 2 ? "{broken-json" : JSON.stringify({ type: "unsupported" }));
      expect((await socket.take("error")).code).toBe("invalid-frame");
    }
    socket.ws.send("{broken-json");
    expect((await socket.take("error")).code).toBe("rate-limit");
    expect(await closed).toBe(4008);
  });
});
