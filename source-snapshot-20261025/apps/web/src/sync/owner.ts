import type { SyncChannel } from "./channel";
import type { SyncMessage } from "./protocol";

/**
 * Single CONTROL_OWNER election. Primary: Web Locks API (exclusive lock
 * `vivic:control-owner:lock`, steal for takeover). Fallback when navigator.locks
 * is unavailable: BroadcastChannel heartbeat — the oldest live heartbeat wins.
 * A second control tab runs read-only with a visible takeover option; on
 * takeover the old owner demotes itself via the `takeover` broadcast.
 */

export type OwnerMode = "owner" | "readonly";

export interface LockHandle {
  release: () => void;
  onRevoked: (cb: () => void) => void;
}

export interface LockProvider {
  /**
   * Resolve with a handle once granted, `null` when ifAvailable and busy.
   * With `steal`, a held lock is revoked (holder notified via onRevoked).
   */
  request: (
    name: string,
    opts: { ifAvailable?: boolean; steal?: boolean },
  ) => Promise<LockHandle | null>;
}

const LOCK_NAME = "vivic:control-owner:lock";
const HEARTBEAT_MS = 1200;
const ELECT_WAIT_MS = 700;
const STALE_MS = 3600;

/** Browser Web Locks adapter. */
export const webLockProvider: LockProvider | null =
  typeof navigator !== "undefined" && "locks" in navigator
    ? {
        request: (name, opts) =>
          new Promise((resolveOuter) => {
            let releaseFn: (() => void) | undefined;
            let revokedCb: (() => void) | undefined;
            const p = navigator.locks.request(
              name,
              { ifAvailable: opts.ifAvailable, steal: opts.steal },
              (lock) => {
                if (lock === null) {
                  resolveOuter(null);
                  return new Promise<void>(() => undefined);
                }
                return new Promise<void>((release) => {
                  releaseFn = release;
                  resolveOuter({
                    release: () => releaseFn?.(),
                    onRevoked: (cb) => {
                      revokedCb = cb;
                    },
                  });
                });
              },
            );
            // Safari never revokes on steal; Chrome resolves p after release.
            void p.catch(() => revokedCb?.());
          }),
      }
    : null;

export interface OwnerManagerDeps {
  channel: SyncChannel;
  instanceId: string;
  lockProvider?: LockProvider | null;
  onModeChange?: (mode: OwnerMode) => void;
  heartbeatMs?: number;
  electWaitMs?: number;
  staleMs?: number;
}

export interface OwnerManager {
  mode: () => OwnerMode;
  start: () => Promise<void>;
  takeover: () => void;
  stop: () => void;
}

export const createOwnerManager = (
  deps: OwnerManagerDeps,
): OwnerManager => {
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;
  const electWaitMs = deps.electWaitMs ?? ELECT_WAIT_MS;
  const staleMs = deps.staleMs ?? STALE_MS;

  let mode: OwnerMode = "readonly";
  let handle: LockHandle | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let lastOwnerSeenAt = 0;
  let currentOwnerId = "";
  let stopped = false;

  const setMode = (next: OwnerMode) => {
    if (mode !== next) {
      mode = next;
      deps.onModeChange?.(next);
    }
  };

  const ownerMsg = (status: "on" | "off" | "takeover"): SyncMessage => ({
    type: "owner",
    canvasId: "",
    epoch: deps.instanceId,
    version: 0,
    seq: 0,
    requestId: `owner-${status}-${deps.instanceId}-${Date.now()}`,
    payload: { status, ownerId: deps.instanceId },
  });

  const provider = deps.lockProvider === undefined ? webLockProvider : deps.lockProvider;

  // ---- heartbeat fallback ----
  const startHeartbeat = () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (stopped || mode !== "owner") return;
      deps.channel.post(ownerMsg("on"));
    }, heartbeatMs);
    deps.channel.post(ownerMsg("on"));
  };

  // Read-only fallback tabs re-elect when the heartbeats go stale (owner
  // closed without an `off` message).
  const watcherTimer = setInterval(() => {
    if (stopped || provider || mode === "owner") return;
    if (currentOwnerId && Date.now() - lastOwnerSeenAt > staleMs) {
      currentOwnerId = "";
      void elect();
    }
  }, heartbeatMs);

  const becomeOwnerFallback = () => {
    setMode("owner");
    currentOwnerId = deps.instanceId;
    startHeartbeat();
  };

  const tryElectFallback = async () => {
    lastOwnerSeenAt = 0;
    await new Promise((r) => setTimeout(r, electWaitMs));
    if (stopped || mode === "owner") return;
    const now = Date.now();
    if (
      currentOwnerId &&
      lastOwnerSeenAt > 0 &&
      now - lastOwnerSeenAt < staleMs
    ) {
      setMode("readonly");
      return;
    }
    becomeOwnerFallback();
  };

  const demote = () => {
    handle?.release();
    handle = null;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    setMode("readonly");
  };

  const unsubscribe = deps.channel.subscribe((msg) => {
    if (stopped || msg.type !== "owner") return;
    const { status, ownerId } = msg.payload;
    if (ownerId === deps.instanceId) return;
    if (status === "takeover") {
      if (mode === "owner") demote();
      currentOwnerId = ownerId;
      lastOwnerSeenAt = Date.now();
      setMode("readonly");
      return;
    }
    if (status === "on") {
      currentOwnerId = ownerId;
      lastOwnerSeenAt = Date.now();
      if (!provider && mode === "owner") demote();
      return;
    }
    if (status === "off") {
      if (ownerId === currentOwnerId) {
        currentOwnerId = "";
        lastOwnerSeenAt = 0;
      }
      // Slot freed: any read-only control tab claims it (a tab that joined
      // after the previous owner's announce never saw the `on`).
      if (mode === "readonly") void elect();
    }
  });

  const acquire = async (steal: boolean): Promise<boolean> => {
    if (!provider) return false;
    const got = await provider.request(LOCK_NAME, {
      ifAvailable: !steal,
      steal,
    });
    if (!got) return false;
    handle = got;
    handle.onRevoked(() => {
      if (mode === "owner") demote();
    });
    setMode("owner");
    deps.channel.post(ownerMsg(steal ? "takeover" : "on"));
    return true;
  };

  const elect = async () => {
    if (provider) {
      const got = await acquire(false);
      if (!got && !stopped) setMode("readonly");
      return;
    }
    await tryElectFallback();
  };

  return {
    mode: () => mode,
    start: async () => {
      stopped = false;
      await elect();
    },
    takeover: () => {
      void (async () => {
        const got = await acquire(true);
        if (!got && !provider) {
          // Heartbeat mode: force-claim; the old owner demotes on receipt.
          setMode("owner");
          deps.channel.post(ownerMsg("takeover"));
          startHeartbeat();
        }
      })();
    },
    stop: () => {
      stopped = true;
      clearInterval(watcherTimer);
      if (mode === "owner") deps.channel.post(ownerMsg("off"));
      demote();
      unsubscribe();
    },
  };
};
