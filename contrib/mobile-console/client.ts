import { OperationSchema, type CanvasSnapshot, type Frame, type Operation, type Permission, type Welcome } from "./protocol";
import { createWebSocketTransport, type Transport } from "./transport";
import { createFileClient, type DownloadedFile } from "./fileClient";

export type MobileStatus = "unpaired" | "connecting" | "connected" | "reconnecting" | "offline" | "expired" | "revoked" | "error";
export interface RequestState {
  requestId: string; operation: Operation; canvasId: string;
  status: "sending" | "accepted" | "executing" | "succeeded" | "rejected" | "cancelled" | "unknown";
  message: string;
}
export interface MobileState {
  status: MobileStatus; snapshot: CanvasSnapshot | null; requests: RequestState[];
  error: string | null; expiresAt: number | null;
  /** Negotiated grants; absent on older injected clients, never imply portal permission. */
  permissions?: Permission[];
}
export interface MobileClient {
  getSnapshot(): MobileState;
  subscribe(listener: () => void): () => void;
  pair(relayUrl: string, pairCode: string): void;
  reconnect(): void;
  disconnect(): void;
  revoke(): void;
  submit(operation: Operation): string | null;
  cancel(requestId: string): void;
  query(requestId: string): void;
  refresh(): void;
  readFile?(cardId: string, onProgress?: (received: number, total: number) => void, signal?: AbortSignal): Promise<DownloadedFile>;
  readImage?(cardId: string, imageId: string, signal?: AbortSignal): Promise<DownloadedFile>;
}
export interface MobileClientOptions {
  id?: string; name?: string; transportFactory?: (url: string) => Transport;
  requestTimeoutMs?: number; reconnectDelayMs?: number; now?: () => number;
}
const pending = (r: RequestState) => ["sending", "accepted", "executing"].includes(r.status);

/** Tokens are held only by this closure. A document refresh deliberately requires pairing again. */
export function createMobileClient(options: MobileClientOptions = {}): MobileClient {
  const deviceId = options.id ?? crypto.randomUUID();
  const name = options.name ?? "我的手机";
  const now = options.now ?? Date.now;
  const listeners = new Set<() => void>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let state: MobileState = { status: "unpaired", snapshot: null, requests: [], error: null, expiresAt: null };
  let transport: Transport | null = null;
  let unsubscribe: (() => void) | null = null;
  let welcome: Welcome | null = null;
  let token: string | null = null;
  let relayUrl = "";
  let pairCode: string | null = null;
  let sequence = -1;
  let lastSeen = now();
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let generation = 0;
  const emit = () => listeners.forEach(listener => listener());
  const patch = (next: Partial<MobileState>) => { state = { ...state, ...next }; emit(); };
  const scope = () => welcome ? { v: 1 as const, sessionId: welcome.sessionId, deviceId, epoch: welcome.epoch } : null;
  const send = (frame: Frame) => transport?.send(frame) ?? false;
  const stopLoops = () => {
    if (heartbeat) clearInterval(heartbeat); heartbeat = null;
    if (reconnectTimer) clearTimeout(reconnectTimer); reconnectTimer = null;
  };
  const clearRequests = () => { timers.forEach(clearTimeout); timers.clear(); };
  const uncertain = () => {
    clearRequests();
    state = { ...state, requests: state.requests.map(r => pending(r) ? { ...r, status: "unknown", message: "执行结果未确认，请先查询结果；不会自动重发。" } : r) };
  };
  const expire = (status: "expired" | "revoked", message: string) => {
    fileClient.cancel("手机授权已结束，下载已取消");
    stopped = true; generation++; stopLoops(); clearRequests();
    unsubscribe?.(); unsubscribe = null;
    if (expiryTimer) clearTimeout(expiryTimer); expiryTimer = null;
    token = null; welcome = null; transport?.close();
    uncertain(); patch({ status, snapshot: null, expiresAt: null, permissions: [], error: message });
  };
  const modifyRequest = (id: string, change: Partial<RequestState>) => {
    const current = state.requests.find(r => r.requestId === id);
    if (!current || ["succeeded", "rejected", "cancelled"].includes(current.status)) return;
    const progress = change.status === "accepted" || change.status === "executing";
    // A delivery/progress frame cannot resolve an unknown write or move execution backwards.
    if (progress && (!pending(current) || current.status === "executing" && change.status === "accepted")) return;
    if (!progress) {
      const timer = timers.get(id); if (timer) clearTimeout(timer); timers.delete(id);
    }
    patch({ requests: state.requests.map(r => r === current ? { ...r, ...change } : r) });
  };
  const requestTimer = (id: string) => {
    // One deadline per submission. Repeated progress cannot keep it alive forever.
    if (timers.has(id) || !state.requests.some(r => r.requestId === id && pending(r))) return;
    timers.set(id, setTimeout(() => modifyRequest(id, { status: "unknown", message: "电脑尚未确认结果，请查询；不会自动重发。" }), options.requestTimeoutMs ?? 20000));
  };
  const scoped = (frame: Frame) => welcome && "sessionId" in frame && frame.sessionId === welcome.sessionId && frame.epoch === welcome.epoch;
  const connected = () => !stopped && state.status === "connected" && !!welcome && now() < welcome.expiresAt;
  const fileClient = createFileClient({ now, send, context: () => connected() && welcome && state.snapshot ? { welcome, snapshot: state.snapshot, deviceId } : null });
  function lost(reason: string) {
    if (stopped) return;
    fileClient.cancel("连接已断开，请重新连接后下载");
    if (heartbeat) clearInterval(heartbeat); heartbeat = null;
    uncertain();
    patch({ status: token ? "offline" : "error", error: reason, snapshot: state.snapshot ? { ...state.snapshot, ownerAvailable: false } : null });
    if (token && !reconnectTimer) reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(true); }, options.reconnectDelayMs ?? 1500);
  }
  function receive(frame: Frame) {
    lastSeen = now();
    if (fileClient.receive(frame)) return;
    if (frame.type === "welcome") {
      if (frame.deviceId !== deviceId) return;
      if (welcome && (frame.sessionId !== welcome.sessionId || frame.epoch !== welcome.epoch)) { expire("expired", "配对会话已改变，请重新配对。"); return; }
      welcome = frame; token = frame.token; pairCode = null;
      patch({ status: "connected", error: null, expiresAt: frame.expiresAt, permissions: [...frame.permissions] });
      if (expiryTimer) clearTimeout(expiryTimer);
      expiryTimer = setTimeout(() => expire("expired", "配对已过期，请在电脑重新生成配对码。"), Math.max(0, frame.expiresAt - now()));
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = setInterval(() => {
        if (now() - lastSeen > 30000) { transport?.close(); lost("中继心跳超时"); return; }
        const s = scope(); if (s) send({ ...s, type: "heartbeat", at: now() });
      }, 8000);
      const s = scope(); if (s) send({ ...s, type: "snapshot.request" });
      for (const r of state.requests.filter(r => r.status === "unknown")) client.query(r.requestId);
      return;
    }
    if (frame.type === "error") {
      // A relay/query error cannot establish whether an earlier write committed on the computer.
      if (frame.requestId) modifyRequest(frame.requestId, { status: "unknown", message: `${frame.message} 请先核对电脑执行结果。` });
      else if (/expired|unauthorized|revoked|auth|invalid-session/i.test(frame.code) && token) expire("expired", frame.message);
      else patch({ error: frame.message, ...(welcome ? {} : { status: "error" as const }) });
      return;
    }
    if (!scoped(frame)) return;
    if (frame.type === "revoked") { expire("revoked", frame.reason); return; }
    if (frame.type === "status") {
      if (!frame.ownerAvailable) { fileClient.cancel("电脑控制页不可用，下载已取消"); uncertain(); patch({ snapshot: state.snapshot ? { ...state.snapshot, ownerAvailable: false } : null, error: frame.reason ?? "电脑 owner 当前不可用" }); }
      else { const s = scope(); if (s) send({ ...s, type: "snapshot.request" }); }
      return;
    }
    if (frame.type === "snapshot" && frame.deviceId === welcome?.computerId && (frame.sequence > sequence || frame.state.ownerEpoch !== state.snapshot?.ownerEpoch)) {
      // A refreshed owner has a new attachment lease and a fresh sequence. An
      // outstanding command remains uncertain and is never resubmitted.
      if (state.snapshot && frame.state.ownerEpoch !== state.snapshot.ownerEpoch) { fileClient.cancel("电脑控制页已恢复，请重新打开文件"); uncertain(); }
      sequence = frame.sequence; patch({ snapshot: frame.state, error: frame.state.ownerAvailable ? null : "电脑 owner 当前不可用" }); fileClient.reconcile();
    } else if (frame.type === "accepted" && frame.deviceId === deviceId) {
      modifyRequest(frame.requestId, { status: "accepted", message: "中继已送达，等待电脑执行确认。" }); requestTimer(frame.requestId);
    } else if (frame.type === "executing" && frame.deviceId === welcome?.computerId && frame.forDeviceId === deviceId) {
      modifyRequest(frame.requestId, { status: "executing", message: "电脑正在执行。" }); requestTimer(frame.requestId);
    } else if (frame.type === "result" && frame.deviceId === welcome?.computerId && frame.forDeviceId === deviceId) {
      modifyRequest(frame.requestId, { status: frame.status, message: frame.message });
      const s = scope(); if (s) send({ ...s, type: "snapshot.request" });
    }
  }
  function connect(resuming: boolean) {
    if (!relayUrl || (resuming && !token)) return;
    if (welcome && now() >= welcome.expiresAt) { expire("expired", "配对已过期，请重新配对。"); return; }
    const currentGeneration = ++generation;
    stopped = false; stopLoops(); unsubscribe?.(); transport?.close();
    patch({ status: resuming ? "reconnecting" : "connecting", error: null,
      snapshot: state.snapshot ? { ...state.snapshot, ownerAvailable: false } : null });
    try {
      transport = (options.transportFactory ?? createWebSocketTransport)(relayUrl);
      unsubscribe = transport.subscribe(event => {
        if (stopped || generation !== currentGeneration) return;
        if (event.type === "open") transport?.send({ v: 1, type: "hello", role: "mobile", deviceId, deviceName: name,
          ...(resuming && token ? { token } : { pairCode: pairCode ?? "" }) });
        else if (event.type === "message") receive(event.frame);
        else lost(event.reason);
      });
      transport.connect();
    } catch (error) { patch({ status: "error", error: error instanceof Error ? error.message : "中继地址无效" }); }
  }
  const client: MobileClient = {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    pair(url, code) {
      fileClient.cancel("配对已变化，下载已取消");
      stopped = true; generation++; stopLoops(); clearRequests(); unsubscribe?.(); transport?.close();
      if (expiryTimer) clearTimeout(expiryTimer); expiryTimer = null;
      welcome = null; token = null; sequence = -1; relayUrl = url; pairCode = code.trim().toUpperCase();
      state = { status: "unpaired", snapshot: null, requests: [], error: null, expiresAt: null };
      connect(false);
    },
    reconnect() { if (token) { uncertain(); connect(true); } else patch({ status: "unpaired", error: "请重新配对；凭据未保存在浏览器中。" }); },
    disconnect() {
      fileClient.cancel("连接已断开，下载已取消");
      stopped = true; generation++; stopLoops(); unsubscribe?.(); unsubscribe = null; transport?.close(); uncertain();
      patch({ status: welcome ? "offline" : "unpaired", snapshot: state.snapshot ? { ...state.snapshot, ownerAvailable: false } : null });
    },
    revoke() { const s = scope(); if (s) send({ ...s, type: "revoke", targetDeviceId: deviceId }); expire("revoked", "已在此手机退出配对。"); },
    submit(raw) {
      const operation = OperationSchema.safeParse(raw); const current = state.snapshot; const s = scope();
      if (!operation.success || !connected() || !current?.ownerAvailable || !current.activeCanvasId || !s) return null;
      if (!welcome!.permissions.includes(operation.data.kind)) { patch({ error: "此设备没有该操作权限。" }); return null; }
      // Serialize writes in the UI; a second write must use the confirmed new canvas version.
      if (state.requests.some(r => pending(r) || r.status === "unknown")) { patch({ error: "请先查询未确认的请求结果；结果未知时请核对电脑状态并重新配对。" }); return null; }
      const requestId = crypto.randomUUID();
      const r: RequestState = { requestId, operation: operation.data, canvasId: current.activeCanvasId, status: "sending", message: "正在发送，尚未确认执行。" };
      patch({ requests: [...state.requests.slice(-99), r], error: null });
      const sent = send({ ...s, type: "command", requestId, canvasId: current.activeCanvasId, ownerEpoch: current.ownerEpoch,
        expectedVersion: current.version, operation: operation.data });
      if (!sent) modifyRequest(requestId, { status: "unknown", message: "发送未确认，请查询结果后决定是否重新发起。" });
      else requestTimer(requestId);
      return requestId;
    },
    cancel(id) { const r = state.requests.find(r => r.requestId === id); const s = scope(); if (r && s && connected()) send({ ...s, type: "cancel", requestId: id, canvasId: r.canvasId }); },
    query(id) { const r = state.requests.find(r => r.requestId === id); const s = scope(); if (r && s && connected()) send({ ...s, type: "query", requestId: id, canvasId: r.canvasId }); },
    refresh() { const s = scope(); if (s && connected()) send({ ...s, type: "snapshot.request" }); },
    readFile: fileClient.read,
    readImage: (cardId, imageId, signal) => fileClient.read(cardId, undefined, signal, imageId),
  };
  return client;
}
