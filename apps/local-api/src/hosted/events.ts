import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { HostedSpaceStore, SpaceIdentity } from "../space/store.js";
import { SpaceError } from "../space/errors.js";
import { hostedBody, hostedJson } from "./http.js";
import { ownerCanvas } from "./owner.js";

interface Channel { accountId: string; deviceId: string; send: (value: unknown) => void; close: () => void }
interface Display { accountId: string; deviceId: string; id: string; spaceId: string; sleeping: boolean; seen: number }
interface Pending { accountId: string; displayId: string; deviceId: string; spaceId: string; finish: (value: { ok: boolean; sleeping: boolean; message?: string }) => void }
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const presenceSchema = z.strictObject({ displayId: id, spaceId: id, sleeping: z.boolean() });
const commandSchema = z.strictObject({ type: z.enum(["focus", "sleep", "wake", "switch-space"]), cardId: id.optional(), spaceId: id.optional() });
const ackSchema = z.strictObject({ commandId: z.uuid(), displayId: id, ok: z.boolean(), sleeping: z.boolean(), message: z.string().max(160).optional() });

/** One metadata stream per device. Browsers share it between tabs via Web Locks and BroadcastChannel. */
export function createHostedEvents(store: HostedSpaceStore, now: () => number = Date.now) {
  const channels = new Map<string, Channel>();
  const versions = new Map<string, Map<string, number>>();
  const displays = new Map<string, Display>();
  const pending = new Map<string, Pending>();
  let disposed = false;
  const key = (accountId: string, deviceId: string) => `${accountId}:${deviceId}`;
  const activeDisplays = (accountId: string) => [...displays.values()].filter(value => value.accountId === accountId && now() - value.seen < 9000)
    .sort((a, b) => b.seen - a.seen);
  const status = (accountId: string) => {
    const active = activeDisplays(accountId); return { online: active.length > 0, sleeping: active[0]?.sleeping ?? false, count: active.length };
  };
  function emit(accountId: string, value: unknown) { for (const channel of channels.values()) if (channel.accountId === accountId) channel.send(value); }
  const emitStatus = (accountId: string) => emit(accountId, { type: "display.status", ...status(accountId) });
  function ownedSpace(accountId: string, spaceId: string) {
    if (!store.listSpaces(accountId).some(value => value.id === spaceId)) throw new SpaceError(404, "space-not-found", "工作空间不存在。");
  }
  const poll = setInterval(() => {
    if (disposed) return;
    for (const channel of [...channels.values()]) {
      try { store.assertDeviceActive(channel.accountId, channel.deviceId); } catch { channel.close(); }
    }
    for (const accountId of new Set([...channels.values()].map(channel => channel.accountId))) {
      try {
        const next = new Map(store.listSpaces(accountId).map(space => [space.id, space.version]));
        const before = versions.get(accountId);
        if (before) {
          for (const [spaceId, version] of next) if (before.get(spaceId) !== version) emit(accountId, { type: "space.changed", spaceId, version });
          for (const spaceId of before.keys()) if (!next.has(spaceId)) emit(accountId, { type: "space.changed", spaceId, deleted: true });
        }
        versions.set(accountId, next);
      } catch { /* Closing account resources is handled by stream authentication. */ }
    }
    const expired = new Set<string>();
    for (const [displayId, display] of displays) if (now() - display.seen >= 9000) { displays.delete(displayId); expired.add(display.accountId); }
    expired.forEach(emitStatus);
  }, 500); poll.unref();
  const heartbeat = setInterval(() => { for (const channel of channels.values()) channel.send({ type: "heartbeat" }); }, 25_000); heartbeat.unref();

  function stream(request: Request, identity: SpaceIdentity) {
    const channelKey = key(identity.accountId, identity.device.id);
    channels.get(channelKey)?.close();
    if (channels.size >= 256) throw new SpaceError(429, "stream-busy", "同步连接较多，请稍后重试。");
    const encoder = new TextEncoder(); let channel: Channel;
    let cleanup = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        cleanup = () => {
          if (closed) return; closed = true;
          if (channels.get(channelKey) === channel) channels.delete(channelKey);
          request.signal.removeEventListener("abort", cleanup);
          if (![...channels.values()].some(value => value.accountId === identity.accountId)) versions.delete(identity.accountId);
          try { controller.close(); } catch { /* already cancelled */ }
        };
        channel = { accountId: identity.accountId, deviceId: identity.device.id, close: cleanup,
          send(value) { if (!closed) try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`)); } catch { cleanup(); } } };
        channels.set(channelKey, channel);
        request.signal.addEventListener("abort", cleanup, { once: true });
        if (request.signal.aborted) { cleanup(); return; }
        if (!versions.has(identity.accountId)) versions.set(identity.accountId, new Map(store.listSpaces(identity.accountId).map(space => [space.id, space.version])));
        channel.send({ type: "ready" }); channel.send({ type: "display.status", ...status(identity.accountId) });
      }, cancel() { cleanup(); },
    });
    return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff" } });
  }
  async function handle(request: Request, identity: SpaceIdentity): Promise<Response | null> {
    const url = new URL(request.url), path = url.pathname;
    if (path === "/api/space/events" && request.method === "GET") {
      if (url.search) throw new SpaceError(400, "invalid-stream", "同步地址无效。");
      return stream(request, identity);
    }
    if (path === "/api/space/display/status" && request.method === "GET") return hostedJson({ display: status(identity.accountId) });
    if (path === "/api/space/display/presence" && request.method === "POST") {
      const value = presenceSchema.safeParse(await hostedBody(request, 4096));
      if (!value.success) throw new SpaceError(400, "invalid-display", "大屏连接信息无效。");
      ownedSpace(identity.accountId, value.data.spaceId);
      const displayKey = `${identity.accountId}:${value.data.displayId}`;
      const prior = displays.get(displayKey);
      displays.set(displayKey, { accountId: identity.accountId, deviceId: identity.device.id, id: value.data.displayId,
        spaceId: value.data.spaceId, sleeping: value.data.sleeping, seen: now() });
      if (!prior || prior.sleeping !== value.data.sleeping || now() - prior.seen >= 9000) emitStatus(identity.accountId);
      return hostedJson({ ok: true, display: status(identity.accountId) });
    }
    if (path === "/api/space/display/ack" && request.method === "POST") {
      const value = ackSchema.safeParse(await hostedBody(request, 4096));
      if (!value.success) throw new SpaceError(400, "invalid-ack", "大屏回执无效。");
      const job = pending.get(value.data.commandId);
      if (!job || job.accountId !== identity.accountId || job.displayId !== value.data.displayId || job.deviceId !== identity.device.id)
        throw new SpaceError(409, "stale-display-ack", "这次大屏指令已结束或不可确认。");
      displays.set(`${identity.accountId}:${value.data.displayId}`, { accountId: identity.accountId, deviceId: identity.device.id,
        id: value.data.displayId, spaceId: job.spaceId, sleeping: value.data.sleeping, seen: now() });
      job.finish(value.data); emitStatus(identity.accountId);
      return hostedJson({ ok: true });
    }
    if (path === "/api/space/display/commands" && request.method === "POST") {
      const value = commandSchema.safeParse(await hostedBody(request, 4096));
      if (!value.success) throw new SpaceError(400, "invalid-display-command", "大屏指令无效。");
      const active = activeDisplays(identity.accountId); const target = active.find(display => display.spaceId === value.data.spaceId) ?? active[0];
      if (!target) throw new SpaceError(409, "display-offline", "大屏未连接。");
      const spaceId = value.data.spaceId ?? target.spaceId; ownedSpace(identity.accountId, spaceId);
      if ([...pending.values()].some(job => job.accountId === identity.accountId && job.displayId === target.id))
        throw new SpaceError(409, "display-busy", "大屏正在处理上一条操作，请稍候。");
      if (value.data.type === "focus") {
        const card = value.data.cardId ? ownerCanvas(store, identity.accountId, spaceId).record.cardsById[value.data.cardId] : null;
        if (!card) throw new SpaceError(404, "card-not-found", "这张卡片已不存在。");
        if (card.layout.surface === "user") throw new SpaceError(409, "card-not-on-display", "请先在电脑上将这张卡片移入工作空间。");
      }
      const commandId = randomUUID();
      const result = await new Promise<{ ok: boolean; sleeping: boolean; message?: string }>((resolve) => {
        const finish = (answer: { ok: boolean; sleeping: boolean; message?: string }) => {
          clearTimeout(timer); request.signal.removeEventListener("abort", aborted); pending.delete(commandId); resolve(answer);
        };
        const aborted = () => finish({ ok: false, sleeping: target.sleeping, message: "大屏操作结果未确认，请稍后核对。" });
        const timer = setTimeout(() => finish({ ok: false, sleeping: target.sleeping, message: "大屏没有确认，请稍后重试。" }), 5000); timer.unref();
        pending.set(commandId, { accountId: identity.accountId, displayId: target.id, deviceId: target.deviceId, spaceId, finish });
        request.signal.addEventListener("abort", aborted, { once: true });
        emit(identity.accountId, { type: "display.command", commandId, displayId: target.id, command: value.data.type,
          spaceId, ...(value.data.cardId ? { cardId: value.data.cardId } : {}) });
      });
      if (!result.ok) throw new SpaceError(504, "display-unconfirmed", result.message ?? "大屏操作尚未确认。");
      return hostedJson({ ok: true, commandId, display: status(identity.accountId) });
    }
    return null;
  }
  return { handle, activeCount: () => channels.size,
    changed(accountId: string, deviceId: string, response: Response) {
      const spaceId = response.headers.get("X-Vivic-Space");
      if (!response.ok || !spaceId || response.headers.get("X-Vivic-Deduplicated") === "1") return;
      const deleted = response.headers.get("X-Vivic-Space-Deleted") === "1";
      const version = Number(response.headers.get("X-Vivic-Space-Version"));
      const known = versions.get(accountId);
      if (!deleted && (!Number.isSafeInteger(version) || version < 0 || (known?.get(spaceId) ?? -1) >= version)) return;
      if (deleted) known?.delete(spaceId); else known?.set(spaceId, version);
      emit(accountId, { type: "space.changed", spaceId, ...(deleted ? { deleted: true } : { version }), sourceDeviceId: deviceId });
    },
    dispose() { disposed = true; clearInterval(poll); clearInterval(heartbeat); [...channels.values()].forEach(channel => channel.close());
      for (const job of [...pending.values()]) job.finish({ ok: false, sleeping: false, message: "服务正在重新连接。" });
      pending.clear(); versions.clear(); displays.clear(); } };
}
