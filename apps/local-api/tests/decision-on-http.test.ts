import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { CredentialStore } from "../src/credentials.js";
import type { LocalApiConfig } from "../src/config.js";
import { IntentResponseSchema, type CanvasContext } from "../src/schemas.js";
import type { IntentRouter, RouteResult } from "../src/decision/router.js";
const origin = "https://unit.test", token = "TEST-on-http-token-12345678";
const config: LocalApiConfig = { host: "127.0.0.1", port: 0, token, tokenPath: "", tokenGenerated: false,
  allowedOrigins: [origin], stepfunBaseUrl: "https://model.test/v1", modelApiBaseUrl: "https://unused.test/v1",
  bodyLimitBytes: 65536, requestTimeoutMs: 60000, managedDecisionEnabled: false, decisionProviderEnabled: false, decisionV2ExecutionEnabled: false };
const card = (id: string, title: string): CanvasContext["cards"][number] => ({ id, type: "NoteCard", aliases: [title],
  displayProps: { text: title+"正文" }, sourceDataSummary: {}, layout: { x: 0, y: 0, width: 320, height: 120, pinned: false } });
const context = (cards: CanvasContext["cards"] = []): CanvasContext => ({ canvasId: "TEST-http", version: 1,
  stage: "WORKSPACE", viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], cards });
const apps: ReturnType<typeof createApp>[] = [];
afterEach(() => { for (const app of apps.splice(0)) app.dispose(); });
function setup(withModel=false) {
  const router: IntentRouter = { mode: "on", directRoutes: new Set(["countdown", "todo", "note", "overview", "restore"]),
    routeUtterance: vi.fn(async text => {
      const route: RouteResult["route"] = /删除/.test(text) ? "delete" : /聚焦/.test(text) ? "focus" : /倒计时/.test(text) ? "countdown" : "chat";
      return { route, probability: .99, probabilities: { [route]: .99 }, none:false, latencyMs:1 };
    }), chooseTarget: vi.fn(async () => null) };
  const credentials = new CredentialStore();
  if (withModel) credentials.set({ apiKey: "TEST-model-key-only", defaultModel:"step-3.7-flash", models:["step-3.7-flash"], checkedAt:new Date().toISOString() });
  const model = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); const user = JSON.parse(body.messages[1].content);
    expect(user.host_targets?.["0"]).toBe("a");
    return Response.json({ choices:[{message:{content:JSON.stringify({slots:{},say:"已聚焦。",text:"已选中目标。"})}}] });
  });
  const app = createApp({ config, mode:"online", credentials, router, fetchImpl:model as typeof fetch });apps.push(app);
  async function post(body: unknown) {
    const r = await app.fetch(new Request(origin+"/api/intent",{method:"POST",headers:{authorization:`Bearer ${token}`,origin,"content-type":"application/json"},body:JSON.stringify(body)}));
    expect(r.status).toBe(200);return IntentResponseSchema.parse(await r.json());
  }
  return { app, post, router, model };
}
describe("on-mode HTTP task and clarification integration", () => {
  it("wraps a taskless direct request and accepts its real execution receipt without reclassification", async () => {
    const f=setup();const r=await f.post({text:"倒计时50分钟",canvasContext:context()});
    expect(r.task?.status).toBe("awaiting_execution");expect(r.trace).toMatchObject({mode:"on",plannerCalls:0,directClauses:1});
    const creates=r.envelope!.actions.flatMap(a=>a.type==="card.create"?[a.card]:[]);
    const ctx={...context(creates.map(c=>({id:c.id,type:c.type,displayProps:c.displayProps,sourceDataSummary:c.sourceData,layout:c.layout}))),version:2};
    const receipt=await f.post({text:"倒计时50分钟",canvasContext:ctx,task:{id:r.task!.id,receipt:{executionId:r.task!.executionId,status:"succeeded",createdCardIds:creates.map(c=>c.id)}}});
    expect(receipt.task?.status).toBe("completed");expect(receipt.envelope).toBeUndefined();
    expect(f.router.routeUtterance).not.toHaveBeenCalled();expect(f.model).not.toHaveBeenCalled();
  });
  it("asks for confirmation before an explicit named deletion without a main model", async () => {
    const f=setup(),ctx=context([card("a","读书笔记")]);
    const q=await f.post({text:"删除读书笔记",canvasContext:ctx});
    expect(q.kind).toBe("clarify");expect(q.message).toContain("确定删除");expect(q.envelope).toBeUndefined();
    const yes=await f.post({text:"确定",canvasContext:ctx,task:{id:q.task!.id}});
    expect(yes.task?.status).toBe("awaiting_execution");expect(yes.envelope?.actions).toContainEqual({type:"card.delete",targetId:"a"});
    expect(f.model).not.toHaveBeenCalled();
  });
  it("resolves ambiguous focus by a frozen candidate and sends that host selection to the slots model", async () => {
    const f=setup(true),ctx=context([card("a","读书笔记"),card("b","会议记录")]);
    const q=await f.post({text:"聚焦便签",canvasContext:ctx});
    expect(q.kind).toBe("clarify");expect(q.task?.clarification?.candidates.map(c=>c.id)).toEqual(["a","b"]);
    expect(q).not.toHaveProperty("targetCandidates");expect(f.model).not.toHaveBeenCalled();
    const next=await f.post({text:"第一个",canvasContext:{...ctx,cards:[ctx.cards[1]!,ctx.cards[0]!] },task:{id:q.task!.id}});
    expect(next.task?.status).toBe("awaiting_execution");expect(next.envelope?.actions).toContainEqual({type:"card.focus",targetId:"a"});
    expect(f.model).toHaveBeenCalledTimes(1);
  });
  it("rejects client-supplied host selection fields", async () => {
    const f=setup();
    const r=await f.app.fetch(new Request(origin+"/api/intent",{method:"POST",headers:{authorization:`Bearer ${token}`,origin,"content-type":"application/json"},body:JSON.stringify({text:"倒计时50分钟",canvasContext:context(),resolvedTargetId:"foreign"})}));
    expect(r.status).toBe(400);expect(f.router.routeUtterance).not.toHaveBeenCalled();
  });
});
