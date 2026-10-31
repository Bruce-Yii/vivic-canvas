import { afterEach, expect, it } from "vitest";
import { createMemoryDB } from "@/persistence/db";
import { createCanvasStore } from "@/state/canvasStore";
import { createMemoryHub, flushChannel } from "../channel";
import { createMemoryLockProvider } from "../testing";
import { createControlHost } from "../controlHost";

const stops: Array<() => void> = [];
afterEach(() => stops.splice(0).forEach(stop => stop()));
it("publishes existing owner identity changes to a window that stays readonly", async () => {
  const db = createMemoryDB(), hub = createMemoryHub(), locks = createMemoryLockProvider();
  const make = (instanceId: string) => {
    const host = createControlHost({ instanceId, db, store: createCanvasStore(), channel: hub.createChannel(), lockProvider: locks, reminderPollMs: 1000000 });
    stops.push(host.stop); return host;
  };
  const first = make("owner-one"), reader = make("reader"), second = make("owner-two");
  await first.start(); await reader.start(); await second.start();
  // A snapshot supplies the same identity as the existing owner heartbeat.
  const sender = hub.createChannel();
  sender.post({ type: "owner", canvasId: "", epoch: "owner-one", version: 0, seq: 0, requestId: "heartbeat", payload: { status: "on", ownerId: "owner-one" } });
  await flushChannel();
  expect(reader.getSnapshot()).toMatchObject({ ownerMode: "readonly", ownerId: "owner-one" });
  second.takeover(); await flushChannel();
  expect(reader.getSnapshot()).toMatchObject({ ownerMode: "readonly", ownerId: "owner-two" });
  expect(first.getSnapshot().ownerMode).toBe("readonly");
  expect(reader.dispatch({ schemaVersion: "0.6", requestId: "no-write", canvasId: reader.getSnapshot().activeCanvasId, actions: [{ type: "canvas.fit" }] }).ok).toBe(false);
});
