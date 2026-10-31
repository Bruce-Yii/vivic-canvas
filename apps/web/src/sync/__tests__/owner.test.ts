import { describe, expect, it } from "vitest";
import { createMemoryHub, flushChannel } from "../channel";
import { createOwnerManager } from "../owner";
import { createMemoryLockProvider } from "../testing";

describe("single-owner election", () => {
  it("first control is owner; second control in same browser is read-only", async () => {
    const hub = createMemoryHub();
    const locks = createMemoryLockProvider();
    const a = createOwnerManager({
      channel: hub.createChannel(),
      instanceId: "A",
      lockProvider: locks,
    });
    await a.start();
    expect(a.mode()).toBe("owner");
    const b = createOwnerManager({
      channel: hub.createChannel(),
      instanceId: "B",
      lockProvider: locks,
    });
    await b.start();
    expect(b.mode()).toBe("readonly");
    expect(a.mode()).toBe("owner");
    a.stop();
    b.stop();
  });

  it("takeover steals ownership and the old owner demotes itself", async () => {
    const hub = createMemoryHub();
    const locks = createMemoryLockProvider();
    const a = createOwnerManager({
      channel: hub.createChannel(),
      instanceId: "A",
      lockProvider: locks,
    });
    const b = createOwnerManager({
      channel: hub.createChannel(),
      instanceId: "B",
      lockProvider: locks,
    });
    await a.start();
    await b.start();
    expect(a.mode()).toBe("owner");
    expect(b.mode()).toBe("readonly");

    b.takeover();
    await flushChannel();
    await flushChannel();
    expect(b.mode()).toBe("owner");
    expect(a.mode()).toBe("readonly");
    a.stop();
    b.stop();
  });

  it("owner stop frees the slot; waiting control takes over", async () => {
    const hub = createMemoryHub();
    const locks = createMemoryLockProvider();
    const a = createOwnerManager({
      channel: hub.createChannel(),
      instanceId: "A",
      lockProvider: locks,
    });
    const b = createOwnerManager({
      channel: hub.createChannel(),
      instanceId: "B",
      lockProvider: locks,
    });
    await a.start();
    await b.start();
    a.stop();
    await flushChannel();
    // B reacts to the off heartbeat and re-elects.
    await new Promise((r) => setTimeout(r, 20));
    await flushChannel();
    expect(b.mode()).toBe("owner");
    b.stop();
  });

  it("heartbeat fallback elects one owner without Web Locks", async () => {
    const hub = createMemoryHub();
    const a = createOwnerManager({
      channel: hub.createChannel(),
      instanceId: "A",
      lockProvider: null,
      electWaitMs: 30,
      heartbeatMs: 20,
    });
    await a.start();
    expect(a.mode()).toBe("owner");
    const b = createOwnerManager({
      channel: hub.createChannel(),
      instanceId: "B",
      lockProvider: null,
      electWaitMs: 30,
      heartbeatMs: 20,
    });
    await b.start();
    expect(b.mode()).toBe("readonly");
    a.stop();
    b.stop();
  });
});
