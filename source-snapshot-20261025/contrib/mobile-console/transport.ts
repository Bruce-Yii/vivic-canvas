import { MAX_BUFFERED_BYTES, parseFrame, serializeFrame, type Frame } from "./protocol";

export type TransportEvent = { type: "open" } | { type: "message"; frame: Frame } | { type: "disconnect"; reason: string };
export interface Transport {
  connect(): void;
  send(frame: Frame): boolean;
  close(): void;
  subscribe(listener: (event: TransportEvent) => void): () => void;
}
export interface BrowserSocket {
  readyState: number;
  bufferedAmount?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: any) => void): void;
}

/** TLS is mandatory except for explicit loopback development; credentials never enter URLs. */
export function validateRelayUrl(value: string): string {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "wss:" && !(url.protocol === "ws:" && loopback))) {
    throw new Error("中继必须使用 WSS；仅本机开发允许 WS，地址不能包含凭据或查询参数。");
  }
  return url.toString();
}

export function createWebSocketTransport(value: string, socketFactory: (url: string) => BrowserSocket = url => new WebSocket(url)): Transport {
  const url = validateRelayUrl(value);
  const listeners = new Set<(event: TransportEvent) => void>();
  let socket: BrowserSocket | null = null;
  let generation = 0;
  const emit = (event: TransportEvent) => listeners.forEach(listener => listener(event));
  return {
    connect() {
      const current = ++generation;
      socket?.close();
      try {
        const active = socketFactory(url);
        socket = active;
        active.addEventListener("open", () => { if (generation === current) emit({ type: "open" }); });
        active.addEventListener("message", (event: MessageEvent) => {
          if (generation !== current) return;
          const frame = typeof event.data === "string" ? parseFrame(event.data) : null;
          if (!frame) { active.close(1008, "Invalid frame"); return; }
          emit({ type: "message", frame });
        });
        active.addEventListener("close", () => { if (generation === current) emit({ type: "disconnect", reason: "中继连接已断开" }); });
        active.addEventListener("error", () => { if (generation === current) emit({ type: "disconnect", reason: "无法连接中继" }); });
      } catch { emit({ type: "disconnect", reason: "无法连接中继" }); }
    },
    send(frame) {
      if (!socket || socket.readyState !== 1) return false;
      const serialized = serializeFrame(frame);
      if (!serialized) return false;
      if ((socket.bufferedAmount ?? 0) + new TextEncoder().encode(serialized).byteLength > MAX_BUFFERED_BYTES) {
        socket.close(4008, "Outgoing buffer limit");
        return false;
      }
      try { socket.send(serialized); return true; } catch { return false; }
    },
    close() { generation += 1; socket?.close(1000, "Client closed"); socket = null; },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

/** Same protocol over bounded HTTPS requests. Tokens stay in this closure, never a URL/storage. */
export function createOnlineHttpTransport(value: string, role: "owner" | "phone", request: typeof fetch = fetch): Transport {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== `/api/online/mobile/${role}` ||
    !(url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("线上连接必须使用受信的 HTTPS Vivic 地址。");
  const listeners = new Set<(event: TransportEvent) => void>();
  let generation = 0, active = false, connectionId: string | null = null, polling: AbortController | null = null;
  let queue = Promise.resolve(), pendingBytes = 0;
  const emit = (event: TransportEvent) => listeners.forEach(listener => listener(event));
  const post = async (action: string, body: unknown, signal?: AbortSignal) => {
    const response = await request(`${url.href}/${action}`, { method: "POST", credentials: role === "owner" ? "same-origin" : "omit",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store", redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000), keepalive: action === "disconnect" });
    const raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BUFFERED_BYTES + 4096) throw new Error("invalid-mobile-response");
    const result = JSON.parse(raw) as { ok?: boolean; code?: string; connectionId?: string; frames?: unknown[] };
    if (!response.ok || !result.ok) throw new Error(result.code ?? "online-mobile-unavailable");
    return result;
  };
  const frames = (items: unknown[] | undefined) => {
    if (!Array.isArray(items) || items.length > 256) throw new Error("invalid-mobile-response");
    for (const raw of items) { const frame = parseFrame(raw); if (!frame) throw new Error("invalid-mobile-response"); emit({ type: "message", frame }); }
  };
  const lost = (error: unknown, current: number) => {
    if (!active || current !== generation) return;
    active = false; polling?.abort();
    const code = error instanceof Error ? error.message : "online-mobile-unavailable";
    if (["invalid-session", "online-session-required", "invalid-pairing", "owner-exists"].includes(code)) {
      emit({ type: "message", frame: { v: 1, type: "error", code: code === "invalid-pairing" ? code : "invalid-session", message: code === "invalid-pairing" ? "配对码已使用或过期，请在电脑生成新码。"
        : code === "owner-exists" ? "另一电脑标签页正在分享此工作区，请先在该页停止手机控制。" : "控制会话已结束，请在电脑重新配对。" } });
      return;
    }
    emit({ type: "disconnect", reason: "线上连接已断开，请检查电脑控制页后重连。" });
  };
  const poll = async (current: number) => {
    while (active && current === generation && connectionId) {
      polling = new AbortController();
      try { const result = await post("poll", { connectionId }, polling.signal); if (active && current === generation) frames(result.frames); }
      catch (error) { lost(error, current); return; }
    }
  };
  const transport: Transport = {
    connect() { transport.close(); active = true; const current = ++generation; queue = Promise.resolve(); pendingBytes = 0;
      queueMicrotask(() => { if (active && current === generation) emit({ type: "open" }); }); },
    send(frame) {
      if (!active) return false;
      const raw = serializeFrame(frame), current = generation, sendingConnection = connectionId;
      if (!raw) return false;
      const bytes = new TextEncoder().encode(raw).byteLength;
      if (pendingBytes + bytes > MAX_BUFFERED_BYTES) { lost(new Error("outgoing-buffer-limit"), current); return false; }
      pendingBytes += bytes;
      queue = queue.then(async () => {
        if (frame.type === "hello") {
          const result = await post("connect", { frame });
          if (!active || current !== generation) {
            if (result.connectionId) void post("disconnect", { connectionId: result.connectionId }).catch(() => {});
            return;
          }
          if (!result.connectionId || !/^[A-Za-z0-9_-]{43}$/.test(result.connectionId)) throw new Error("invalid-mobile-response");
          connectionId = result.connectionId; frames(result.frames); void poll(current);
        } else {
          const id = sendingConnection ?? (current === generation ? connectionId : null);
          if (id) await post("send", { connectionId: id, frame });
        }
      }).catch(error => lost(error, current)).finally(() => { if (generation === current) pendingBytes -= bytes; });
      return true;
    },
    close() {
      active = false; generation++; polling?.abort(); polling = null;
      const previous = connectionId; connectionId = null;
      if (previous) void queue.finally(() => post("disconnect", { connectionId: previous }).catch(() => {}));
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return transport;
}
