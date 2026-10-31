import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { CredentialStore } from "../src/credentials.js";
import type { CanvasContext } from "../src/schemas.js";
import type { IntentRouter } from "../src/decision/router.js";
import { authed, emptyContext, testConfig } from "./helpers.js";

const apps: Array<ReturnType<typeof createApp>> = [];
afterEach(() => { for (const app of apps.splice(0)) app.dispose(); vi.restoreAllMocks(); });

const note = (id: string, text: string): CanvasContext["cards"][number] => ({
  id, type: "NoteCard", displayProps: { text }, sourceDataSummary: {},
  layout: { x: 0, y: 0, width: 320, height: 120, pinned: false },
});
const canvas = (): CanvasContext => ({ ...emptyContext([note("note-1", "读书笔记")]), version: 4 });
const route = (id: "delete" | "focus") => ({ route: id, probability: .99, probabilities: { [id]: .99 }, none: false, latencyMs: 1 });

function setup(routeFor: (text: string) => "delete" | "focus" | null) {
  const credentials = new CredentialStore();
  const router: IntentRouter = {
    mode: "on",
    directRoutes: new Set(["countdown", "todo", "note", "overview", "restore"]),
    routeUtterance: vi.fn(async (text: string) => {
      const id = routeFor(text);
      return id ? route(id) : { route: null, probability: 0, probabilities: {}, none: true, latencyMs: 1 };
    }),
    chooseTarget: vi.fn(async () => null),
  };
  const app = createApp({ config: testConfig(), credentials, router });
  apps.push(app);
  return {
    app,
    async stream(text: string) {
      const response = await app.request("/api/intent", { method: "POST",
        headers: { ...authed, accept: "text/event-stream" },
        body: JSON.stringify({ text, canvasContext: canvas(), task: { id: "task-route-1" } }) });
      expect(response.status).toBe(200);
      return response.text();
    },
  };
}

const resultOf = (text: string) => JSON.parse(text.split("event: result\ndata: ")[1]!.trim());

describe("a task request does not let scene:\"task\" replace a known route", () => {
  it("publishes the delete route and resolved target for a ChatPage-style task request", async () => {
    const f = setup(text => /删除/.test(text) ? "delete" : null);
    const text = await f.stream("删除读书笔记");
    expect(text).toContain('"route":"delete"');
    expect(text).toContain('"targetState":"resolved"');
    expect(text).not.toContain('"scene":"task"');
    // Safety is unchanged: the route hint does not execute the delete.
    const result = resultOf(text);
    expect(result.kind).toBe("clarify");
    expect(result.message).toContain("确定删除");
    expect(result.envelope).toBeUndefined();
  });

  it("falls back to scene:\"task\" only when the classifier returns no route", async () => {
    const f = setup(() => null);
    const text = await f.stream("帮我处理一下这个");
    expect(text).toContain('"scene":"task"');
    expect(text).not.toContain('"route":"delete"');
    expect(text).not.toContain('"route":"focus"');
  });

  it("keeps the multi-clause scene instead of the task scene on a task request", async () => {
    const f = setup(() => null);
    const text = await f.stream("帮我记个便笺：明天交周报；加一个待办：买牛奶");
    expect(text).toContain('"scene":"multi"');
    expect(text).not.toContain('"scene":"task"');
  });

  it("still classifies an ordinary taskless request", async () => {
    const f = setup(text => /聚焦/.test(text) ? "focus" : null);
    const response = await f.app.request("/api/intent", { method: "POST",
      headers: { ...authed, accept: "text/event-stream" },
      body: JSON.stringify({ text: "聚焦读书笔记", canvasContext: canvas() }) });
    const text = await response.text();
    expect(text).toContain('"route":"focus"');
    expect(text).not.toContain('"scene"');
  });
});
