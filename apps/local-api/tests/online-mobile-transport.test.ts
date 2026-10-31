import { afterEach, describe, expect, it } from "vitest";
import { createOnlineHandler } from "../src/online/sessions.js";
import { createOnlineHttpTransport } from "@vivic/mobile-console-prototype/transport";
import { createComputerConnector } from "@vivic/mobile-console-prototype/connector";
import { createMobileClient } from "@vivic/mobile-console-prototype/client";
import type { CanvasSnapshot } from "@vivic/mobile-console-prototype/protocol";

const origin = "https://vivic.example";
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).reverse().map(fn => fn())); });
const until = async (predicate: () => boolean) => {
  const end = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > end) throw new Error("Timed out waiting for transport"); await new Promise(resolve => setTimeout(resolve, 5)); }
};
async function environment() {
  const handler = createOnlineHandler({ origin, createSessionApp: () => ({ fetch: () => new Response("{}"), dispose() {} }) });
  cleanup.push(() => handler.dispose());
  const bootstrap = await handler.fetch(new Request(origin + "/api/online/session", { method: "POST", headers: { Origin: origin } }));
  const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!;
  const requests: { url: string; credentials?: RequestCredentials; headers: Headers }[] = [];
  const request: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers); headers.set("Origin", origin);
    if (init?.credentials === "same-origin") headers.set("Cookie", cookie);
    requests.push({ url: String(input), credentials: init?.credentials, headers });
    return handler.fetch(new Request(input, { ...init, headers }));
  };
  const listeners = new Set<() => void>(); let writes = 0;
  let snapshot: CanvasSnapshot = { computerName: "测试电脑", ownerAvailable: true, ownerEpoch: "owner", activeCanvasId: "canvas", version: 0,
    canvases: [{ id: "canvas", title: "Space", version: 0 }], cards: [] };
  const connector = createComputerConnector({ transport: createOnlineHttpTransport(origin + "/api/online/mobile/owner", "owner", request),
    accessKey: "online-cookie-owner-boundary", deviceId: "computer", deviceName: "电脑", host: {
      getSnapshot: () => snapshot, subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      async submitText(text, context) {
        if (!context.isCurrent()) return { ok: false, message: "失效" };
        writes++; snapshot = { ...snapshot, version: snapshot.version + 1, cards: [...snapshot.cards, { id: `note${writes}`, type: "note", title: text, pinned: false, preview: { kind: "text", body: text } }] };
        listeners.forEach(listener => listener()); return { ok: true, message: "测试宿主已提交" };
      },
      switchCanvas() { return { ok: false, message: "仅测试当前画布" }; },
      setCardPinned() { return { ok: false, message: "仅测试文字" }; },
    } });
  const phone = createMobileClient({ id: "phone", transportFactory: url => createOnlineHttpTransport(url, "phone", request) });
  cleanup.push(() => { phone.disconnect(); connector.stop(); });
  connector.start(); await until(() => connector.getSnapshot().status === "connected");
  phone.pair(origin + "/api/online/mobile/phone", connector.getSnapshot().pairCode!);
  await until(() => phone.getSnapshot().snapshot?.ownerAvailable === true);
  return { handler, connector, phone, requests, writes: () => writes };
}

describe("real online handler with existing connector and phone client", () => {
  it("submits once, waits for owner result, projects the new card and retains no credential in URLs", async () => {
    const t = await environment();
    const id = t.phone.submit({ kind: "text.submit", text: "新建便笺：线上手机" });
    expect(id).toBeTruthy();
    await until(() => t.phone.getSnapshot().requests.find(item => item.requestId === id)?.status === "succeeded");
    await until(() => t.phone.getSnapshot().snapshot?.cards.length === 1);
    expect(t.writes()).toBe(1); expect(t.phone.getSnapshot().snapshot?.cards[0]?.preview?.body).toBe("新建便笺：线上手机");
    expect(t.requests.every(item => !new URL(item.url).search && !new URL(item.url).hash && !item.headers.has("authorization"))).toBe(true);
    expect(t.requests.filter(item => item.url.includes("/phone/")).every(item => item.credentials === "omit" && !item.headers.has("cookie"))).toBe(true);
  });
  it("keeps in-memory reconnect identity and revokes an active polling phone", async () => {
    const t = await environment();
    t.phone.disconnect(); expect(t.phone.getSnapshot().status).toBe("offline");
    t.phone.reconnect(); await until(() => t.phone.getSnapshot().snapshot?.ownerAvailable === true && t.phone.getSnapshot().status === "connected");
    t.connector.revoke("phone");
    await until(() => t.phone.getSnapshot().status === "revoked");
    expect(t.phone.getSnapshot().snapshot).toBeNull(); expect(t.phone.submit({ kind: "text.submit", text: "不得执行" })).toBeNull();
    expect(t.writes()).toBe(0);
  });
  it("owner stop invalidates phone auth and cannot turn receipt into execution success", async () => {
    const t = await environment();
    t.connector.stop();
    await until(() => ["expired", "revoked", "offline"].includes(t.phone.getSnapshot().status));
    expect(t.phone.getSnapshot().requests.some(item => item.status === "succeeded")).toBe(false);
    expect(t.phone.submit({ kind: "text.submit", text: "不得执行" })).toBeNull();
  });
  it("a missing cookie expires the desktop connector instead of hiding a terminal failure", async () => {
    const handler = createOnlineHandler({ origin, createSessionApp: () => ({ fetch: () => new Response("{}"), dispose() {} }) });
    cleanup.push(() => handler.dispose());
    const connector = createComputerConnector({ transport: createOnlineHttpTransport(origin + "/api/online/mobile/owner", "owner",
      (input, init) => handler.fetch(new Request(input, { ...init, headers: { "Content-Type": "application/json", Origin: origin } }))),
      accessKey: "cookie-bound-not-secret", deviceId: "no-cookie-owner", deviceName: "电脑", host: {
        getSnapshot: () => ({ computerName: "电脑", ownerAvailable: true, ownerEpoch: "epoch", activeCanvasId: null, version: 0, canvases: [], cards: [] }),
        subscribe: () => () => {}, submitText: async () => ({ ok: false, message: "不执行" }), switchCanvas: () => ({ ok: false, message: "不执行" }), setCardPinned: () => ({ ok: false, message: "不执行" }),
      } });
    cleanup.push(() => connector.stop()); connector.start();
    await until(() => connector.getSnapshot().status === "expired");
    expect(connector.getSnapshot().error).toContain("会话已结束");
  });
});
