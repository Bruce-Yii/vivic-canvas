import { describe, expect, it, vi } from "vitest";
import { MAX_BUFFERED_BYTES, MAX_FRAME_BYTES, parseFrame, serializeFrame, type Frame } from "../protocol";
import { createWebSocketTransport, type BrowserSocket, type TransportEvent } from "../transport";

class Socket implements BrowserSocket {
  readyState = 1;
  bufferedAmount = 0;
  send = vi.fn();
  close = vi.fn();
  listeners = new Map<string, (event: any) => void>();
  addEventListener(type: string, listener: (event: any) => void) { this.listeners.set(type, listener); }
}
const frame: Frame = { v: 1, type: "error", code: "test", message: "test" };

describe("bounded WebSocket transport", () => {
  it("rejects oversized object and serialized frames under the same UTF-8 limit", () => {
    const snapshot: Frame = { v: 1, type: "snapshot", sessionId: "s", epoch: "e", deviceId: "computer", sequence: 1,
      state: { computerName: "电脑", ownerAvailable: true, ownerEpoch: "owner", activeCanvasId: "canvas", version: 1,
        canvases: [{ id: "canvas", title: "画布", version: 1 }],
        cards: Array.from({ length: 200 }, (_, i) => ({ id: `card_${i}`, type: "NoteCard", title: "备".repeat(160), pinned: false })),
      } };
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeGreaterThan(MAX_FRAME_BYTES);
    expect(parseFrame(snapshot)).toBeNull(); expect(parseFrame(JSON.stringify(snapshot))).toBeNull();
    expect(serializeFrame(snapshot)).toBeNull();
    const socket = new Socket(), transport = createWebSocketTransport("ws://127.0.0.1/relay", () => socket);
    transport.connect(); expect(transport.send(snapshot)).toBe(false); expect(socket.send).not.toHaveBeenCalled();
  });
  it("closes a slow socket rather than appending beyond the bounded network buffer", () => {
    const socket = new Socket(), transport = createWebSocketTransport("ws://127.0.0.1/relay", () => socket);
    transport.connect(); socket.bufferedAmount = MAX_BUFFERED_BYTES;
    expect(transport.send(frame)).toBe(false); expect(socket.send).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledWith(4008, "Outgoing buffer limit");
  });
  it("ignores replaced socket events while forwarding current frames", () => {
    const first = new Socket(), second = new Socket(); let index = 0;
    const transport = createWebSocketTransport("ws://127.0.0.1/relay", () => index++ ? second : first);
    const events: TransportEvent[] = []; transport.subscribe(event => events.push(event));
    transport.connect(); transport.connect();
    first.listeners.get("message")!({ data: JSON.stringify(frame) }); first.listeners.get("close")!({});
    expect(events).toHaveLength(0);
    second.listeners.get("message")!({ data: JSON.stringify(frame) }); expect(events).toEqual([{ type: "message", frame }]);
  });
});
