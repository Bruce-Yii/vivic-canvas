import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMobileClient, type MobileClient } from "../client";
import { parseFrame, type Frame, type Welcome, type CanvasSnapshot } from "../protocol";
import { validateRelayUrl, type Transport, type TransportEvent } from "../transport";

class FakeTransport implements Transport {
  listeners = new Set<(event: TransportEvent) => void>(); sent: Frame[] = []; closed = false;
  connect() { this.listeners.forEach(l => l({type:"open"})); }
  close() { this.closed = true; }
  send(frame: Frame) { this.sent.push(frame); return !this.closed; }
  subscribe(listener: (event: TransportEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  receive(frame: Frame) { this.listeners.forEach(l => l({type:"message",frame})); }
  disconnect() { this.listeners.forEach(l => l({type:"disconnect",reason:"offline"})); }
}
const clients: MobileClient[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-21T08:00:00Z")); });
afterEach(() => { clients.splice(0).forEach(c => c.revoke()); vi.useRealTimers(); });
const scope = { v:1 as const, sessionId:"session", epoch:"epoch", deviceId:"computer" };
function setup() {
  const transports: FakeTransport[] = [];
  const client = createMobileClient({ id:"phone", transportFactory: () => { const t = new FakeTransport(); transports.push(t); return t; }, requestTimeoutMs:1000,reconnectDelayMs:10 });
  clients.push(client); client.pair("wss://relay.test/relay","PAIRCODE12");
  const welcome: Welcome = { v:1,type:"welcome",deviceId:"phone",computerId:"computer",sessionId:"session",epoch:"epoch",
    token:"dedicated-test-remote-token",expiresAt:Date.now()+60000,permissions:["text.submit","canvas.switch","card.pin"] };
  const snapshot: CanvasSnapshot = { computerName:"DEMO",ownerAvailable:true,ownerEpoch:"owner",activeCanvasId:"canvas",version:1,
    canvases:[{id:"canvas",title:"Canvas",version:1}],cards:[] };
  transports[0]!.receive(welcome); transports[0]!.receive({...scope,type:"snapshot",sequence:1,state:snapshot});
  return {client,transports,welcome,snapshot};
}
describe("phone confirmation and reconnect semantics", () => {
  it("exposes portal grants only when negotiated and retains same-ID move queries after timeout", () => {
    const { client, transports, welcome } = setup(); const t = transports[0]!;
    expect(client.getSnapshot().permissions).not.toContain("card.surface");
    expect(client.submit({ kind: "card.surface", cardId: "note", surface: "user" })).toBeNull();
    t.receive({ ...welcome, permissions: [...welcome.permissions, "card.surface"] });
    const id = client.submit({ kind: "card.surface", cardId: "note", surface: "user" })!;
    expect(id).toBeTruthy();
    expect(t.sent.at(-1)).toMatchObject({ type: "command", expectedVersion: 1, operation: { kind: "card.surface", surface: "user" } });
    vi.advanceTimersByTime(1001);
    expect(client.submit({ kind: "card.surface", cardId: "note", surface: "display" })).toBeNull();
    client.query(id);
    expect(t.sent.at(-1)).toMatchObject({ type: "query", requestId: id, canvasId: "canvas" });
    expect(t.sent.filter(frame => frame.type === "command")).toHaveLength(1);
    client.revoke(); expect(client.getSnapshot().permissions).toEqual([]);
  });
  it("keeps timed-out writes unknown despite late ACK/executing frames until a real result arrives", () => {
    const { client, transports } = setup(); const t = transports[0]!;
    const id = client.submit({ kind: "text.submit", text: "create once" })!;
    vi.advanceTimersByTime(1001);
    expect(client.getSnapshot().requests[0]?.status).toBe("unknown");
    t.receive({ ...scope, deviceId: "phone", type: "accepted", requestId: id });
    t.receive({ ...scope, type: "executing", forDeviceId: "phone", requestId: id });
    expect(client.getSnapshot().requests[0]?.status).toBe("unknown");
    expect(client.submit({ kind: "text.submit", text: "another write" })).toBeNull();
    t.receive({ ...scope, type: "result", forDeviceId: "phone", requestId: id, status: "succeeded", message: "confirmed once" });
    expect(client.getSnapshot().requests[0]).toMatchObject({ status: "succeeded", message: "confirmed once" });
    expect(t.sent.filter(frame => frame.type === "command")).toHaveLength(1);
  });
  it("does not let repeated progress ACKs extend the original request deadline or regress execution", () => {
    const { client, transports } = setup(); const t = transports[0]!;
    const id = client.submit({ kind: "text.submit", text: "deadline" })!;
    vi.advanceTimersByTime(400);
    t.receive({ ...scope, type: "executing", forDeviceId: "phone", requestId: id });
    vi.advanceTimersByTime(400);
    t.receive({ ...scope, deviceId: "phone", type: "accepted", requestId: id });
    expect(client.getSnapshot().requests[0]?.status).toBe("executing");
    vi.advanceTimersByTime(201);
    expect(client.getSnapshot().requests[0]?.status).toBe("unknown");
  });
  it("requires a fresh owner snapshot after reconnect before admitting another write", () => {
    const { client, transports, welcome, snapshot } = setup();
    client.reconnect(); const next = transports[1]!;
    next.receive(welcome);
    expect(client.getSnapshot().snapshot?.ownerAvailable).toBe(false);
    expect(client.submit({ kind: "text.submit", text: "stale state" })).toBeNull();
    next.receive({ ...scope, type: "snapshot", sequence: 2, state: { ...snapshot, version: 2 } });
    expect(client.submit({ kind: "text.submit", text: "fresh state" })).not.toBeNull();
    expect(next.sent.find(frame => frame.type === "command")).toMatchObject({ expectedVersion: 2 });
  });
  it("ignores queued transport events after explicit revocation", () => {
    const { client, transports, welcome, snapshot } = setup(); const t = transports[0]!;
    const lateCallbacks = [...t.listeners]; client.revoke();
    for (const callback of lateCallbacks) {
      callback({ type: "message", frame: welcome });
      callback({ type: "message", frame: { ...scope, type: "snapshot", sequence: 10, state: snapshot } });
    }
    expect(client.getSnapshot()).toMatchObject({ status: "revoked", snapshot: null });
    expect(client.submit({ kind: "text.submit", text: "late authority" })).toBeNull();
  });
  it("distinguishes relay ACK from execution and never lets late frames downgrade terminal results", () => {
    const {client,transports} = setup(); const t=transports[0]!;
    const id=client.submit({kind:"text.submit",text:"hello"})!;
    t.receive({...scope,deviceId:"phone",type:"accepted",requestId:id});
    expect(client.getSnapshot().requests[0]?.status).toBe("accepted");
    t.receive({...scope,type:"result",forDeviceId:"phone",requestId:id,status:"succeeded",message:"done"});
    t.receive({...scope,deviceId:"phone",type:"accepted",requestId:id});
    t.receive({...scope,type:"executing",forDeviceId:"phone",requestId:id});
    t.receive({...scope,type:"result",forDeviceId:"phone",requestId:id,status:"unknown",message:"old response"});
    vi.advanceTimersByTime(2000);
    expect(client.getSnapshot().requests[0]).toMatchObject({status:"succeeded",message:"done"});
  });
  it("ignores old/out-of-order snapshots and messages for another session/device", () => {
    const {client,transports,snapshot} = setup(); const t=transports[0]!;
    t.receive({...scope,type:"snapshot",sequence:3,state:{...snapshot,version:3}});
    t.receive({...scope,type:"snapshot",sequence:2,state:{...snapshot,version:2}});
    t.receive({...scope,type:"snapshot",sessionId:"other",sequence:9,state:{...snapshot,version:9}});
    t.receive({...scope,type:"snapshot",deviceId:"intruder",sequence:10,state:{...snapshot,version:10}});
    expect(client.getSnapshot().snapshot?.version).toBe(3);
    const id=client.submit({kind:"text.submit",text:"hello"})!;
    t.receive({...scope,type:"result",forDeviceId:"other-phone",requestId:id,status:"succeeded",message:"foreign"});
    expect(client.getSnapshot().requests[0]?.status).toBe("sending");
  });
  it("reconnects using the memory token, queries uncertain outcomes and never replays a write", () => {
    const {client,transports,welcome} = setup(); const t=transports[0]!;
    const id=client.submit({kind:"text.submit",text:"hello"})!;
    t.disconnect(); expect(client.getSnapshot().requests[0]?.status).toBe("unknown");
    vi.advanceTimersByTime(10); const next=transports[1]!;
    expect(next.sent[0]).toMatchObject({type:"hello",role:"mobile",token:welcome.token});
    next.receive(welcome);
    expect(next.sent.filter(f=>f.type==="command")).toHaveLength(0);
    expect(next.sent.find(f=>f.type==="query")).toMatchObject({requestId:id,canvasId:"canvas"});
    expect(client.submit({kind:"text.submit",text:"duplicate"})).toBeNull();
  });
  it("treats timeout as unknown, requests cancellation without claiming rollback, and blocks blind retry", () => {
    const {client,transports} = setup(); const t=transports[0]!;
    const id=client.submit({kind:"text.submit",text:"hello"})!;
    client.cancel(id); expect(client.getSnapshot().requests[0]?.status).toBe("sending");
    expect(t.sent.at(-1)?.type).toBe("cancel");
    vi.advanceTimersByTime(1001); expect(client.getSnapshot().requests[0]?.status).toBe("unknown");
    expect(client.submit({kind:"card.pin",cardId:"note",pinned:true})).toBeNull();
    client.query(id); expect(t.sent.at(-1)?.type).toBe("query");
  });
  it("disables control when the owner is unavailable and discards authorization on expiry/revocation", () => {
    const {client,transports} = setup(); const t=transports[0]!;
    t.receive({...scope,type:"status",ownerAvailable:false,reason:"owner unavailable"});
    expect(client.submit({kind:"text.submit",text:"hello"})).toBeNull();
    t.receive({...scope,type:"revoked",reason:"computer revoked pairing"});
    expect(client.getSnapshot()).toMatchObject({status:"revoked",snapshot:null});
    client.reconnect(); expect(client.getSnapshot().status).toBe("unpaired");
  });
  it("keeps an uncertain write uncertain when a result query fails at the relay", () => {
    const {client,transports} = setup(); const t=transports[0]!;
    const id=client.submit({kind:"text.submit",text:"hello"})!;
    t.receive({...scope,deviceId:"phone",type:"accepted",requestId:id});
    t.receive({v:1,type:"error",code:"owner-offline",message:"Owner offline",requestId:id});
    expect(client.getSnapshot().requests[0]?.status).toBe("unknown");
    expect(client.submit({kind:"text.submit",text:"retry"})).toBeNull();
  });
  it("drops invalid resumed sessions instead of reconnecting forever with an expired token", () => {
    const {client,transports} = setup();
    transports[0]!.receive({v:1,type:"error",code:"invalid-session",message:"Session invalid"});
    expect(client.getSnapshot()).toMatchObject({status:"expired",snapshot:null});
    client.reconnect(); expect(client.getSnapshot().status).toBe("unpaired");
  });
  it("forgets all credentials when a new client document is created", () => {
    const {welcome} = setup();
    const fresh=createMobileClient({id:"phone"}); clients.push(fresh);
    expect(fresh.getSnapshot()).toMatchObject({status:"unpaired",snapshot:null,expiresAt:null});
    expect(JSON.stringify(fresh.getSnapshot())).not.toContain(welcome.token);
    fresh.reconnect(); expect(fresh.getSnapshot().status).toBe("unpaired");
  });
});
describe("strict transport boundary", () => {
  it("requires WSS outside loopback and rejects URL credentials/query payloads", () => {
    expect(validateRelayUrl("ws://127.0.0.1:8791/relay")).toBe("ws://127.0.0.1:8791/relay");
    for(const url of ["ws://192.168.0.2/relay","https://relay.test","wss://relay.test?token=secret","wss://name:secret@relay.test"]) expect(()=>validateRelayUrl(url)).toThrow();
  });
  it("rejects unknown fields, malformed authentication and oversized wire messages", () => {
    expect(parseFrame({v:1,type:"hello",role:"mobile",deviceId:"phone",deviceName:"Phone",token:"dedicated-test-remote-token",pairCode:"PAIRCODE12"})).toBeNull();
    expect(parseFrame(JSON.stringify({v:1,type:"error",code:"x",message:"x".repeat(33000)}))).toBeNull();
    expect(parseFrame("not-json")).toBeNull();
  });
});
