import type { LockHandle, LockProvider } from "./owner";

export { createMemoryHub, flushChannel } from "./channel";

/**
 * Web Locks semantic stub: exclusive hold per name, `ifAvailable` returns
 * null when busy, `steal` revokes the current holder (notified via
 * onRevoked). Create ONE per simulated browser profile (like a real
 * LockManager scope), not per tab.
 */
export const createMemoryLockProvider = (): LockProvider => {
  interface Entry extends LockHandle {
    _revoke: () => void;
  }
  const held = new Map<string, Entry>();
  return {
    request: async (name, opts) => {
      const current = held.get(name);
      if (current) {
        if (!opts.steal) return null;
        current._revoke();
      }
      let revoked: (() => void) | undefined;
      const handle: Entry = {
        release: () => {
          if (held.get(name) === handle) held.delete(name);
        },
        onRevoked: (cb) => {
          revoked = cb;
        },
        _revoke: () => {
          if (held.get(name) === handle) held.delete(name);
          revoked?.();
        },
      };
      held.set(name, handle);
      return handle;
    },
  };
};
