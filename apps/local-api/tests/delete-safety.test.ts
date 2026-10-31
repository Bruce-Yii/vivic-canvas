import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { CredentialStore } from "../src/credentials.js";
import type { CanvasContext } from "../src/schemas.js";
import type { IntentRouter } from "../src/decision/router.js";
import { authed, emptyContext, testConfig } from "./helpers.js";

const apps: Array<ReturnType<typeof createApp>> = [];
afterEach(() => { for (const app of apps.splice(0)) app.dispose(); vi.restoreAllMocks(); });

const note = (id: string, text: string, x = 0): CanvasContext["cards"][number] => ({
  id, type: "NoteCard", displayProps: { text }, sourceDataSummary: {},
  layout: { x, y: 0, width: 320, height: 120, pinned: false },
});
const canvas = (cards = [note("note-1", "读书笔记")]): CanvasContext =>
  ({ ...emptyContext(cards), version: 4 });

const credentials = () => {
  const store = new CredentialStore();
  store.set({ apiKey: "TEST-delete-safety", models: ["step-3.5-flash"], defaultModel: "step-3.5-flash", checkedAt: "TEST" });
  return store;
};
/** A planner that skips the route hint entirely and returns a delete envelope. */
const plannerDelete = (targetId = "note-1") => vi.fn<typeof fetch>(async () => Response.json({
  choices: [{ message: { content: JSON.stringify({ actions: [{ type: "card.delete", targetId }], spokenText: "已删除。" }) } }],
}));

async function post(app: ReturnType<typeof createApp>, body: unknown) {
  const response = await app.request("/api/intent", { method: "POST", headers: authed, body: JSON.stringify(body) });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ kind: string; message?: string; envelope?: unknown;
    task?: { id: string; status?: string; executionId?: string } }>;
}

describe("deletion cannot execute without a resolved target and explicit confirmation", () => {
  it("freezes a planner delete even when no decision router is configured", async () => {
    const app = createApp({ config: testConfig(), mode: "online", credentials: credentials(), fetchImpl: plannerDelete() });
    apps.push(app);
    const first = await post(app, { text: "删除读书笔记", canvasContext: canvas(), task: { id: "safety-1" } });
    expect(first.kind).toBe("clarify");
    expect(first.message).toContain("确定删除");
    expect(first.message).toContain("读书笔记");
    expect(first.envelope).toBeUndefined();
    expect(first.task?.status).toBe("awaiting_clarification");
    // The proposal is only released by a separate, whole-utterance affirmative.
    const confirmed = await post(app, { text: "确定", canvasContext: canvas(), task: { id: first.task!.id } });
    expect(confirmed.envelope).toEqual(expect.objectContaining({
      actions: [{ type: "card.delete", targetId: "note-1" }],
    }));
    expect(confirmed.task?.status).toBe("awaiting_execution");
  });

  it("reports a missing planner target as a clarification with no envelope", async () => {
    const app = createApp({ config: testConfig(), mode: "online", credentials: credentials(),
      fetchImpl: plannerDelete("ghost-card") });
    apps.push(app);
    const result = await post(app, { text: "删除读书笔记", canvasContext: canvas(), task: { id: "safety-2" } });
    expect(result.kind).toBe("clarify");
    expect(result.message).toBeTruthy();
    expect(result.message).not.toContain("已删除");
    expect(result.message).not.toContain("确定删除");
    expect(result.envelope).toBeUndefined();
    expect(result.task?.executionId).toBeUndefined();
  });

  it("asks which card when the delete route target is ambiguous", async () => {
    const router: IntentRouter = { mode: "on", directRoutes: new Set(),
      routeUtterance: async () => ({ route: "delete", probability: .99, probabilities: { delete: .99 }, none: false, latencyMs: 1 }),
      chooseTarget: async () => null };
    const app = createApp({ config: testConfig(), mode: "online", credentials: credentials(), router,
      fetchImpl: vi.fn<typeof fetch>() });
    apps.push(app);
    const result = await post(app, { text: "删除便笺", canvasContext: canvas([note("note-1", "读书笔记"), note("note-2", "会议记录", 400)]),
      task: { id: "safety-3" } });
    expect(result.kind).toBe("clarify");
    expect(result.message).toContain("你要删除哪张卡片？");
    expect(result.envelope).toBeUndefined();
  });

  it("does not treat a task id without a target as a delete confirmation", async () => {
    const app = createApp({ config: testConfig(), mode: "online", credentials: credentials(), fetchImpl: plannerDelete() });
    apps.push(app);
    const result = await post(app, { text: "删除", canvasContext: canvas(), task: { id: "safety-4" } });
    expect(result.kind).not.toBe("envelope");
    expect(result.envelope).toBeUndefined();
  });
});
