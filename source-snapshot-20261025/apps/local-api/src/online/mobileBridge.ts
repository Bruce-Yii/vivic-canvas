import { randomBytes, createHash } from "node:crypto";
import { MAX_BUFFERED_BYTES, PERMISSIONS, parseFrame, serializeFrame, type Frame, type Hello } from "@vivic/mobile-console-prototype/protocol";

type Role = "owner" | "phone";
type Peer = { id: string; tokenHash: string; connection: string; role: Role; frames: Frame[]; bytes: number; seen: number;
  waiting?: () => void; online: boolean; revokedAt?: number };
type Bridge = { ownerId: string; id: string; epoch: string; expires: number; owner: Peer; phones: Map<string, Peer>;
  available: boolean; pair?: string; pairExpires: number };
const secret = () => randomBytes(32).toString("base64url");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const wire = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: {
  "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
} });
const fail = (code: string, status = 400) => wire({ ok: false, code }, status);

/** Session-bound transport only. It never invokes the model app or stores raw cards. */
export function createOnlineMobileBridge(now = Date.now) {
  const bridges = new Map<string, Bridge>();
  const connections = new Map<string, { bridge: Bridge; peer: Peer }>();
  const scope = (b: Bridge, p: Peer) => ({ v: 1 as const, sessionId: b.id, epoch: b.epoch, deviceId: p.id });
  const live = (p: Peer) => p.online && now() - p.seen < 30_000;
  const push = (p: Peer, frame: Frame) => {
    const text = serializeFrame(frame);
    if (!text) return false;
    // A new snapshot supersedes queued snapshots, never command/results.
    if (frame.type === "snapshot") p.frames = p.frames.filter(item => item.type !== "snapshot");
    p.bytes = p.frames.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0);
    if (p.bytes + Buffer.byteLength(text) > MAX_BUFFERED_BYTES) { p.online = false; p.waiting?.(); return false; }
    p.frames.push(frame); p.bytes += Buffer.byteLength(text); p.waiting?.(); return true;
  };
  const status = (b: Bridge) => { for (const p of b.phones.values()) push(p, { ...scope(b, p), type: "status", ownerAvailable: b.available && live(b.owner),
    ...(!b.available || !live(b.owner) ? { reason: "电脑控制页不可用，请在电脑打开 Vivic。" } : {}) }); };
  const controller = (b: Bridge, p: Peer, state: "joined" | "left") => push(b.owner, { ...scope(b, p), type: "controller", state, permissions: [...PERMISSIONS] });
  const revokePhone = (b: Bridge, p: Peer, reason: string) => {
    b.phones.delete(p.id); p.tokenHash = ""; p.revokedAt = now();
    push(p, { ...scope(b, p), type: "revoked", reason }); controller(b, p, "left");
  };
  const forget = (ownerId: string) => {
    const b = bridges.get(ownerId); if (!b) return;
    bridges.delete(ownerId);
    for (const [key, connection] of connections) if (connection.bridge === b) {
      const p = connection.peer; p.tokenHash = ""; p.online = false; p.waiting?.(); connections.delete(key); p.frames = [];
    }
    b.phones.clear(); b.pair = undefined;
  };
  const sweep = () => {
    for (const b of bridges.values()) {
      if (b.expires <= now()) { forget(b.ownerId); continue; }
      if (b.pairExpires <= now()) b.pair = undefined;
      if (b.owner.online && !live(b.owner)) { b.owner.online = false; b.available = false; status(b); }
      for (const p of b.phones.values()) if (p.online && !live(p)) { p.online = false; controller(b, p, "left"); }
    }
    // Revocation responses stay drainable briefly, with no usable reconnect token.
    for (const [key, { peer }] of connections) if (peer.revokedAt !== undefined && now() - peer.revokedAt > 30_000) connections.delete(key);
  };
  const rotate = (b: Bridge) => { b.pair = randomBytes(8).toString("hex").toUpperCase(); b.pairExpires = now() + 120_000; };
  const bind = (b: Bridge, p: Peer, token: string) => {
    connections.delete(p.connection); p.waiting?.(); p.connection = secret(); p.seen = now(); p.online = true; p.frames = []; p.bytes = 0;
    connections.set(p.connection, { bridge: b, peer: p });
    push(p, { ...scope(b, p), type: "welcome", computerId: b.owner.id, token, expiresAt: b.expires, permissions: [...PERMISSIONS],
      ...(p.role === "owner" ? { ...(b.pair ? { pairCode: b.pair, pairExpiresAt: b.pairExpires } : {}),
        controllers: [...b.phones.values()].map(phone => ({ deviceId: phone.id, permissions: [...PERMISSIONS] })) } : {}) });
    if (p.role === "owner") b.available = false; else controller(b, p, "joined");
    status(b);
    return wire({ ok: true, connectionId: p.connection, frames: drain(p) });
  };
  const drain = (p: Peer) => { const frames = p.frames; p.frames = []; p.bytes = 0; return frames; };
  const peer = (hello: Hello, role: Role, token: string): Peer => ({ id: hello.deviceId, tokenHash: digest(token), connection: "", role, frames: [], bytes: 0, seen: now(), online: true });
  return {
    forget, sweep,
    ownerForConnection(connectionId: unknown) { return typeof connectionId === "string" ? connections.get(connectionId)?.bridge.ownerId : undefined; },
    dispose() { for (const id of bridges.keys()) forget(id); connections.clear(); },
    async handle(role: Role, action: string, data: unknown, signal: AbortSignal, owner?: { id: string; expiresAt: number }): Promise<Response> {
      sweep();
      if (!data || typeof data !== "object" || Array.isArray(data)) return fail("invalid-mobile-request");
      const body = data as Record<string, unknown>;
      if (action === "connect") {
        if (Object.keys(body).some(key => key !== "frame")) return fail("invalid-mobile-request");
        const hello = parseFrame(body.frame);
        if (hello?.type !== "hello" || hello.role !== (role === "owner" ? "computer" : "mobile")) return fail("invalid-mobile-hello");
        if (role === "owner") {
          if (!owner) return fail("online-session-required", 401);
          let b = bridges.get(owner.id);
          if (hello.token) {
            if (!b || b.owner.id !== hello.deviceId || b.owner.tokenHash !== digest(hello.token)) return fail("invalid-session", 401);
            return bind(b, b.owner, hello.token);
          }
          // A second owner tab cannot silently replace an already-authorized owner.
          if (b && live(b.owner)) return fail("owner-exists", 409);
          if (b) forget(owner.id);
          const token = secret(); const p = peer(hello, role, token);
          b = { ownerId: owner.id, id: `online_mobile_${secret()}`, epoch: secret(), expires: owner.expiresAt,
            owner: p, phones: new Map(), available: false, pairExpires: 0 };
          bridges.set(owner.id, b); rotate(b); return bind(b, p, token);
        }
        if (hello.token) {
          for (const b of bridges.values()) {
            const p = b.phones.get(hello.deviceId);
            if (p?.tokenHash === digest(hello.token)) return bind(b, p, hello.token);
          }
          return fail("invalid-session", 401);
        }
        const b = [...bridges.values()].find(value => value.pair === hello.pairCode && value.pairExpires > now());
        if (!b) return fail("invalid-pairing", 401);
        if (!b.available || !live(b.owner)) return fail("owner-offline", 409);
        if (b.phones.size >= 4) return fail("mobile-capacity", 429);
        if (b.owner.id === hello.deviceId || b.phones.has(hello.deviceId)) return fail("device-exists", 409);
        const token = secret(); const p = peer(hello, role, token);
        b.pair = undefined; b.phones.set(p.id, p); return bind(b, p, token);
      }
      if (typeof body.connectionId !== "string") return fail("invalid-session", 401);
      const authenticated = connections.get(body.connectionId);
      if (!authenticated || authenticated.peer.role !== role || role === "owner" && authenticated.bridge.ownerId !== owner?.id) return fail("invalid-session", 401);
      const { bridge: b, peer: p } = authenticated;
      if (Object.keys(body).some(key => !["connectionId", ...(action === "send" ? ["frame"] : [])].includes(key))) return fail("invalid-mobile-request");
      if (p.tokenHash) p.seen = now();
      if (action === "disconnect") {
        p.online = false; p.waiting?.(); connections.delete(p.connection);
        if (role === "owner") { b.available = false; status(b); } else controller(b, p, "left");
        return wire({ ok: true });
      }
      if (action === "poll") {
        if (p.waiting) return fail("poll-already-active", 409);
        if (!p.frames.length && p.online && p.tokenHash) await new Promise<void>(resolve => {
          const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); if (p.waiting === finish) p.waiting = undefined; resolve(); };
          const timer = setTimeout(finish, 20_000); timer.unref(); p.waiting = finish;
          signal.addEventListener("abort", finish, { once: true }); if (signal.aborted) finish();
        });
        if (!connections.has(body.connectionId) || !bridges.has(b.ownerId)) return fail("invalid-session", 401);
        const frames = drain(p);
        if (!p.tokenHash) { connections.delete(p.connection); if (!frames.length) return fail("invalid-session", 401); }
        if (!p.online && !frames.length) return fail("invalid-session", 401);
        return wire({ ok: true, frames });
      }
      if (action !== "send" || !p.online || !p.tokenHash) return fail("invalid-session", 401);
      const frame = parseFrame(body.frame);
      if (!frame || !("sessionId" in frame) || frame.sessionId !== b.id || frame.epoch !== b.epoch || frame.deviceId !== p.id) return fail("scope-mismatch", 403);
      if (frame.type === "heartbeat") { push(p, { ...scope(b, p), type: "pong", at: frame.at }); return wire({ ok: true }); }
      if (frame.type === "revoke") {
        if (role === "phone") {
          if (frame.targetDeviceId && frame.targetDeviceId !== p.id) return fail("forbidden", 403);
          revokePhone(b, p, "已退出手机控制。");
        } else if (frame.targetDeviceId) { const target = b.phones.get(frame.targetDeviceId); if (target) revokePhone(b, target, "电脑已撤销本设备授权。"); }
        else forget(b.ownerId);
        return wire({ ok: true });
      }
      if (role === "owner") {
        if (frame.type === "owner.status") { b.available = frame.available; status(b); }
        else if (frame.type === "pair.rotate") { rotate(b); push(p, { ...scope(b, p), type: "pairing", pairCode: b.pair!, pairExpiresAt: b.pairExpires }); }
        else if (frame.type === "snapshot") for (const target of b.phones.values()) push(target, frame);
        else if (frame.type === "result" || frame.type === "executing" || frame.type === "file.chunk" || frame.type === "file.error") { const target = b.phones.get(frame.forDeviceId); if (target) push(target, frame); }
        else return fail("forbidden", 403);
      } else if (["command", "cancel", "query", "snapshot.request", "file.request"].includes(frame.type)) {
        if (!live(b.owner) || !b.available) return fail("owner-offline", 409);
        if (!push(b.owner, frame)) return fail("owner-offline", 409);
        if (frame.type === "command") push(p, { ...scope(b, p), type: "accepted", requestId: frame.requestId });
      } else return fail("forbidden", 403);
      return wire({ ok: true });
    },
  };
}
