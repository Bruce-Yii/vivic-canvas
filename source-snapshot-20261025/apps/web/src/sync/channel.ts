import { parseSyncMessage, SYNC_CHANNEL_NAME, type SyncMessage } from "./protocol";

/** Minimal transport the sync layer talks to; BroadcastChannel in the app,
 * in-memory stubs in unit tests. */
export interface SyncChannel {
  post: (message: SyncMessage) => void;
  subscribe: (listener: (message: SyncMessage) => void) => () => void;
  close: () => void;
}

export const createBroadcastSyncChannel = (
  name: string = SYNC_CHANNEL_NAME,
): SyncChannel => {
  const bc = new BroadcastChannel(name);
  return {
    post: (message) => bc.postMessage(message),
    subscribe: (listener) => {
      const onMessage = (event: MessageEvent) => {
        const msg = parseSyncMessage(event.data);
        if (msg) listener(msg);
      };
      bc.addEventListener("message", onMessage);
      return () => bc.removeEventListener("message", onMessage);
    },
    close: () => bc.close(),
  };
};

/**
 * In-memory hub: channels created from it behave like same-origin peers
 * (each message is delivered to every OTHER channel, asynchronously by
 * default so tests can observe ordering via `await flush()`).
 */
export const createMemoryHub = () => {
  type Listener = (message: SyncMessage) => void;
  const channels = new Set<{ listeners: Set<Listener> }>();

  const createChannel = (): SyncChannel => {
    const entry = { listeners: new Set<Listener>() };
    channels.add(entry);
    let closed = false;
    return {
      post(message) {
        if (closed) return;
        for (const peer of channels) {
          if (peer === entry) continue;
          const snapshot = [...peer.listeners];
          queueMicrotask(() => snapshot.forEach((l) => l(message)));
        }
      },
      subscribe(listener) {
        entry.listeners.add(listener);
        return () => entry.listeners.delete(listener);
      },
      close() {
        closed = true;
        channels.delete(entry);
      },
    };
  };

  return { createChannel };
};

/** Let queued microtasks deliver pending messages in tests. */
export const flushChannel = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));
