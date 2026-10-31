import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createHostedService } from "../src/hosted/service.js";
import type { DecisionTrace } from "../src/decision/trace.js";
import { emptyContext } from "./helpers.js";

const ORIGIN = "https://unit.test";
const folders: string[] = [], services: ReturnType<typeof createHostedService>[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
  for (const folder of folders.splice(0)) {
    const absolute = realpathSync(folder);
    expect(path.dirname(absolute)).toBe(realpathSync(tmpdir()));
    expect(path.basename(absolute)).toMatch(/^vivic-decision-log-/);
    rmSync(absolute, { recursive: true, force: true });
  }
});
const trace = (id: string, status: DecisionTrace["status"] = "complete"): DecisionTrace => ({
  id, mode: "shadow", status, clauses: ["显示全部"], decisions: [], route: status === "pending" ? null : "overview",
  probability: status === "pending" ? 0 : .99, latencyMs: 10, routeLatencyMs: 10, legacyElapsedMs: 2,
  shadowWaitMs: 0, failedCount: 0, legacyKind: "envelope", legacyUsedProvider: "rules",
  legacyActionTypes: ["canvas.fit"], legacyCardTypes: [],
});
async function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "vivic-decision-log-"));folders.push(dir);
  let clock = Date.parse("2026-10-29T10:00:00Z");
  const options = { dataDir: dir, origin: ORIGIN, now: () => clock, autoStartReminders: false,
    router: { mode: "shadow" as const, routeUtterance: vi.fn(async () => ({ route: "overview" as const,
      probability: .99, probabilities: { overview: .99, chat: .01 }, none: false, latencyMs: 5 })),
    chooseTarget: vi.fn(async () => null) } };
  const firstService = createHostedService({ ...options, inviteCode: "unit-invite-for-one" });
  const first = await firstService.store.register({ invite: "unit-invite-for-one", username: "alpha", password: "unit-password-alpha" });
  await firstService.dispose();
  const service = createHostedService({ ...options, inviteCode: "unit-invite-for-two" });services.push(service);
  const second = await service.store.register({ invite: "unit-invite-for-two", username: "beta", password: "unit-password-beta" });
  const a = first.identity.accountId, b = second.identity.accountId;
  const aSpace = service.store.listSpaces(a)[0]!.id, bSpace = service.store.listSpaces(b)[0]!.id;
  const request = (token: string | null, route: string, body?: unknown) => service.fetch(new Request(ORIGIN + route, {
    method: body === undefined ? "GET" : "POST", headers: { origin: ORIGIN, "content-type": "application/json",
      ...(token ? { cookie: `__Host-vivic_space=${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { service, dir, a, b, aSpace, bSpace, first, second, request, advance: (ms: number) => { clock += ms; } };
}
describe("private decision log", () => {
  it("isolates authenticated owners and enforces the read limit", async () => {
    const f = await fixture();
    f.service.store.recordDecisionLog(f.a, { text: "alpha", path: "browser", trace: trace("same-id"), spaceId: f.aSpace });
    f.service.store.recordDecisionLog(f.b, { text: "beta", path: "browser", trace: trace("same-id"), spaceId: f.bSpace });
    const response = await f.request(f.first.token, "/api/space/decision-log?limit=200&accountId=" + f.b);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({ accountId: f.a, text: "alpha" });
    expect((await f.request(null, "/api/space/decision-log")).status).toBe(401);
    expect((await f.request(f.first.token, "/api/space/decision-log?limit=201")).status).toBe(400);
    expect((await f.request(f.first.token, "/api/space/decision-log?limit=0")).status).toBe(400);
  });
  it("upserts late completion without duplicating or losing undo and outcome", async () => {
    const f = await fixture(), store = f.service.store;
    const first = store.recordDecisionLog(f.a, { text: "one", path: "task", trace: trace("late", "pending"), spaceId: f.aSpace, outcome: "pending" });
    store.setDecisionOutcome(f.a, "late", "failed");
    store.markLastDecisionUndone(f.a, f.aSpace);
    const updated = store.recordDecisionLog(f.a, { text: "one", path: "task", trace: trace("late"), spaceId: f.aSpace, outcome: "succeeded" });
    store.recordDecisionLog(f.a, { text: "one", path: "task", trace: trace("late", "pending") });
    expect(updated).toEqual({ id: first.id, inserted: false });
    expect(store.listDecisionLogs(f.a)).toHaveLength(1);
    expect(store.listDecisionLogs(f.a)[0]).toMatchObject({ trace: { status: "complete" }, outcome: "failed", undone: true });
  });
  it("redacts credential-like text throughout traces and does not bind a foreign space", async () => {
    const f = await fixture(), secret = ["sk", "unit-fake-key-abcdefghijklmnopqrstuvwxyz"].join("-");
    const value = trace("redacted");value.clauses = [`password:private-fixture ${secret}`];
    f.service.store.recordDecisionLog(f.a, { spaceId: f.bSpace, text: `token=private-fixture ${secret}`, path: "browser", trace: value });
    const row = f.service.store.listDecisionLogs(f.a)[0]!;
    expect(row.spaceId).toBeNull();
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(JSON.stringify(row)).not.toContain("private-fixture");
    expect(row.text).toContain("[redacted]");
  });
  it("marks only the recent owned event, excluding the undo command itself", async () => {
    const f = await fixture(), store = f.service.store;
    store.recordDecisionLog(f.a, { spaceId: f.aSpace, text: "old", path: "browser", trace: trace("old") });
    f.advance(31_000);store.markLastDecisionUndone(f.a, f.aSpace);
    expect(store.listDecisionLogs(f.a)[0]!.undone).toBe(false);
    store.recordDecisionLog(f.a, { spaceId: f.aSpace, text: "new", path: "browser", trace: trace("new") });
    store.recordDecisionLog(f.b, { spaceId: f.bSpace, text: "beta", path: "browser", trace: trace("beta") });
    const undo = trace("undo");undo.legacyActionTypes = ["history.undo"];undo.route = "undo";
    store.recordDecisionLog(f.a, { spaceId: f.aSpace, text: "undo", path: "browser", trace: undo });
    store.markLastDecisionUndone(f.a, f.aSpace);
    expect(store.listDecisionLogs(f.a).find(x => x.trace.id === "new")!.undone).toBe(true);
    expect(store.listDecisionLogs(f.a).find(x => x.trace.id === "undo")!.undone).toBe(false);
    expect(store.listDecisionLogs(f.b)[0]!.undone).toBe(false);
  });
  it("records both browser and hosted-task paths without changing the response", async () => {
    const f = await fixture();
    const response = await f.request(f.first.token, "/api/intent", { text: "显示全部", canvasContext: { ...emptyContext(), canvasId: f.aSpace } });
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("trace.mode", "shadow");
    await vi.waitFor(() => expect(f.service.store.listDecisionLogs(f.a).filter(x => x.path === "browser")).toHaveLength(1));
    const submitted = await f.request(f.first.token, `/api/space/spaces/${f.aSpace}/tasks`, {
      requestId: "observe-task", text: "倒计时50分钟", expectedVersion: f.service.store.getSnapshot(f.a, f.aSpace).space.version,
    });
    expect(submitted.status).toBe(202);
    await vi.waitFor(() => expect(f.service.store.listDecisionLogs(f.a).some(x => x.path === "task")).toBe(true));
    expect(f.service.store.listDecisionLogs(f.b)).toHaveLength(0);
  });
  it("retains at most 20000 rows globally", async () => {
    const f = await fixture();
    const db = new DatabaseSync(f.service.store.databasePath);
    const insert = db.prepare("INSERT INTO decision_log(at,account_id,path,text,trace_json) VALUES(?,?,?,?,?)");
    db.exec("BEGIN");
    for (let i = 0; i < 20000; i++) insert.run("2026-10-29T10:00:00.000Z", f.a, "browser", "seed", JSON.stringify(trace(`seed-${i}`)));
    db.exec("COMMIT");db.close();
    f.service.store.recordDecisionLog(f.a, { text: "newest", path: "browser", trace: trace("newest") });
    const check = new DatabaseSync(f.service.store.databasePath, { readOnly: true });
    expect(check.prepare("SELECT count(*) AS n FROM decision_log").get()?.n).toBe(20000);
    expect(check.prepare("SELECT id FROM decision_log WHERE id=1").get()).toBeUndefined();
    check.close();
    expect(f.service.store.listDecisionLogs(f.a, 999)).toHaveLength(200);
  });
  it("marks a committed undo once and preserves later events on command retry", async () => {
    const f = await fixture(), store = f.service.store;
    const requestId = "create-note";
    store.applyEnvelope(f.a, f.aSpace, { requestId, expectedVersion: store.getSnapshot(f.a, f.aSpace).space.version,
      envelope: { schemaVersion: "0.6", requestId, canvasId: f.aSpace, actions: [{ type: "card.create", card: {
        id: "unit-note", type: "NoteCard", variant: "minimal", displayProps: { text: "unit note" }, sourceData: {}, sources: [],
        layout: { x: 0, y: 0, width: 264, height: 120, pinned: false },
        metadata: { createdAt: "2026-10-29T10:00:00.000Z", updatedAt: "2026-10-29T10:00:00.000Z" },
      } }] } }, f.first.identity.device.id);
    store.recordDecisionLog(f.a, { spaceId: f.aSpace, text: "create", path: "task", trace: trace("before-undo") });
    const undo = { requestId: "undo-note", expectedVersion: store.getSnapshot(f.a, f.aSpace).space.version,
      command: { type: "history.undo" as const } };
    store.applyCommand(f.a, f.aSpace, undo, f.first.identity.device.id);
    expect(store.getSnapshot(f.a, f.aSpace).space.cards).toHaveLength(0);
    expect(store.listDecisionLogs(f.a)[0]!.undone).toBe(true);
    store.recordDecisionLog(f.a, { spaceId: f.aSpace, text: "later", path: "browser", trace: trace("after-undo") });
    expect(store.applyCommand(f.a, f.aSpace, undo, f.first.identity.device.id).deduplicated).toBe(true);
    expect(store.listDecisionLogs(f.a)[0]!.undone).toBe(false);
  });
  it("reopens an existing database without losing or duplicating log rows", async () => {
    const f = await fixture();
    f.service.store.recordDecisionLog(f.a, { text: "persist", path: "browser", trace: trace("persist") });
    await f.service.dispose();
    const reopened = createHostedService({ origin: ORIGIN, dataDir: f.dir, autoStartReminders: false });services.push(reopened);
    expect(reopened.store.listDecisionLogs(f.a)).toHaveLength(1);
    expect(reopened.store.listDecisionLogs(f.a)[0]!.trace.id).toBe("persist");
  });
  it("attributes a quick browser execution receipt to its one original trace", async () => {
    const f = await fixture();
    const context = { ...emptyContext(), canvasId: f.aSpace };
    const response = await f.request(f.first.token, "/api/intent", { text: "显示全部", canvasContext: context, task: { id: "browser-task" } });
    const result = await response.json();
    expect(result.task.status).toBe("awaiting_execution");
    const receipt = await f.request(f.first.token, "/api/intent", { text: "显示全部", canvasContext: context,
      task: { id: "browser-task", receipt: { executionId: result.task.executionId, status: "succeeded" } } });
    expect((await receipt.json()).task.status).toBe("completed");
    await vi.waitFor(() => expect(f.service.store.listDecisionLogs(f.a)[0]?.outcome).toBe("succeeded"));
    expect(f.service.store.listDecisionLogs(f.a)).toHaveLength(1);
    expect(f.service.store.listDecisionLogs(f.a)[0]!.trace.taskId).toBe("browser-task");
    expect(f.service.store.listDecisionLogs(f.b)).toHaveLength(0);
  });
});
