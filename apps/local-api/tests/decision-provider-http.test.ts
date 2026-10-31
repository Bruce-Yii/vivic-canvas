import { once } from "node:events";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { LocalApiConfig } from "../src/config.js";
import { DECISION_ACTIONS } from "../src/decision/intent.js";
import { IntentResponseSchema, type CanvasContext } from "../src/schemas.js";
import { authed, emptyContext, testConfig } from "./helpers.js";

// Synthetic classification responses test the integration contract, not model accuracy.
const scores = () => Object.fromEntries(DECISION_ACTIONS.map(id => [id, id === "expand" ? .94 : .01]));
const notes = (count = 1) => emptyContext(Array.from({ length: count }, (_, index) => ({
  id: `TEST-note-${index + 1}`, type: "NoteCard" as const, displayProps: { text: "TEST synthetic note" },
  sourceDataSummary: {}, layout: { x: index * 350, y: 0 },
})));
const json = (response: ServerResponse, value: unknown, status = 200) => {
  response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value));
};
const close = (server: Server) => new Promise<void>((resolve, reject) => {
  server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
});
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  const results = await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup()));
  for (const result of results) if (result.status === "rejected") throw result.reason;
});

async function startRig(options: {
  config?: Partial<LocalApiConfig>; fallback?: boolean;
  respond?: (response: ServerResponse, path: string) => void;
} = {}) {
  const calls: Array<{ path: string; authorization?: string; payload: unknown }> = [];
  const upstream = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    calls.push({ path: request.url!, authorization: request.headers.authorization, payload: JSON.parse(raw) });
    if (options.respond) options.respond(response, request.url!);
    else json(response, { choice_id: "expand", probabilities: scores() });
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  cleanups.push(() => close(upstream));
  const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const app = createApp({ config: testConfig({
    decisionProviderUrl: `${upstreamUrl}/decide`, decisionProviderKind: "local", decisionProviderTimeoutMs: 1000,
    ...(options.fallback ? { decisionProviderFallbackUrl: `${upstreamUrl}/fallback` } : {}), ...options.config,
  }) });
  const api = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  if (!api.listening) await once(api, "listening");
  cleanups.push(async () => { app.dispose(); await close(api as Server); });
  const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  const intent = async (text: string, canvasContext: CanvasContext = notes()) => {
    const response = await fetch(`${apiUrl}/api/intent`, { method: "POST", headers: authed, body: JSON.stringify({ text, canvasContext }) });
    expect(response.status).toBe(200);
    return IntentResponseSchema.parse(await response.json());
  };
  const lifecycle = async (action: string) => {
    const response = await fetch(`${apiUrl}/api/decision/${action}`, { method: "POST", headers: authed });
    expect(response.status).toBe(200); return response.json();
  };
  return { calls, apiUrl, intent, lifecycle };
}

describe("DEC-01 real loopback HTTP integration", () => {
  it("keeps exact rules ahead of decision HTTP calls", async () => {
    const rig = await startRig();
    for (const text of ["显示全部", "十分钟倒计时"]) {
      expect(await rig.intent(text)).toMatchObject({ kind: "envelope", usedProvider: "rules" });
    }
    expect(rig.calls).toHaveLength(0);
  });

  it("turns a validated score response into host-generated actions for the one real target", async () => {
    const rig = await startRig({ config: { decisionProviderToken: "TEST-synthetic-bridge-token" } });
    const result = await rig.intent("展开便笺");
    expect(result).toMatchObject({ kind: "envelope", usedProvider: "decision" });
    if (result.kind !== "envelope" || !result.envelope) throw new Error("Expected a validated decision envelope");
    expect(result.envelope.actions).toEqual([
      { type: "card.update", targetId: "TEST-note-1", variant: "expanded" }, { type: "canvas.fit" },
    ]);
    expect(rig.calls).toHaveLength(1);
    expect(rig.calls[0]).toMatchObject({ path: "/decide", authorization: "Bearer TEST-synthetic-bridge-token", payload: {
      schema_version: "vivic-decision-provider-1", input: { utterance: "展开便笺", context: {}, choices: DECISION_ACTIONS.map(id => ({ id, decision: { intent: id } })) },
    } });
    expect(JSON.stringify(rig.calls[0]!.payload)).not.toContain("TEST-synthetic-bridge-token");
    expect(JSON.stringify(rig.calls[0]!.payload)).not.toContain("TEST-note-1");
  });

  it("asks for clarification when two cards could be the target", async () => {
    const rig = await startRig(); const result = await rig.intent("展开便笺", notes(2));
    expect(result).toMatchObject({ kind: "clarify", usedProvider: "decision" });
    expect(result).not.toHaveProperty("envelope"); expect(rig.calls).toHaveLength(1);
  });

  it.each(["不要展开便笺", "展开然后聚焦", "删除便笺", "引用“展开便笺”"])("does not execute guarded input %s despite a confident upstream response", async text => {
    const rig = await startRig(); const result = await rig.intent(text);
    expect(result).toMatchObject({ kind: "unknown", usedProvider: "rules-offline" });
    expect(result).not.toHaveProperty("envelope");
  });

  it("preserves the existing exact delete-all rule without sending it to a model", async () => {
    const rig = await startRig(); const result = await rig.intent("删除所有卡片", notes(2));
    expect(result).toMatchObject({ kind: "envelope", usedProvider: "rules" });
    if (result.kind !== "envelope" || !result.envelope) throw new Error("Expected the existing exact rule");
    expect(result.envelope.actions).toEqual([{ type: "cards.delete", targetIds: ["TEST-note-1", "TEST-note-2"] }]);
    expect(rig.calls).toHaveLength(0);
  });

  it("returns to the original offline pipeline after an HTTP service failure", async () => {
    const rig = await startRig({ respond: response => json(response, { error: "TEST-upstream-failure" }, 503) });
    const result = await rig.intent("展开便笺");
    expect(result).toMatchObject({ kind: "unknown", usedProvider: "rules-offline" });
    expect(JSON.stringify(result)).not.toContain("TEST-upstream-failure"); expect(rig.calls).toHaveLength(1);
  });

  it("bounds an actual HTTP response whose body never finishes", async () => {
    const rig = await startRig({ config: { decisionProviderTimeoutMs: 40 }, respond: response => {
      response.writeHead(200, { "content-type": "application/json" }); response.write('{"probabilities":');
    } });
    const result = await rig.intent("展开便笺");
    expect(result).toMatchObject({ kind: "unknown", usedProvider: "rules-offline" }); expect(rig.calls).toHaveLength(1);
    const status = await (await fetch(`${rig.apiUrl}/api/decision/status`, { headers: authed })).json();
    expect(status.lastState).toBe("timeout");
  });

  it("supports disabled startup, authenticated enable and stop without Kev preparation", async () => {
    const rig = await startRig({ config: { decisionProviderEnabled: false } });
    expect(await rig.intent("展开便笺")).toMatchObject({ kind: "unknown" }); expect(rig.calls).toHaveLength(0);
    expect(await rig.lifecycle("enable")).toMatchObject({ mode: "provider", enabled: true, phase: "ready", bytes: 0 });
    expect(await rig.intent("展开便笺")).toMatchObject({ kind: "envelope", usedProvider: "decision" }); expect(rig.calls).toHaveLength(1);
    expect(await rig.lifecycle("stop")).toMatchObject({ mode: "provider", enabled: false, phase: "cached" });
    expect(await rig.intent("展开便笺")).toMatchObject({ kind: "unknown" }); expect(rig.calls).toHaveLength(1);
  });

  it("protects intent and every decision lifecycle route with the existing local bearer", async () => {
    const rig = await startRig();
    for (const action of ["status", "prepare", "enable", "stop", "clear"]) {
      const response = await fetch(`${rig.apiUrl}/api/decision/${action}`, { method: action === "status" ? "GET" : "POST" });
      expect(response.status).toBe(401); await response.arrayBuffer();
    }
    const response = await fetch(`${rig.apiUrl}/api/intent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "展开便笺", canvasContext: notes() }) });
    expect(response.status).toBe(401); await response.arrayBuffer(); expect(rig.calls).toHaveLength(0);
  });

  it("uses the local score fallback only after an upstream transport failure", async () => {
    const rig = await startRig({ fallback: true, respond: (response, path) => path === "/decide"
      ? json(response, { error: "TEST-failure" }, 503) : json(response, { choice_id: "expand", probabilities: scores() }) });
    expect(await rig.intent("展开便笺")).toMatchObject({ kind: "envelope", usedProvider: "decision" });
    expect(rig.calls.map(call => call.path)).toEqual(["/decide", "/fallback"]);
  });

  it("does not turn a choice-only result into permission to use the fallback", async () => {
    const rig = await startRig({ fallback: true, respond: response => json(response, { choice_id: "expand" }) });
    expect(await rig.intent("展开便笺")).toMatchObject({ kind: "unknown", usedProvider: "rules-offline" });
    expect(rig.calls.map(call => call.path)).toEqual(["/decide"]);
  });

  it("can call a local chat endpoint without treating self-reported choice as calibrated confidence", async () => {
    const rig = await startRig({ config: { decisionProviderProtocol: "local-chat", decisionProviderModel: "TEST-local-model" },
      respond: response => json(response, { choices: [{ finish_reason: "stop", message: { content: '{"choice_id":"expand"}' } }] }) });
    expect(await rig.intent("展开便笺")).toMatchObject({ kind: "unknown", usedProvider: "rules-offline" });
    expect(rig.calls).toHaveLength(1);
    expect(rig.calls[0]!.payload).toMatchObject({ model: "TEST-local-model", temperature: 0, stream: false, messages: [
      { role: "system", content: expect.any(String) }, { role: "user", content: expect.stringContaining("展开便笺") },
    ] });
  });
});
