import { newId } from "@/lib/id";
import { emptyVivicState, fromCanvasRecord } from "@/persistence/canvasRecord";
import type { VivicDB } from "@/persistence/db";
import { canvasStore, type CanvasStore } from "@/state/canvasStore";
import type { SyncChannel } from "./channel";
import { ANY_CANVAS, CoordinateSchema, DEFAULT_DISPLAY_PREFERENCES,
  type CanvasInteraction, type DisplayInteraction, type SyncMessage } from "./protocol";

/**
 * DISPLAY_READER: read-only sync client. On load it hydrates the pinned
 * canvas from IndexedDB (keeps the last frame if the owner is gone), asks the
 * owner for a fresh snapshot, then replays patches through the SAME reducer
 * with requestId idempotence. Version mismatch / seq gap / owner epoch change
 * all trigger a snapshot re-request; while waiting for a resync, patches are
 * ignored so nothing is applied twice or out of order. Internal animation
 * commits (delete exit, awakening complete, viewport) stay window-local.
 */

export interface DisplayClientDeps {
  channel: SyncChannel;
  db?: VivicDB;
  store?: CanvasStore;
  /** Pinned canvas from ?canvasId=; empty = follow the owner's active canvas. */
  pinnedCanvasId?: string;
  instanceId?: string;
  autosaveMs?: number;
}

export interface DisplayClientStatus {
  canvasId: string;
  version: number | null;
  ownerAlive: boolean;
  hydrated: boolean;
  canInteract: boolean;
  viewKey: string;
}

export interface CanvasDrag {
  canvasId: string;
  ownerEpoch: string;
  version: number;
  requestId: string;
  cardId: string;
  from: Extract<CanvasInteraction, { kind: "card.move" }>["from"];
}

export interface DisplayClient {
  start: () => Promise<void>;
  stop: () => void;
  getStatus: () => DisplayClientStatus;
  subscribeStatus: (listener: () => void) => () => void;
  beginCardDrag: (cardId: string) => CanvasDrag | null;
  requestCardMove: (drag: CanvasDrag, x: number, y: number) => boolean;
  /** A card dropped here from the user page: ask the owner to place it at (x, y). */
  requestCardToCanvas: (canvasId: string, cardId: string, x: number, y: number) => boolean;
  /** Cross-tab portal; no drag or screen coordinates are needed. */
  requestCardSurface: (cardId: string, surface: "user" | "display") => boolean;
  requestCardFocus: (cardId: string) => boolean;
  requestCanvasFit: () => boolean;
  requestFocusRestore: () => boolean;
}

export const createDisplayClient = (
  deps: DisplayClientDeps,
): DisplayClient => {
  const store = deps.store ?? canvasStore;
  const instanceId = deps.instanceId ?? newId("display");
  let pinned = deps.pinnedCanvasId ?? ANY_CANVAS;

  let canvasId = "";
  let version: number | null = null;
  let lastSeq: number | null = null;
  let epoch = "";
  let ownerEpoch = "";
  let ownerAlive = false;
  let hydrated = false;
  let resyncing = false;
  let stopped = false;
  let lastOwnerSeenAt = 0;
  let pendingSnapshotAt = 0;
  let retryTimer: ReturnType<typeof setInterval> | null = null;
  let stateGeneration = 0;
  const canInteract = () => !stopped && hydrated && !resyncing && ownerAlive &&
    Boolean(epoch) && Date.now() - lastOwnerSeenAt < 3600;
  const statusListeners = new Set<() => void>();
  const emitStatus = () => statusListeners.forEach(listener => listener());

  const baseMsg = (forCanvas: string) => ({
    canvasId: forCanvas,
    epoch: instanceId,
    version: version ?? 0,
    seq: 0,
    requestId: newId("msg"),
  });

  const requestSnapshot = (forCanvas: string) => {
    if (resyncing) return;
    resyncing = true;
    pendingSnapshotAt = Date.now();
    deps.channel.post({
      ...baseMsg(forCanvas),
      type: "snapshot-request",
      payload: {},
    });
    emitStatus();
  };

  // The controller owns persistence too. A delayed display save must never
  // overwrite a freshly persisted reminder delivery marker with an older frame.

  const applySnapshot = (msg: Extract<SyncMessage, { type: "snapshot" }>) => {
    if (pinned && msg.canvasId !== pinned) return;
    if (!pinned && msg.payload.activeCanvasId && msg.canvasId !== msg.payload.activeCanvasId) return;
    if (ownerEpoch && msg.payload.ownerId && msg.payload.ownerId !== ownerEpoch) return;
    if (msg.payload.version !== msg.version) return;
    if (msg.canvasId === canvasId && msg.epoch === epoch && version !== null && msg.version < version) return;
    stateGeneration++;
    store.setPreferences(msg.payload.preferences ?? DEFAULT_DISPLAY_PREFERENCES);
    store.loadState(msg.payload.vivicState);
    canvasId = msg.canvasId;
    version = msg.payload.version;
    epoch = msg.epoch;
    if (msg.payload.ownerId) ownerEpoch = msg.payload.ownerId;
    lastSeq = msg.seq;
    hydrated = true;
    resyncing = false;
    ownerAlive = true;
    lastOwnerSeenAt = Date.now();
    emitStatus();
  };

  const applyPatch = (msg: Extract<SyncMessage, { type: "patch" }>) => {
    if (pinned && msg.canvasId !== pinned) return;
    if (msg.payload.envelope.canvasId !== msg.canvasId) return;
    if (!pinned && canvasId && msg.canvasId !== canvasId) return;
    const wantsSwitch =
      !pinned &&
      msg.payload.envelope.actions.some((a) => a.type === "canvas.switch");
    if (wantsSwitch) {
      const target = msg.payload.envelope.actions.find(
        (a) => a.type === "canvas.switch",
      );
      resyncing = false;
      if (target && target.type === "canvas.switch") {
        requestSnapshot(target.canvasId);
      }
      return;
    }
    if (!hydrated || resyncing) return;
    // Epoch change means the owner session restarted: full resync, never replay.
    if (epoch && msg.epoch !== epoch) {
      requestSnapshot(msg.canvasId);
      return;
    }
    if (lastSeq !== null && version !== null && msg.seq <= lastSeq && msg.version <= version) return;
    if (lastSeq !== null && msg.seq !== lastSeq + 1) {
      requestSnapshot(msg.canvasId);
      return;
    }
    if (version !== null && msg.version !== version + 1) {
      requestSnapshot(msg.canvasId);
      return;
    }
    const result = store.dispatch(msg.payload.envelope);
    if (result.ok) {
      // Both fresh applications and requestId-deduped replays advance the
      // cursor — the store guarantees the action itself runs at most once.
      version = msg.version;
      lastSeq = msg.seq;
      canvasId = msg.canvasId;
      ownerAlive = true;
      lastOwnerSeenAt = Date.now();
      emitStatus();
    }
  };

  const unsubscribeChannel = deps.channel.subscribe((msg) => {
    if (stopped) return;
    switch (msg.type) {
      case "space-feedback": {
        if (!hydrated || msg.canvasId !== canvasId || msg.epoch !== epoch || msg.version !== version) return;
        emitSpaceFeedback(msg.payload); return;
      }
      case "target-choice": {
        if (!hydrated || msg.canvasId !== canvasId || msg.epoch !== epoch) return;
        const choice = msg.payload.choice;
        store.internal({ type: "targetChoice.set", choice: choice && choice.expiresAt > Date.now() ? choice : null });
        return;
      }
      case "local-data-reset": {
        if (ownerEpoch && msg.payload.ownerId !== ownerEpoch) return;
        stateGeneration++;
        if (pinned) pinned = msg.canvasId;
        canvasId = msg.canvasId; version = null; lastSeq = null; epoch = "";
        ownerEpoch = msg.payload.ownerId;
        hydrated = false; resyncing = false;
        store.setPreferences(DEFAULT_DISPLAY_PREFERENCES); store.loadState(emptyVivicState());
        requestSnapshot(canvasId);
        return;
      }
      case "activity": {
        if (!hydrated || msg.canvasId !== canvasId || msg.epoch !== epoch) return;
        const { activity, requestId } = msg.payload;
        if (!activity && store.getState().activity?.requestId !== requestId) return;
        store.internal({
          type: "activity.set",
          activity: activity && activity.expiresAt > Date.now() ? activity : null,
        });
        return;
      }
      case "snapshot":
        applySnapshot(msg);
        return;
      case "patch":
        applyPatch(msg);
        return;
      case "owner": {
        if (msg.payload.status === "off") {
          if (ownerEpoch && msg.epoch !== ownerEpoch) return;
          ownerAlive = false;
          resyncing = false;
          store.internal({ type: "activity.set", activity: null });
          store.internal({ type: "targetChoice.set", choice: null });
          emitStatus();
          return;
        }
        // on / takeover: a NEW owner session after we had one => resync.
        const incoming = msg.epoch;
        ownerAlive = true;
        lastOwnerSeenAt = Date.now();
        if ((!ownerEpoch || incoming !== ownerEpoch || !epoch) && hydrated) {
          ownerEpoch = incoming;
          epoch = "";
          resyncing = false;
          requestSnapshot(canvasId || pinned);
          return;
        }
        ownerEpoch = incoming;
        emitStatus();
        return;
      }
      default:
        return;
    }
  });

  const start = async () => {
    if (stopped) return;
    emitStatus();
    if (pinned && deps.db) {
      const hydrationGeneration = stateGeneration;
      let rec = await deps.db.getCanvas(pinned);
      if (!rec && !stopped && !epoch && hydrationGeneration === stateGeneration) {
        const fallback = await deps.db.getMeta("lastCanvasId");
        if (fallback) {
          rec = await deps.db.getCanvas(fallback);
          if (rec && hydrationGeneration === stateGeneration) pinned = rec.id;
        }
      }
      if (rec && !stopped && !epoch && hydrationGeneration === stateGeneration) {
        store.loadState(fromCanvasRecord(rec));
        canvasId = rec.id;
        version = rec.version;
        hydrated = true;
        emitStatus();
      }
    }
    if (stopped) return;
    deps.channel.post({
      ...baseMsg(pinned),
      type: "hello",
      payload: { role: "display" },
    });
    requestSnapshot(pinned);
    retryTimer = setInterval(() => {
      if (stopped) return;
      if (ownerAlive && Date.now() - lastOwnerSeenAt >= 3600) {
        ownerAlive = false; store.internal({ type: "targetChoice.set", choice: null });
        emitStatus();
      }
      // Retry unanswered hello/resync requests; an owner that was absent at
      // startup must not leave this reader permanently stuck in resyncing.
      if ((!ownerAlive || resyncing) && Date.now() - pendingSnapshotAt >= 1200) {
        resyncing = false;
        requestSnapshot(canvasId || pinned);
      }
    }, 1200);
    emitStatus();
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    ownerAlive = false;
    if (retryTimer) clearInterval(retryTimer);
    unsubscribeChannel();
    emitStatus();
    statusListeners.clear();
  };

  const postInteraction = (interaction: DisplayInteraction): boolean => {
    if (!canInteract()) return false;
    deps.channel.post({ type: "interaction", canvasId, epoch: instanceId,
      version: version!, seq: 0, requestId: newId("interaction"),
      payload: { ownerEpoch: epoch, interaction } });
    return true;
  };
  const findCard = (cardId: string) => store.getState().cards.find(c => c.record.id === cardId && !c.exitingRequestId);
  const baseline = (layout: NonNullable<ReturnType<typeof findCard>>["record"]["layout"]) => {
    const { x, y, width, height, pinned } = layout;
    return { x, y, width, height, pinned };
  };

  return {
    start,
    stop,
    subscribeStatus: listener => {
      statusListeners.add(listener);
      return () => { statusListeners.delete(listener); };
    },
    beginCardDrag: cardId => {
      if (!canInteract()) return null;
      const entry = store.getState().cards.find(c => c.record.id === cardId && !c.exitingRequestId && !c.record.layout.pinned && c.record.layout.surface !== "user");
      if (!entry) return null;
      const { x, y, width, height, pinned } = entry.record.layout;
      return { canvasId, ownerEpoch: epoch, version: version!, requestId: newId("drag"), cardId, from: { x, y, width, height, pinned } };
    },
    requestCardMove: (drag, x, y) => {
      if (!canInteract() || drag.canvasId !== canvasId || drag.ownerEpoch !== epoch ||
          !CoordinateSchema.safeParse(x).success || !CoordinateSchema.safeParse(y).success) return false;
      const entry = store.getState().cards.find(c => c.record.id === drag.cardId && !c.exitingRequestId);
      if (!entry || entry.record.layout.pinned || entry.record.layout.surface === "user" || Object.keys(drag.from).some(key =>
        entry.record.layout[key as keyof typeof drag.from] !== drag.from[key as keyof typeof drag.from])) return false;
      deps.channel.post({ type: "interaction", canvasId, epoch: instanceId,
        version: drag.version, seq: 0, requestId: drag.requestId,
        payload: { ownerEpoch: epoch, interaction: { kind: "card.move", cardId: drag.cardId, from: drag.from, x, y } } });
      return true;
    },
    requestCardToCanvas: (forCanvas, cardId, x, y) => {
      if (!canInteract() || forCanvas !== canvasId || !CoordinateSchema.safeParse(x).success || !CoordinateSchema.safeParse(y).success) return false;
      const entry = store.getState().cards.find(c => c.record.id === cardId && !c.exitingRequestId);
      if (!entry || entry.record.layout.surface !== "user") return false;
      return postInteraction({ kind: "card.surface", cardId, from: baseline(entry.record.layout), surface: "display", x, y });
    },
    requestCardSurface: (cardId, surface) => {
      if (!canInteract() || (surface !== "user" && surface !== "display")) return false;
      const entry = findCard(cardId);
      if (!entry || (entry.record.layout.surface ?? "display") === surface) return false;
      return postInteraction({ kind: "card.surface", cardId, from: baseline(entry.record.layout), surface });
    },
    requestCardFocus: cardId => {
      if (!canInteract()) return false;
      const entry = findCard(cardId);
      if (!entry || entry.record.layout.surface === "user") return false;
      return postInteraction({ kind: "card.focus", cardId, from: baseline(entry.record.layout) });
    },
    requestCanvasFit: () => postInteraction({ kind: "canvas.fit" }),
    requestFocusRestore: () => postInteraction({ kind: "canvas.restore" }),
    getStatus: () => ({ canvasId, version, ownerAlive: ownerAlive && Date.now() - lastOwnerSeenAt < 3600, hydrated, canInteract: canInteract(), viewKey: `${canvasId}:${epoch}` }),
  };
};
import { emitSpaceFeedback } from "@/motion/spaceMotion";
