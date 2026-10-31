import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { isIP, type AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { MAX_BUFFERED_BYTES, MAX_FRAME_BYTES, PERMISSIONS, parseFrame, serializeFrame, type Frame, type Hello, type Permission } from "./protocol.js";

export interface RelayOptions {
  /** A dedicated relay admission secret. Never a Vivic/model API credential. */
  admissionSecret: string;
  allowedOrigins: string[];
  publicMode?: boolean;
  /** Explicit exception for an installed desktop UI on loopback; transport still requires public TLS. */
  allowLoopbackOrigins?: boolean;
  /** Exact upstream proxy IPs allowed to supply a single, overwritten X-Forwarded-For. Empty by default. */
  trustedProxyIps?: string[];
  pairTtlMs?: number;
  sessionTtlMs?: number;
  heartbeatMs?: number;
  maxSessions?: number;
  maxControllers?: number;
  now?: () => number;
}
interface Peer {
  deviceId: string;
  name: string;
  tokenHash: string;
  permissions: Permission[];
  socket?: WebSocket;
}
interface Session {
  id: string;
  epoch: string;
  expiresAt: number;
  computer: Peer;
  controllers: Map<string, Peer>;
  ownerAvailable: boolean;
  pairCode?: string;
  pairExpiresAt?: number;
}
interface Authentication { session: Session; peer: Peer; role: "computer" | "mobile" }

const id = (prefix: string) => `${prefix}_${randomBytes(18).toString("base64url")}`;
const token = () => randomBytes(32).toString("base64url");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const equal = (a: string, b: string) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
const open = (socket?: WebSocket): socket is WebSocket => socket?.readyState === WebSocket.OPEN;
const emit = (socket: WebSocket | undefined, frame: Frame) => {
  if (!open(socket)) return false;
  const serialized = serializeFrame(frame);
  if (!serialized) return false;
  if (socket.bufferedAmount + Buffer.byteLength(serialized) > MAX_BUFFERED_BYTES) {
    // A slow peer must not turn this ephemeral relay into an unbounded queue.
    socket.terminate(); return false;
  }
  try { socket.send(serialized); return true; } catch { socket.terminate(); return false; }
};
const scope = (s: Session, deviceId: string) => ({ v: 1 as const, sessionId: s.id, epoch: s.epoch, deviceId });
const canonicalIp = (address: string): string | undefined => {
  if (isIP(address) === 4) return address;
  if (isIP(address) !== 6) return undefined;
  try {
    const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    // IPv4 and its mapped IPv6 spelling must share one rate-limit bucket.
    const mapped = /^::ffff:([\da-f]+):([\da-f]+)$/.exec(normalized);
    if (mapped) {
      const high = parseInt(mapped[1]!, 16), low = parseInt(mapped[2]!, 16);
      return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
    }
    return normalized;
  } catch { return undefined; }
};

/** Ephemeral, inspectable relay. It never stores canvas contents or executes actions. */
export function createRelayServer(options: RelayOptions) {
  if (options.admissionSecret.length < 32 || options.admissionSecret.length > 256) throw new Error("Relay admission secret must contain 32–256 characters.");
  const origins = new Set(options.allowedOrigins);
  if (!origins.size || [...origins].some(origin => {
    try { const url = new URL(origin); return url.origin !== origin || !["http:", "https:"].includes(url.protocol)
      || (options.publicMode && url.protocol !== "https:" && !(options.allowLoopbackOrigins
        && url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))); } catch { return true; }
  })) throw new Error("Explicit exact HTTP(S) origins are required; public mode requires HTTPS origins.");
  const trustedProxies = new Set((options.trustedProxyIps ?? []).map(address => {
    const normalized = canonicalIp(address);
    if (!normalized) throw new Error("Trusted proxy addresses must be exact IP addresses, without CIDR ranges or wildcards.");
    return normalized;
  }));
  if (options.publicMode && !trustedProxies.size) throw new Error("Public mode requires explicit trusted proxy IP addresses.");
  const now = options.now ?? Date.now;
  const sessions = new Map<string, Session>();
  const pairings = new Map<string, Session>();
  const auth = new Map<WebSocket, Authentication>();
  const attempts = new Map<string, { start: number; count: number }>();
  const rates = new WeakMap<WebSocket, { start: number; count: number }>();
  const alive = new WeakSet<WebSocket>();
  const clientIps = new WeakMap<WebSocket, string>();
  const rejected = (ws: WebSocket, code: string, message: string, requestId?: string) =>
    emit(ws, { v: 1, type: "error", code, message, ...(requestId ? { requestId } : {}) });
  const status = (s: Session) => {
    for (const peer of s.controllers.values()) emit(peer.socket, { ...scope(s, peer.deviceId), type: "status", ownerAvailable: s.ownerAvailable && open(s.computer.socket),
      ...(!s.ownerAvailable || !open(s.computer.socket) ? { reason: "电脑 owner 不可用，请在电脑打开 Vivic 控制页。" } : {}) });
  };
  const controller = (s: Session, p: Peer, state: "joined" | "left") =>
    emit(s.computer.socket, { ...scope(s, p.deviceId), type: "controller", state, permissions: [...p.permissions] });
  const removePairing = (s: Session) => {
    if (s.pairCode) pairings.delete(s.pairCode);
    delete s.pairCode; delete s.pairExpiresAt;
  };
  const rotatePairing = (s: Session) => {
    removePairing(s);
    // 64 random bits as 16 hex characters; a single successful use consumes it.
    s.pairCode = randomBytes(8).toString("hex").toUpperCase();
    s.pairExpiresAt = now() + (options.pairTtlMs ?? 120_000);
    pairings.set(s.pairCode, s);
  };
  const revokePeer = (s: Session, p: Peer, reason: string) => {
    s.controllers.delete(p.deviceId);
    controller(s, p, "left");
    emit(p.socket, { ...scope(s, p.deviceId), type: "revoked", reason });
    if (p.socket) { auth.delete(p.socket); p.socket.close(4003, "Session revoked"); }
    delete p.socket;
  };
  const revokeSession = (s: Session, reason: string) => {
    sessions.delete(s.id); removePairing(s);
    for (const p of [...s.controllers.values()]) revokePeer(s, p, reason);
    emit(s.computer.socket, { ...scope(s, s.computer.deviceId), type: "revoked", reason });
    if (s.computer.socket) { auth.delete(s.computer.socket); s.computer.socket.close(4003, "Session revoked"); }
  };
  const prune = () => {
    for (const s of sessions.values()) {
      if (s.expiresAt <= now()) revokeSession(s, "控制会话已过期，请重新配对。");
      else if ((s.pairExpiresAt ?? Infinity) <= now()) removePairing(s);
    }
    for (const [ip, record] of attempts) if (now() - record.start > 60_000) attempts.delete(ip);
  };
  const welcome = (s: Session, p: Peer, secret: string, role: "computer" | "mobile") => {
    emit(p.socket, { v: 1, type: "welcome", sessionId: s.id, epoch: s.epoch, deviceId: p.deviceId,
      computerId: s.computer.deviceId, token: secret, expiresAt: s.expiresAt, permissions: [...p.permissions],
      ...(role === "computer" ? {
        ...(s.pairCode ? { pairCode: s.pairCode, pairExpiresAt: s.pairExpiresAt } : {}),
        controllers: [...s.controllers.values()].filter(p => open(p.socket)).map(p => ({ deviceId: p.deviceId, permissions: [...p.permissions] })),
      } : {}),
    });
  };
  const bind = (ws: WebSocket, s: Session, p: Peer, role: "computer" | "mobile", secret: string) => {
    const previous = p.socket;
    if (previous) { auth.delete(previous); previous.close(4001, "Connection replaced"); }
    p.socket = ws; auth.set(ws, { session: s, peer: p, role });
    welcome(s, p, secret, role);
    if (role === "mobile") controller(s, p, "joined");
    else s.ownerAvailable = false; // Reconnected owner must report its actual availability.
    status(s);
  };
  const authenticate = (ws: WebSocket, hello: Hello, ip: string) => {
    prune();
    // Upgrade validated this identity against the explicit proxy boundary; it is fixed for this connection.
    let record = attempts.get(ip);
    if (!record) {
      if (attempts.size >= 2048) return rejected(ws, "rate-limit", "连接请求过多，请稍后重试。");
      record = { start: now(), count: 0 }; attempts.set(ip, record);
    }
    if (++record.count > 20) return rejected(ws, "rate-limit", "配对尝试过多，请一分钟后重试。");
    if (hello.token) {
      const existing = [...sessions.values()].find(s => hello.role === "computer"
        ? s.computer.deviceId === hello.deviceId && equal(s.computer.tokenHash, hash(hello.token!))
        : s.controllers.get(hello.deviceId)?.tokenHash === hash(hello.token!));
      if (!existing) return rejected(ws, "invalid-session", "会话已过期或撤销，请重新配对。");
      const peer = hello.role === "computer" ? existing.computer : existing.controllers.get(hello.deviceId)!;
      bind(ws, existing, peer, hello.role, hello.token); return;
    }
    if (hello.role === "computer") {
      if (!hello.accessKey || !equal(hello.accessKey, options.admissionSecret)) return rejected(ws, "unauthorized", "中继接入凭据无效。");
      if (sessions.size >= (options.maxSessions ?? 100)) return rejected(ws, "capacity", "中继当前已满，请稍后重试。");
      if ([...sessions.values()].some(s => s.computer.deviceId === hello.deviceId)) return rejected(ws, "device-exists", "电脑会话已存在，请使用原会话重连。");
      const secret = token();
      const computer: Peer = { deviceId: hello.deviceId, name: hello.deviceName, tokenHash: hash(secret), permissions: [...PERMISSIONS] };
      const s: Session = { id: id("session"), epoch: id("epoch"), computer, controllers: new Map(), ownerAvailable: false,
        expiresAt: now() + (options.sessionTtlMs ?? 8 * 60 * 60_000) };
      sessions.set(s.id, s); rotatePairing(s); bind(ws, s, computer, "computer", secret); return;
    }
    const s = pairings.get(hello.pairCode ?? "");
    if (!s || !s.pairExpiresAt || s.pairExpiresAt <= now()) return rejected(ws, "invalid-pairing", "配对码错误、已使用或已过期，请在电脑生成新码。");
    if (!open(s.computer.socket) || !s.ownerAvailable) return rejected(ws, "owner-offline", "电脑 owner 不可用，不能配对。");
    if (s.controllers.size >= (options.maxControllers ?? 4)) return rejected(ws, "capacity", "已达手机数量上限，请在电脑撤销旧设备。");
    if (s.computer.deviceId === hello.deviceId || s.controllers.has(hello.deviceId)) return rejected(ws, "device-exists", "设备身份重复，请重新连接。");
    const secret = token();
    const p: Peer = { deviceId: hello.deviceId, name: hello.deviceName, tokenHash: hash(secret), permissions: [...PERMISSIONS] };
    removePairing(s); s.controllers.set(p.deviceId, p); bind(ws, s, p, "mobile", secret);
  };

  const server: Server = createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET" && req.url === "/healthz") { res.end(JSON.stringify({ ok: true, service: "vivic-mobile-relay", protocol: 1 })); return; }
    res.writeHead(404); res.end('{"error":"not-found"}');
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
  server.on("upgrade", (req, socket, head) => {
    const rejectUpgrade = () => { socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); socket.destroy(); };
    const peerIp = canonicalIp(req.socket.remoteAddress ?? "");
    const fromTrustedProxy = !!peerIp && trustedProxies.has(peerIp);
    const forwardedIp = req.headers["x-forwarded-for"];
    // A trusted proxy must overwrite this with one IP, never append a client-controlled chain.
    const clientIp = fromTrustedProxy ? (typeof forwardedIp === "string" ? canonicalIp(forwardedIp) : undefined) : peerIp;
    // No query parameters: credentials must travel only in validated first frames.
    if (req.url !== "/relay" || !req.headers.origin || !origins.has(req.headers.origin)
      || !clientIp || (options.publicMode && (!fromTrustedProxy || req.headers["x-forwarded-proto"] !== "https"))
      || wss.clients.size >= 256) return rejectUpgrade();
    wss.handleUpgrade(req, socket, head, ws => { clientIps.set(ws, clientIp); wss.emit("connection", ws, req); });
  });
  wss.on("connection", ws => {
    alive.add(ws);
    const timer = setTimeout(() => { if (!auth.has(ws)) ws.close(4000, "Authentication timeout"); }, 5000);
    timer.unref();
    ws.on("pong", () => alive.add(ws));
    ws.on("error", () => undefined); // Neither payloads nor credential-bearing errors are logged.
    ws.on("message", (raw, binary) => {
      // Malformed frames consume the same budget as valid requests, before parsing/responding.
      let rate = rates.get(ws);
      if (!rate || now() - rate.start > 10_000) { rate = { start: now(), count: 0 }; rates.set(ws, rate); }
      if (++rate.count > 100) { rejected(ws, "rate-limit", "消息过多，请稍后重试。"); ws.close(4008); return; }
      if (binary) { rejected(ws, "invalid-frame", "仅支持 JSON 文本消息。"); ws.close(1003); return; }
      const frame = parseFrame(raw.toString());
      if (!frame) { rejected(ws, "invalid-frame", "消息未通过控制协议校验。"); return; }
      const a = auth.get(ws);
      if (!a) {
        if (frame.type !== "hello") { rejected(ws, "unauthorized", "请先完成配对或重连。"); return; }
        authenticate(ws, frame, clientIps.get(ws)!); return;
      }
      const { session: s, peer: p, role } = a;
      if (s.expiresAt <= now() || !sessions.has(s.id)) { revokeSession(s, "控制会话已过期，请重新配对。"); return; }
      if (!("sessionId" in frame) || frame.sessionId !== s.id || frame.epoch !== s.epoch || frame.deviceId !== p.deviceId) {
        rejected(ws, "scope-mismatch", "设备或会话范围不匹配。"); return;
      }
      if (frame.type === "heartbeat") { emit(ws, { ...scope(s, p.deviceId), type: "pong", at: frame.at }); return; }
      if (frame.type === "pong") return;
      if (frame.type === "revoke") {
        if (role === "mobile") {
          if (frame.targetDeviceId && frame.targetDeviceId !== p.deviceId) return rejected(ws, "forbidden", "不能撤销其他设备。");
          revokePeer(s, p, "已退出手机控制。");
        } else if (frame.targetDeviceId) {
          const target = s.controllers.get(frame.targetDeviceId);
          if (target) revokePeer(s, target, "电脑已撤销本设备的控制权限。");
        } else revokeSession(s, "电脑已关闭远程控制，请重新配对。");
        return;
      }
      if (role === "computer") {
        if (frame.type === "owner.status") {
          if (s.ownerAvailable !== frame.available) { s.ownerAvailable = frame.available; status(s); }
          return;
        }
        if (frame.type === "pair.rotate") { rotatePairing(s); emit(ws, { ...scope(s, p.deviceId), type: "pairing", pairCode: s.pairCode!, pairExpiresAt: s.pairExpiresAt! }); return; }
        if (frame.type === "snapshot") { for (const target of s.controllers.values()) emit(target.socket, frame); return; }
        if (frame.type === "result" || frame.type === "executing" || frame.type === "file.chunk" || frame.type === "file.error") {
          emit(s.controllers.get(frame.forDeviceId)?.socket, frame); return;
        }
        rejected(ws, "forbidden", "电脑不能发送此控制消息。"); return;
      }
      if (frame.type === "command" || frame.type === "cancel" || frame.type === "query" || frame.type === "snapshot.request" || frame.type === "file.request") {
        if (!open(s.computer.socket) || !s.ownerAvailable) { rejected(ws, "owner-offline", "电脑 owner 不可用；本次消息未转交。", "requestId" in frame ? frame.requestId : undefined); return; }
        if (frame.type === "file.request" && !p.permissions.includes(frame.imageId ? "image.read" : "file.read")) { rejected(ws, "forbidden", "本会话未授权读取此内容。", frame.requestId); return; }
        if (frame.type === "command" && !p.permissions.includes(frame.operation.kind)) { rejected(ws, "forbidden", "本会话未授权此操作。", frame.requestId); return; }
        if (!emit(s.computer.socket, frame)) {
          rejected(ws, "owner-offline", "电脑连接无法接收；本次消息未转交。", "requestId" in frame ? frame.requestId : undefined); return;
        }
        if (frame.type === "command") emit(ws, { ...scope(s, p.deviceId), type: "accepted", requestId: frame.requestId });
        return;
      }
      rejected(ws, "forbidden", "手机不能发送此控制消息。");
    });
    ws.on("close", () => {
      clearTimeout(timer);
      const a = auth.get(ws); auth.delete(ws);
      if (!a || a.peer.socket !== ws) return;
      delete a.peer.socket;
      if (a.role === "computer") { a.session.ownerAvailable = false; status(a.session); }
      else controller(a.session, a.peer, "left");
    });
  });
  const heartbeat = setInterval(() => {
    prune();
    for (const ws of wss.clients) {
      if (!alive.has(ws)) { ws.terminate(); continue; }
      alive.delete(ws); ws.ping();
    }
  }, options.heartbeatMs ?? 15_000);
  heartbeat.unref();
  return {
    server,
    async listen(port = 8791, host = "127.0.0.1") {
      if (!["127.0.0.1", "::1", "localhost"].includes(host)) throw new Error("Relay upstream must bind loopback; remote clients require the TLS reverse proxy.");
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, host, () => { server.off("error", reject); resolve(); }); });
      return server.address() as AddressInfo;
    },
    async close() {
      clearInterval(heartbeat);
      for (const s of [...sessions.values()]) revokeSession(s, "中继已停止，请重新配对。");
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>(resolve => wss.close(() => resolve()));
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
