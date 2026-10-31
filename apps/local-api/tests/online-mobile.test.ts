import { afterEach, describe, expect, it } from "vitest";
import { createOnlineHandler } from "../src/online/sessions.js";
import type { Frame, Welcome } from "@vivic/mobile-console-prototype/protocol";

const origin = "https://vivic.example";
const handlers: ReturnType<typeof createOnlineHandler>[] = [];
const setup = (time = { value: Date.now() }, limits = {}) => {
  const handler = createOnlineHandler({ origin, now: () => time.value, limits,
    createSessionApp: () => ({ fetch: () => new Response("{}"), dispose() {} }) });
  handlers.push(handler);
  const request = async (path: string, body: unknown, cookie?: string, headers?: Record<string, string>, signal?: AbortSignal) => {
    const response = await handler.fetch(new Request(origin + path, { method: "POST", signal, headers: { Origin: origin,
      "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: JSON.stringify(body) }));
    return { status: response.status, headers: response.headers, data: await response.json() as { ok?: boolean; code?: string; frames?: Frame[]; connectionId?: string } };
  };
  const begin = async () => (await request("/api/online/session", {})).headers.get("set-cookie")!.split(";")[0]!;
  const send = (role: string, id: string, frame: Frame, cookie?: string) => request(`/api/online/mobile/${role}/send`, { connectionId: id, frame }, cookie);
  const owner = async (cookie: string, id = "desktop") => {
    const response = await request("/api/online/mobile/owner/connect", { frame: { v: 1, type: "hello", role: "computer", deviceId: id,
      deviceName: "测试电脑", accessKey: "cookie-auth-not-secret" } }, cookie);
    const welcome = response.data.frames!.find(frame => frame.type === "welcome") as Welcome;
    const scope = { v: 1 as const, sessionId: welcome.sessionId, deviceId: id, epoch: welcome.epoch };
    await send("owner", response.data.connectionId!, { ...scope, type: "owner.status", available: true }, cookie);
    return { cookie, id: response.data.connectionId!, welcome, scope };
  };
  const phone = async (code: string, deviceId = "phone") => {
    const response = await request("/api/online/mobile/phone/connect", { frame: { v: 1, type: "hello", role: "mobile", deviceId,
      deviceName: "测试手机", pairCode: code } });
    const welcome = response.data.frames?.find(frame => frame.type === "welcome") as Welcome | undefined;
    return { response, id: response.data.connectionId!, welcome, scope: welcome ? { v: 1 as const, sessionId: welcome.sessionId, deviceId, epoch: welcome.epoch } : undefined };
  };
  const poll = (role: string, id: string, cookie?: string, signal?: AbortSignal) => request(`/api/online/mobile/${role}/poll`, { connectionId: id }, cookie, undefined, signal);
  return { handler, request, begin, owner, phone, poll, send, time };
};
afterEach(async () => { await Promise.all(handlers.splice(0).map(handler => handler.dispose())); });

describe("online isolated owner/mobile bridge", () => {
  it("routes bounded file chunks only between the paired phone and its cookie owner", async () => {
    const t = setup(), cookie = await t.begin(), owner = await t.owner(cookie), p = await t.phone(owner.welcome.pairCode!);
    expect(p.welcome!.permissions).toContain("file.read");
    const read: Frame = { ...p.scope!, type: "file.request", requestId: "file-download", canvasId: "space", ownerEpoch: "owner", expectedVersion: 1, cardId: "file-card", offset: 0 };
    expect((await t.send("phone", p.id, read)).status).toBe(200);
    expect((await t.poll("owner", owner.id, cookie)).data.frames).toContainEqual(read);
    const chunk: Frame = { ...owner.scope, type: "file.chunk", requestId: "file-download", forDeviceId: "phone", cardId: "file-card", offset: 0,
      chunk: { data: "dGVzdA==", totalBytes: 4, sha256: "a".repeat(64), name: "test.txt", mediaType: "text/plain" } };
    expect((await t.send("owner", owner.id, chunk, cookie)).status).toBe(200);
    expect((await t.poll("phone", p.id)).data.frames).toContainEqual(chunk);
    expect((await t.send("phone", p.id, { ...read, sessionId: "foreign" })).status).toBe(403);
    expect((await t.send("owner", owner.id, { ...chunk, chunk: { ...chunk.chunk, data: "A".repeat(21849) } }, cookie)).status).toBe(403);
    expect((await t.send("phone", p.id, { ...chunk, deviceId: "phone" })).status).toBe(403);
  });
  it("requires the exact owner cookie; other browser sessions cannot claim or send", async () => {
    const t = setup(), a = await t.begin(), b = await t.begin(), owner = await t.owner(a);
    expect((await t.request("/api/online/mobile/owner/connect", { frame: { v: 1, type: "hello", role: "computer", deviceId: "stolen", deviceName: "x", token: owner.welcome.token } }, b)).status).toBe(401);
    expect((await t.send("owner", owner.id, { ...owner.scope, type: "pair.rotate" }, b)).status).toBe(401);
    expect((await t.send("owner", owner.id, { ...owner.scope, type: "pair.rotate" })).status).toBe(401);
    expect((await t.owner(a, "other-tab").catch(() => null))).toBeNull();
  });
  it("consumes one random pairing code, transfers only strict snapshots, and routes commands/results", async () => {
    const t = setup(), cookie = await t.begin(), owner = await t.owner(cookie), p = await t.phone(owner.welcome.pairCode!);
    expect(p.response.status).toBe(200); expect(p.welcome!.token).not.toBe(owner.welcome.token);
    expect((await t.phone(owner.welcome.pairCode!, "second-phone")).response.status).toBe(401);
    const snapshot: Frame = { ...owner.scope, type: "snapshot", sequence: 1, state: { computerName: "电脑", ownerAvailable: true,
      ownerEpoch: "epoch", activeCanvasId: "canvas", version: 0, canvases: [{ id: "canvas", title: "Space", version: 0 }],
      cards: [{ id: "card", title: "便笺", type: "note", pinned: false, preview: { kind: "text", body: "正文" } }] } };
    expect((await t.send("owner", owner.id, snapshot, cookie)).status).toBe(200);
    expect((await t.poll("phone", p.id)).data.frames).toContainEqual(snapshot);
    expect((await t.send("phone", p.id, snapshot)).status).toBe(403);
    const command: Frame = { ...p.scope!, type: "command", requestId: "request", canvasId: "canvas", ownerEpoch: "epoch", expectedVersion: 0,
      operation: { kind: "text.submit", text: "新建便笺：从手机" } };
    await t.send("phone", p.id, command);
    expect((await t.poll("owner", owner.id, cookie)).data.frames).toContainEqual(command);
    expect((await t.poll("phone", p.id)).data.frames).toContainEqual({ ...p.scope!, type: "accepted", requestId: "request" });
    const result: Frame = { ...owner.scope, type: "result", requestId: "request", forDeviceId: "phone", status: "succeeded", message: "已保存" };
    await t.send("owner", owner.id, result, cookie);
    expect((await t.poll("phone", p.id)).data.frames).toContainEqual(result);
    expect((await t.send("owner", owner.id, { ...snapshot, state: { ...snapshot.state, apiKey: "not-allowed" } } as unknown as Frame, cookie)).status).toBe(403);
  });
  it("denies pair before the real owner advertises ready and expires unused codes", async () => {
    const t = setup(), cookie = await t.begin(), owner = await t.owner(cookie);
    await t.send("owner", owner.id, { ...owner.scope, type: "owner.status", available: false }, cookie);
    expect((await t.phone(owner.welcome.pairCode!)).response.status).toBe(409);
    t.time.value += 120_001;
    expect((await t.phone(owner.welcome.pairCode!)).response.status).toBe(401);
  });
  it("phone requests cannot keep a cookie session alive; idle expiry removes queued content and auth", async () => {
    const t = setup({ value: Date.now() }, { idleTtlMs: 1000 }), cookie = await t.begin(), owner = await t.owner(cookie), p = await t.phone(owner.welcome.pairCode!);
    t.time.value += 900;
    expect((await t.send("phone", p.id, { ...p.scope!, type: "heartbeat", at: t.time.value })).status).toBe(200);
    t.time.value += 101;
    expect((await t.poll("phone", p.id)).status).toBe(401);
    expect((await t.phone(owner.welcome.pairCode!)).response.status).toBe(401);
  });
  it("rechecks owner idle expiry after awaiting a slow phone request body", async () => {
    const t = setup({ value: Date.now() }, { idleTtlMs: 1000 }), cookie = await t.begin(), owner = await t.owner(cookie);
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const body = new ReadableStream<Uint8Array>({ async start(controller) {
      await waiting;
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ frame: { v: 1, type: "hello", role: "mobile", deviceId: "late-phone", deviceName: "手机", pairCode: owner.welcome.pairCode } })));
      controller.close();
    } });
    const pending = t.handler.fetch(new Request(origin + "/api/online/mobile/phone/connect", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body, duplex: "half" } as RequestInit));
    t.time.value += 1001; release();
    expect((await pending).status).toBe(401);
    expect((await t.poll("owner", owner.id, cookie)).status).toBe(401);
  });
  it("does not return a long-poll frame after the owner cookie's idle deadline", async () => {
    const t = setup({ value: Date.now() }, { idleTtlMs: 1000 }), cookie = await t.begin(), owner = await t.owner(cookie), p = await t.phone(owner.welcome.pairCode!);
    const abort = new AbortController();
    const pending = t.poll("phone", p.id, undefined, abort.signal);
    await new Promise(resolve => setTimeout(resolve, 10));
    t.time.value += 1001; abort.abort();
    expect((await pending).status).toBe(401);
    expect((await t.poll("phone", p.id)).status).toBe(401);
  });
  it("authenticated desktop activity can refresh idle but cannot extend the absolute session deadline", async () => {
    const t = setup({ value: Date.now() }, { idleTtlMs: 1000, absoluteTtlMs: 2000 }), cookie = await t.begin(), owner = await t.owner(cookie), p = await t.phone(owner.welcome.pairCode!);
    t.time.value += 900;
    expect((await t.send("owner", owner.id, { ...owner.scope, type: "heartbeat", at: t.time.value }, cookie)).status).toBe(200);
    t.time.value += 900;
    expect((await t.send("phone", p.id, { ...p.scope!, type: "heartbeat", at: t.time.value })).status).toBe(200);
    expect((await t.send("owner", owner.id, { ...owner.scope, type: "heartbeat", at: t.time.value }, cookie)).status).toBe(200);
    t.time.value += 201;
    expect((await t.send("owner", owner.id, { ...owner.scope, type: "heartbeat", at: t.time.value }, cookie)).status).toBe(401);
    expect((await t.poll("phone", p.id)).status).toBe(401);
  });
  it("a pending authenticated owner poll cannot return after absolute expiration", async () => {
    const t = setup({ value: Date.now() }, { idleTtlMs: 10_000, absoluteTtlMs: 1000 }), cookie = await t.begin(), owner = await t.owner(cookie);
    const abort = new AbortController(), pending = t.poll("owner", owner.id, cookie, abort.signal);
    await new Promise(resolve => setTimeout(resolve, 10));
    t.time.value += 1001; abort.abort();
    expect((await pending).status).toBe(401);
    expect((await t.phone(owner.welcome.pairCode!)).response.status).toBe(401);
  });
  it("destroying the owner session wakes pending phone polls and leaves other owners intact", async () => {
    const t = setup(), cookie = await t.begin(), owner = await t.owner(cookie), p = await t.phone(owner.welcome.pairCode!);
    const other = await t.owner(await t.begin(), "other");
    const pending = t.poll("phone", p.id);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect((await t.poll("phone", p.id)).status).toBe(409);
    await t.handler.fetch(new Request(origin + "/api/online/session", { method: "DELETE", headers: { Origin: origin, Cookie: cookie } }));
    expect((await pending).status).toBe(401);
    expect((await t.send("owner", other.id, { ...other.scope, type: "pair.rotate" }, other.cookie)).status).toBe(200);
  });
  it("revokes phone immediately, blocks reconnect token and forbids cross-device revoke", async () => {
    const t = setup(), cookie = await t.begin(), owner = await t.owner(cookie), p = await t.phone(owner.welcome.pairCode!);
    expect((await t.send("phone", p.id, { ...p.scope!, type: "revoke", targetDeviceId: "other" })).status).toBe(403);
    await t.send("owner", owner.id, { ...owner.scope, type: "revoke", targetDeviceId: "phone" }, cookie);
    expect((await t.poll("phone", p.id)).data.frames?.some(frame => frame.type === "revoked")).toBe(true);
    expect((await t.poll("phone", p.id)).status).toBe(401);
    expect((await t.send("phone", p.id, { ...p.scope!, type: "heartbeat", at: Date.now() })).status).toBe(401);
    expect((await t.request("/api/online/mobile/phone/connect", { frame: { v: 1, type: "hello", role: "mobile", deviceId: "phone", deviceName: "手机", token: p.welcome!.token } })).status).toBe(401);
  });
  it("owner destruction clears undrained revoked connections and revoked auth has a fixed deadline", async () => {
    const t = setup(), cookie = await t.begin(), owner = await t.owner(cookie), p = await t.phone(owner.welcome.pairCode!);
    await t.send("owner", owner.id, { ...owner.scope, type: "revoke", targetDeviceId: "phone" }, cookie);
    await t.handler.fetch(new Request(origin + "/api/online/session", { method: "DELETE", headers: { Origin: origin, Cookie: cookie } }));
    expect((await t.poll("phone", p.id)).status).toBe(401);
    const next = await t.owner(await t.begin(), "new-owner"), second = await t.phone(next.welcome.pairCode!, "second");
    await t.send("owner", next.id, { ...next.scope, type: "revoke", targetDeviceId: "second" }, next.cookie);
    t.time.value += 30_001;
    expect((await t.poll("phone", second.id)).status).toBe(401);
  });
  it("permits native CORS only on scoped phone endpoints, without cookies or operator API access", async () => {
    const t = setup(), cookie = await t.begin(), owner = await t.owner(cookie);
    const native = { Origin: "https://appassets.androidplatform.net", "Sec-Fetch-Site": "cross-site" };
    const response = await t.request("/api/online/mobile/phone/connect", { frame: { v: 1, type: "hello", role: "mobile", deviceId: "native", deviceName: "Android", pairCode: owner.welcome.pairCode } }, undefined, native);
    expect(response.status).toBe(200); expect(response.headers.get("access-control-allow-origin")).toBe(native.Origin);
    expect(response.headers.has("access-control-allow-credentials")).toBe(false); expect(response.headers.has("set-cookie")).toBe(false);
    expect((await t.request("/api/online/mobile/owner/connect", {}, cookie, native)).status).toBe(403);
    expect((await t.request("/api/intent", {}, cookie, native)).status).toBe(403);
    expect((await t.request("/api/online/mobile/phone/connect", {}, undefined, { Origin: "https://evil.example" })).status).toBe(403);
  });
  it("strictly bounds body uploads and never accepts browser bearers on phone routes", async () => {
    const t = setup();
    expect((await t.request("/api/online/mobile/phone/connect", { frame: "x".repeat(35 * 1024) })).status).toBe(413);
    expect((await t.request("/api/online/mobile/phone/connect", {}, undefined, { Authorization: "Bearer invalid" })).status).toBe(400);
    expect((await t.request("/api/online/mobile/phone/connect?token=untrusted", {})).status).toBe(400);
  });
});
