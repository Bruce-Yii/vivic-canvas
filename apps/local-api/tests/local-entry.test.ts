import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalApp } from "../src/index.js";
import { CredentialStore } from "../src/credentials.js";
import type { CanvasContext } from "../src/schemas.js";
import { authed, testConfig } from "./helpers.js";

const apps: Array<ReturnType<typeof createLocalApp>> = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.dispose();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const note = (id: string, text: string): CanvasContext["cards"][number] => ({
  id, type: "NoteCard", displayProps: { text }, sourceDataSummary: {},
  layout: { x: 0, y: 0, width: 320, height: 120, pinned: false },
});
const canvas = (): CanvasContext => ({ canvasId: "TEST-local-entry", version: 2, stage: "WORKSPACE",
  viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], cards: [note("note-1", "读书笔记")] });

describe("the local default entry builds the same router as hosted", () => {
  it("honours VIVIC_DECISION_* and publishes a delete route hint plus confirmation", async () => {
    vi.stubEnv("VIVIC_DECISION_MODE", "on");
    vi.stubEnv("VIVIC_DECISION_URL", "https://decision.test/v1/decisions");
    vi.stubEnv("VIVIC_DECISION_API_KEY", "TEST-decision-key");
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { questions?: Record<string, unknown> };
      expect(body.questions).toHaveProperty("route");
      return Response.json({ answers: { route: { choice: "delete", none: false, probabilities: { delete: .99 } } } });
    });
    const app = createLocalApp({ config: testConfig(), fetchImpl, providerPersist: false });
    apps.push(app);
    const response = await app.request("/api/intent", { method: "POST",
      headers: { ...authed, accept: "text/event-stream" },
      body: JSON.stringify({ text: "删除读书笔记", canvasContext: canvas(), task: { id: "local-entry-1" } }) });
    const text = await response.text();
    expect(text).toContain('"route":"delete"');
    expect(text).toContain('"targetState":"resolved"');
    expect(text).not.toContain('"scene":"task"');
    const result = JSON.parse(text.split("event: result\ndata: ")[1]!.trim());
    expect(result.kind).toBe("clarify");
    expect(result.message).toContain("确定删除");
    expect(result.envelope).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("keeps no-router local apps behind the same deletion confirmation", async () => {
    const credentials = new CredentialStore();
    credentials.set({ apiKey: "TEST-local-entry", models: ["step-3.5-flash"], defaultModel: "step-3.5-flash", checkedAt: "TEST" });
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({
      choices: [{ message: { content: JSON.stringify({ actions: [{ type: "card.delete", targetId: "note-1" }], spokenText: "已删除。" }) } }],
    }));
    const app = createLocalApp({ config: testConfig(), credentials, fetchImpl, providerPersist: false,
      router: { mode: "off", routeUtterance: async () => null, chooseTarget: async () => null } });
    apps.push(app);
    const response = await app.request("/api/intent", { method: "POST", headers: authed,
      body: JSON.stringify({ text: "删除读书笔记", canvasContext: canvas(), task: { id: "local-entry-2" } }) });
    const result = await response.json() as { kind: string; envelope?: unknown; message?: string };
    expect(result.kind).toBe("clarify");
    expect(result.message).toContain("确定删除");
    expect(result.envelope).toBeUndefined();
  });
});
