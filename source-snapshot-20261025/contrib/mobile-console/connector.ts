import { CanvasSnapshotSchema, FileChunkDataSchema, PERMISSIONS, serializeFrame, type CanvasSnapshot, type Command, type Frame, type Permission, type Result, type Welcome, type FileChunkData } from "./protocol";
import type { Transport } from "./transport";

export interface HostMutationContext { isCurrent(): boolean; withCommit?<T>(write: () => T): T }
export interface ComputerHostAdapter {
  getSnapshot(): CanvasSnapshot;
  subscribe(listener: () => void): () => void;
  /** Resolve only after owner execution. Honor signal/isCurrent immediately before every commit. */
  submitText(text: string, context: { requestId: string; signal: AbortSignal; isCurrent(): boolean; conversationId?: string; withCommit?<T>(write: () => T): T }): Promise<{ ok: boolean; message: string }>;
  switchCanvas(id: string, context?: { isCurrent(): boolean }): { ok: boolean; message: string } | Promise<{ ok: boolean; message: string }>;
  setCardPinned(cardId: string, pinned: boolean): { ok: boolean; message: string } | Promise<{ ok: boolean; message: string }>;
  setCardSurface?(cardId: string, surface: "display" | "user", context?: HostMutationContext): { ok: boolean; message: string } | Promise<{ ok: boolean; message: string }>;
  readFileChunk?(cardId: string, offset: number, context: { isCurrent(): boolean }): Promise<FileChunkData>;
  readImageChunk?(cardId: string, imageId: string, offset: number, context: { isCurrent(): boolean }): Promise<FileChunkData>;
}
export interface ConnectorState {
  status: "stopped" | "connecting" | "connected" | "offline" | "expired" | "error";
  pairCode: string | null; pairExpiresAt: number | null; expiresAt: number | null;
  controllers: string[]; error: string | null;
}
export interface ComputerConnectorOptions {
  transport: Transport; deviceId: string; deviceName: string; accessKey?: string; token?: string;
  host: ComputerHostAdapter; now?: () => number; maxRequests?: number; reconnectDelayMs?: number;
}
interface Entry { command: Command; fingerprint: string; abort: AbortController; started: boolean; result?: Result; committedVersion?: number }

/** Owns no canvas/store. Only a leased, validated adapter to the existing elected owner. */
export function createComputerConnector(options: ComputerConnectorOptions) {
  const { transport, host, deviceId } = options;
  const now = options.now ?? Date.now;
  const permissions = new Map<string, Permission[]>();
  // Owner initiated revocations take effect locally even before the relay acknowledges them.
  const locallyRevoked = new Set<string>();
  const ledger = new Map<string, Entry>();
  const fileReads = new Set<string>();
  const listeners = new Set<() => void>();
  let state: ConnectorState = { status: "stopped", pairCode: null, pairExpiresAt: null, expiresAt: null, controllers: [], error: null };
  let welcome: Welcome | null = null;
  let token = options.token;
  let active = false;
  let finished = false;
  let connected = false;
  let sequence = 0;
  let advertisedAvailability: boolean | null = null;
  let snapshotError = false;
  let lastSeen = now();
  let queue = Promise.resolve();
  let unsubTransport: (() => void) | null = null;
  let unsubHost: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let reconnect: ReturnType<typeof setTimeout> | null = null;
  let expiry: ReturnType<typeof setTimeout> | null = null;
  const emit = (next: Partial<ConnectorState>) => { state = { ...state, ...next }; listeners.forEach(listener => listener()); };
  const scope = () => welcome ? { v: 1 as const, sessionId: welcome.sessionId, deviceId, epoch: welcome.epoch } : null;
  const send = (frame: Frame) => connected && transport.send(frame);
  const key = (sessionId: string, epoch: string, sender: string, requestId: string) => `${sessionId}:${epoch}:${sender}:${requestId}`;
  const scoped = (frame: Frame) => Boolean(welcome && "sessionId" in frame && frame.sessionId === welcome.sessionId && frame.epoch === welcome.epoch && now() < welcome.expiresAt);
  const authorized = (sender: string, kind?: Permission) => permissions.has(sender) && (!kind || permissions.get(sender)!.includes(kind));
  const hostSnapshot = () => CanvasSnapshotSchema.parse(host.getSnapshot());
  function publishSnapshot() {
    const s = scope(); if (!s || !connected) return;
    try {
      const snapshot = hostSnapshot();
      const cards = snapshot.cards.map(card => {
        // Older deployed relays have strict v1 schemas: omit additive content
        // unless this session explicitly advertises the corresponding new grant.
        const { subcards, file, images, imageNotice, section, priority, dueDate, ...legacy } = card;
        return { ...legacy, ...(welcome?.permissions.includes("card.surface") && subcards ? { subcards } : {}),
          ...(welcome?.permissions.includes("card.surface") ? { ...(section ? { section } : {}), ...(priority ? { priority } : {}), ...(dueDate ? { dueDate } : {}) } : {}),
          ...(welcome?.permissions.includes("file.read") && file ? { file } : {}),
          ...(welcome?.permissions.includes("image.read") ? { ...(images ? { images } : {}), ...(imageNotice ? { imageNotice } : {}) } : {}) };
      });
      const frame: Extract<Frame, { type: "snapshot" }> = { ...s, type: "snapshot", sequence: ++sequence, state: { ...snapshot, cards } };
      // Schema row/character limits alone do not bound UTF-8 bytes. Retain navigation and
      // the active canvas. First remove previews from the end, then trim summaries.
      // Clones keep the adapter's snapshot and its card objects untouched.
      const fit = <T>(rows: T[], assign: (rows: T[]) => void) => {
        let low = 0, high = rows.length;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          assign(rows.slice(0, middle));
          if (serializeFrame(frame)) low = middle; else high = middle - 1;
        }
        assign(rows.slice(0, low));
      };
      if (!serializeFrame(frame)) {
        frame.state.cardCount = snapshot.cardCount ?? snapshot.cards.length;
        frame.state.cardsTruncated = true;
        const summaries = cards.map(({ preview: _preview, subcards: _subcards, file: _file, images: _images, imageNotice: _notice, ...summary }) => summary);
        // A prefix of full previews is equivalent to stripping from the end.
        // Binary fitting avoids repeatedly serializing every large table/card.
        fit(cards, prefix => { frame.state.cards = cards.map((card, index) => index < prefix.length ? card : summaries[index]!); });
      }
      if (!serializeFrame(frame)) fit(frame.state.cards, rows => { frame.state.cards = rows; });
      if (!serializeFrame(frame)) {
        const active = snapshot.canvases.find(canvas => canvas.id === snapshot.activeCanvasId);
        const others = snapshot.canvases.filter(canvas => canvas.id !== snapshot.activeCanvasId);
        fit(others, rows => { frame.state.canvases = [...(active ? [active] : []), ...rows]; });
      }
      if (!serializeFrame(frame)) throw new Error("Snapshot metadata exceeds wire budget");
      if (advertisedAvailability !== snapshot.ownerAvailable) {
        if (send({ ...s, type: "owner.status", available: snapshot.ownerAvailable })) advertisedAvailability = snapshot.ownerAvailable;
      }
      send(frame);
      if (snapshotError) { snapshotError = false; emit({ error: null }); }
    } catch {
      if (send({ ...s, type: "owner.status", available: false })) advertisedAvailability = false;
      snapshotError = true; emit({ error: "电脑状态不符合远程协议，已停止控制。" });
    }
  }
  function makeResult(command: Command, status: Result["status"], message: string): Result {
    let version: number | undefined;
    try { version = hostSnapshot().version; } catch { /* Invalid host state still needs a terminal response. */ }
    return { v: 1, sessionId: command.sessionId, epoch: command.epoch, deviceId, type: "result", forDeviceId: command.deviceId, requestId: command.requestId,
      status, message: message.slice(0, 500), ...(version !== undefined ? { version } : {}) };
  }
  function answer(entry: Entry, status: Result["status"], message: string) {
    entry.result = makeResult(entry.command, status, message);
    if (active && connected && scoped(entry.command) && authorized(entry.command.deviceId)) send(entry.result);
  }
  function current(entry: Entry, ignoreVersion = false) {
    const c = entry.command;
    try {
      const snapshot = hostSnapshot();
      return active && connected && scoped(c) && authorized(c.deviceId, c.operation.kind) && !entry.abort.signal.aborted
        && snapshot.ownerAvailable && snapshot.ownerEpoch === c.ownerEpoch
        && snapshot.activeCanvasId === c.canvasId && (ignoreVersion || snapshot.version === (entry.committedVersion ?? c.expectedVersion));
    } catch { return false; }
  }
  async function execute(entry: Entry) {
    if (entry.result) return;
    if (!current(entry)) { answer(entry, entry.abort.signal.aborted ? "cancelled" : "rejected", "控制会话、电脑 owner 或画布版本已变化；请同步后重新发起。"); return; }
    const c = entry.command;
    const operation = c.operation;
    entry.started = true;
    send({ ...scope()!, type: "executing", requestId: c.requestId, forDeviceId: c.deviceId });
    try {
      const mutation: HostMutationContext = {
        isCurrent: () => current(entry),
        // Only a synchronous, currently leased owner write advances this request's version.
        withCommit: <T>(write: () => T): T => {
          if (!current(entry)) throw new Error("remote_scope_changed");
          const from = hostSnapshot().version;
          const result = write();
          const to = hostSnapshot().version;
          if (!current(entry, true) || !Number.isSafeInteger(to) || to < from || to > from + 1) throw new Error("remote_commit_scope_changed");
          entry.committedVersion = to; return result;
        },
      };
      let outcome: { ok: boolean; message: string };
      if (operation.kind === "text.submit") {
        outcome = await host.submitText(operation.text, { requestId: c.requestId, signal: entry.abort.signal, isCurrent: () => current(entry),
          conversationId: [c.sessionId, c.epoch, c.deviceId, c.ownerEpoch, c.canvasId].join(":"),
          withCommit: mutation.withCommit,
        });
      } else if (operation.kind === "canvas.switch") {
        if (!hostSnapshot().canvases.some(canvas => canvas.id === operation.targetCanvasId)) { answer(entry, "rejected", "目标画布不存在。"); return; }
        outcome = await host.switchCanvas(operation.targetCanvasId, { isCurrent: () => current(entry) });
      } else {
        if (!hostSnapshot().cards.some(card => card.id === operation.cardId)) { answer(entry, "rejected", "目标卡片不在当前画布。"); return; }
        if (operation.kind === "card.surface") {
          if (!host.setCardSurface) { answer(entry, "rejected", "电脑版本暂不支持手机传送门，请更新电脑端后重新配对。"); return; }
          outcome = await host.setCardSurface(operation.cardId, operation.surface, mutation);
        } else outcome = await host.setCardPinned(operation.cardId, operation.pinned);
      }
      // If the adapter committed before cancellation, report execution; cancellation never rolls it back.
      answer(entry, outcome.ok ? "succeeded" : entry.abort.signal.aborted ? "cancelled" : "rejected", outcome.message);
      publishSnapshot();
    } catch { answer(entry, "unknown", "电脑执行异常，结果无法确认；请查看电脑状态，不会自动重试。"); }
  }
  function command(c: Command) {
    if (!scoped(c) || !authorized(c.deviceId, c.operation.kind)) return;
    const id = key(c.sessionId, c.epoch, c.deviceId, c.requestId);
    const fingerprint = JSON.stringify(c);
    const existing = ledger.get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) { send(makeResult(c, "rejected", "请求 ID 已用于另一条指令。")); return; }
      if (existing.result) send(existing.result);
      else send({ ...scope()!, type: "executing", requestId: c.requestId, forDeviceId: c.deviceId });
      return;
    }
    if (ledger.size >= (options.maxRequests ?? 512)) {
      send(makeResult(c, "rejected", "会话请求额度已满，请结束此连接并创建新会话；不会丢弃去重记录。")); return;
    }
    const entry: Entry = { command: c, fingerprint, abort: new AbortController(), started: false };
    ledger.set(id, entry);
    // Every command is admitted once, including stale/rejected writes; duplicate IDs never acquire a fresh lease.
    queue = queue.then(() => execute(entry)).catch(() => { answer(entry, "unknown", "执行结果无法确认。"); });
  }
  function clearLoops() {
    if (heartbeat) clearInterval(heartbeat); heartbeat = null;
    if (reconnect) clearTimeout(reconnect); reconnect = null;
  }
  function abortPending() { ledger.forEach(entry => { if (!entry.result) entry.abort.abort(); }); }
  function expire(message: string) {
    active = false; finished = true; connected = false; clearLoops(); abortPending();
    if (expiry) clearTimeout(expiry); expiry = null;
    unsubTransport?.(); unsubHost?.(); unsubTransport = null; unsubHost = null;
    token = undefined; permissions.clear(); transport.close();
    emit({ status: "expired", pairCode: null, pairExpiresAt: null, controllers: [], error: message });
  }
  function lost(reason: string) {
    if (!active) return;
    connected = false; abortPending();
    if (heartbeat) clearInterval(heartbeat); heartbeat = null;
    emit({ status: "offline", error: reason });
    if (!reconnect) reconnect = setTimeout(() => { reconnect = null; if (active) { emit({ status: "connecting" }); transport.connect(); } }, options.reconnectDelayMs ?? 1500);
  }
  function receive(frame: Frame) {
    // An already queued callback may outlive unsubscribe/close.
    if (!active) return;
    lastSeen = now();
    if (frame.type === "welcome") {
      if (frame.deviceId !== deviceId || frame.computerId !== deviceId) return;
      if (welcome && (frame.sessionId !== welcome.sessionId || frame.epoch !== welcome.epoch)) { expire("中继会话已更换，请重新创建配对。"); return; }
      welcome = frame; token = frame.token; connected = true; advertisedAvailability = null;
      permissions.clear(); frame.controllers?.forEach(controller => { if (!locallyRevoked.has(controller.deviceId)) permissions.set(controller.deviceId, controller.permissions); });
      emit({ status: "connected", pairCode: frame.pairCode ?? null, pairExpiresAt: frame.pairExpiresAt ?? null,
        expiresAt: frame.expiresAt, controllers: [...permissions.keys()], error: null });
      if (expiry) clearTimeout(expiry);
      expiry = setTimeout(() => expire("远程控制会话已过期。"), Math.max(0, frame.expiresAt - now()));
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = setInterval(() => {
        if (now() - lastSeen > 30000) { transport.close(); lost("中继心跳超时"); return; }
        const s = scope(); if (s) send({ ...s, type: "heartbeat", at: now() });
      }, 8000);
      publishSnapshot(); return;
    }
    if (frame.type === "error") { emit({ error: frame.message }); if (/expired|unauthorized|revoked|auth|invalid-session/i.test(frame.code)) expire(frame.message); return; }
    if (!scoped(frame)) return;
    if (frame.type === "controller") {
      // Pair codes are single-use. A redeemed code must disappear immediately from the computer UI.
      if (frame.state === "joined") emit({ pairCode: null, pairExpiresAt: null });
      if (frame.state === "joined" && !locallyRevoked.has(frame.deviceId)) permissions.set(frame.deviceId, frame.permissions.filter(permission => PERMISSIONS.includes(permission)));
      else { permissions.delete(frame.deviceId); ledger.forEach(entry => { if (entry.command.deviceId === frame.deviceId && !entry.result) entry.abort.abort(); }); }
      emit({ controllers: [...permissions.keys()] }); publishSnapshot();
    } else if (frame.type === "file.request" && authorized(frame.deviceId, frame.imageId ? "image.read" : "file.read")) {
      const isCurrent = () => {
        try { const current = hostSnapshot(); return active && connected && scoped(frame) && authorized(frame.deviceId, frame.imageId ? "image.read" : "file.read") && current.ownerAvailable
          && current.activeCanvasId === frame.canvasId && current.ownerEpoch === frame.ownerEpoch && current.version === frame.expectedVersion
          && current.cards.some(card => card.id === frame.cardId && (frame.imageId ? card.images?.some(image => image.id === frame.imageId) : card.file)); } catch { return false; }
      };
      const reject = () => { const s = scope(); if (s && scoped(frame) && authorized(frame.deviceId)) send({ ...s, type: "file.error", forDeviceId: frame.deviceId, requestId: frame.requestId, message: "文件或电脑状态已变化，请同步后重试下载。" }); };
      if (!isCurrent() || !(frame.imageId ? host.readImageChunk : host.readFileChunk) || fileReads.has(frame.deviceId)) { reject(); return; }
      fileReads.add(frame.deviceId);
      const read = frame.imageId ? host.readImageChunk!(frame.cardId, frame.imageId, frame.offset, { isCurrent }) : host.readFileChunk!(frame.cardId, frame.offset, { isCurrent });
      void read.then(raw => {
        const chunk = FileChunkDataSchema.parse(raw);
        if (!isCurrent()) { reject(); return; }
        send({ ...scope()!, type: "file.chunk", forDeviceId: frame.deviceId, requestId: frame.requestId, cardId: frame.cardId, offset: frame.offset, chunk });
      }).catch(reject).finally(() => fileReads.delete(frame.deviceId));
    } else if (frame.type === "command") command(frame);
    else if ((frame.type === "query" || frame.type === "cancel") && authorized(frame.deviceId)) {
      const entry = ledger.get(key(frame.sessionId, frame.epoch, frame.deviceId, frame.requestId));
      if (!entry || entry.command.canvasId !== frame.canvasId) {
        send({ ...scope()!, type: "result", forDeviceId: frame.deviceId, requestId: frame.requestId, status: "unknown", message: "电脑没有该请求的执行记录；不会自动重放。" }); return;
      }
      if (frame.type === "cancel" && !entry.result) {
        entry.abort.abort();
        if (!entry.started) answer(entry, "cancelled", "尚未执行的指令已取消。");
        else send({ ...scope()!, type: "result", forDeviceId: frame.deviceId, requestId: frame.requestId, status: "unknown", message: "已请求取消；已经提交的动作不能撤回，请查询实际结果。" });
      } else if (entry.result) send(entry.result);
      else send({ ...scope()!, type: "executing", requestId: frame.requestId, forDeviceId: frame.deviceId });
    } else if (frame.type === "snapshot.request" && authorized(frame.deviceId)) publishSnapshot();
    else if (frame.type === "pairing") emit({ pairCode: frame.pairCode, pairExpiresAt: frame.pairExpiresAt });
    else if (frame.type === "revoked") expire(frame.reason);
  }
  return {
    start() {
      if (finished) { emit({ error: "此电脑连接已结束；请创建新的 connector 和设备身份后重新配对。" }); return; }
      if (active) return;
      active = true; emit({ status: "connecting", error: null });
      unsubTransport = transport.subscribe(event => {
        if (event.type === "open") {
          transport.send({ v: 1, type: "hello", role: "computer", deviceId, deviceName: options.deviceName,
            ...(token ? { token } : { accessKey: options.accessKey ?? "" }) });
        } else if (event.type === "message") receive(event.frame);
        else lost(event.reason);
      });
      unsubHost = host.subscribe(() => {
        // A temporarily lost identity never revives an old text task, even if the UI recovers.
        for (const entry of ledger.values()) if (!entry.result && entry.command.operation.kind === "text.submit" && !current(entry, true)) entry.abort.abort();
        publishSnapshot();
      });
      transport.connect();
    },
    stop() {
      const s = scope(); if (s && connected) send({ ...s, type: "revoke" });
      active = false; finished = true; connected = false; clearLoops(); if (expiry) clearTimeout(expiry); expiry = null;
      abortPending(); unsubTransport?.(); unsubHost?.(); transport.close();
      token = undefined; welcome = null; permissions.clear();
      emit({ status: "stopped", pairCode: null, pairExpiresAt: null, expiresAt: null, controllers: [], error: null });
    },
    /** Page teardown is a disconnect, not a user's revocation. Secrets still die in this object. */
    detach() {
      active = false; finished = true; connected = false; clearLoops();
      if (expiry) clearTimeout(expiry); expiry = null;
      abortPending(); unsubTransport?.(); unsubHost?.(); transport.close();
      token = undefined; welcome = null; permissions.clear();
      emit({ status: "stopped", pairCode: null, pairExpiresAt: null, expiresAt: null, controllers: [], error: null });
    },
    rotatePairing() { const s = scope(); if (s) send({ ...s, type: "pair.rotate" }); },
    revoke(targetDeviceId?: string) {
      const targets = targetDeviceId ? [targetDeviceId] : [...permissions.keys()];
      targets.forEach(id => { locallyRevoked.add(id); permissions.delete(id); });
      ledger.forEach(entry => { if ((!targetDeviceId || entry.command.deviceId === targetDeviceId) && !entry.result) entry.abort.abort(); });
      emit({ controllers: [...permissions.keys()] });
      const s = scope(); if (s) send({ ...s, type: "revoke", ...(targetDeviceId ? { targetDeviceId } : {}) });
      if (!targetDeviceId) expire("已结束电脑远程控制；若中继未收到撤销，旧授权仍因 owner 退出而无法执行。");
    },
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
