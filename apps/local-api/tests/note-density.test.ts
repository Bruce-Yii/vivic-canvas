import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ActionEnvelopeSchema, ActionSchema, type Action, type CardRecord } from "@vivic/contracts";
import { CredentialStore } from "../src/credentials.js";
import { runIntent } from "../src/intent/pipeline.js";
import { buildSystemPrompt } from "../src/intent/prompt.js";
import { actionExecutionIssue } from "../src/intent/validation.js";
import { chatOk, emptyContext, fetchStub } from "./helpers.js";

const original = { originalText: "TEST full source text is never rewritten", nested: { text: "TEST original metadata" } };
const context = () => emptyContext([
  { id: "note-1", type: "NoteCard", displayProps: { text: "TEST note text" }, sourceDataSummary: structuredClone(original), layout: { x: 0, y: 0 } },
  { id: "todo-1", type: "TodoCard", displayProps: { items: [{ id: "i1", text: "TEST task", done: false }] }, sourceDataSummary: {}, layout: { x: 300, y: 0 } },
  { id: "cd-1", type: "CountdownCard", displayProps: {}, sourceDataSummary: { targetAt: "2026-10-15T10:00:00.000Z" }, layout: { x: 600, y: 0 } },
]);
const note = (): CardRecord => ({ id: "new-note", type: "NoteCard", variant: "minimal", displayProps: { text: "TEST new Note" }, sourceData: original,
  sources: [], layout: { x: 0, y: 0, width: 264, height: 128, pinned: false },
  metadata: { createdAt: "2026-10-15T00:00:00.000Z", updatedAt: "2026-10-15T00:00:00.000Z" } });
const setup = (answers: unknown[]) => {
  const credentials = new CredentialStore();
  credentials.set({ apiKey: "TEST-note-density-key", models: ["step-3.5-flash"], defaultModel: "step-3.5-flash", checkedAt: "TEST" });
  let index = 0;
  const fetchImpl = vi.fn(fetchStub({ "/chat/completions": () => chatOk(answers[Math.min(index++, answers.length - 1)]) }));
  return { fetchImpl, deps: { credentials, stepfun: { baseUrl: "https://unit.test/v1", fetchImpl } } };
};

describe("Note density contract and execution boundary", () => {
  it.each(["minimal", "standard", "expanded"] as const)("accepts optional variant %s and preserves context/sourceData exactly", variant => {
    const action: Action = { type: "card.update", targetId: "note-1", variant };
    expect(ActionSchema.parse(action)).toEqual(action);
    const ctx = context(), before = structuredClone(ctx);
    expect(actionExecutionIssue([action], ctx)).toBeNull(); expect(ctx).toEqual(before);
    expect(actionExecutionIssue([{ ...action, displayProps: {}, sourceData: {} }], ctx)).toBeNull();
  });
  it("keeps the handoff JSON update contract in sync without widening focus", () => {
    const schema = JSON.parse(readFileSync(new URL("../../../Vivic_Kimi_Handoff_v0.6/contracts/action-envelope.schema.json", import.meta.url), "utf8"));
    const actions = schema.properties.actions.items.oneOf as Array<{ properties: Record<string, { const?: string; enum?: string[] }>; required: string[]; additionalProperties: boolean }>;
    const update = actions.find(action => action.properties.type.const === "card.update")!;
    expect(update.properties.variant.enum).toEqual(["minimal", "standard", "expanded"]);
    expect(update.required).not.toContain("variant"); expect(update.additionalProperties).toBe(false);
    expect(actions.find(action => action.properties.type.const === "card.focus")!.properties).not.toHaveProperty("variant");
    expect(ActionSchema.safeParse({ type: "card.focus", targetId: "note-1", variant: "expanded" }).success).toBe(false);
  });
  it.each(["full", "html", "", 1, null])("rejects unsupported variant %j at the shared schema", variant => {
    expect(ActionSchema.safeParse({ type: "card.update", targetId: "note-1", variant }).success).toBe(false);
  });
  it.each(["TodoCard", "CountdownCard", "SearchResultCard", "WeatherCard", "TableCard", "ChartCard"])("rejects any variant update on %s", type => {
    const ctx = emptyContext([{ id: "other", type, displayProps: {}, sourceDataSummary: {}, layout: { x: 0, y: 0 } }]);
    for (const variant of ["minimal", "standard", "expanded"] as const) {
      expect(actionExecutionIssue([{ type: "card.update", targetId: "other", variant }], ctx)).not.toBeNull();
    }
  });
  it("rejects content/original-source edits bundled with a density change", () => {
    for (const fields of [{ displayProps: { text: "rewritten" } }, { sourceData: { originalText: "rewritten" } },
      { displayProps: { html: "<script>TEST</script>" } }]) {
      expect(actionExecutionIssue([{ type: "card.update", targetId: "note-1", variant: "expanded", ...fields }], context())).toContain("不能同时改写");
    }
  });
  it.each(["WeatherCard", "TableCard", "ChartCard"])("allows camera/delete on existing %s without enabling invented data", type => {
    const ctx = emptyContext([{ id: "data", type, displayProps: {}, sourceDataSummary: {}, layout: { x: 0, y: 0 } }]);
    expect(actionExecutionIssue([{ type: "card.focus", targetId: "data" }, { type: "card.highlight", targetId: "data" }, { type: "card.delete", targetId: "data" }], ctx)).toBeNull();
    expect(actionExecutionIssue([{ type: "card.update", targetId: "data", displayProps: { value: 999 } }], ctx)).not.toBeNull();
  });
  it("validates targets sequentially, including new Notes and already-deleted Notes", () => {
    expect(actionExecutionIssue([{ type: "card.create", card: note() }, { type: "card.update", targetId: "new-note", variant: "expanded" }], context())).toBeNull();
    for (const actions of [
      [{ type: "card.update", targetId: "missing", variant: "expanded" }],
      [{ type: "card.delete", targetId: "note-1" }, { type: "card.update", targetId: "note-1", variant: "expanded" }],
    ] as Action[][]) expect(actionExecutionIssue(actions, context())).toContain("不存在或已删除");
  });
  it("keeps fieldless updates invalid and existing content/focus actions unchanged", () => {
    expect(actionExecutionIssue([{ type: "card.update", targetId: "note-1" }], context())).toContain("必须包含字段");
    expect(actionExecutionIssue([{ type: "card.focus", targetId: "note-1" }], context())).toBeNull();
    expect(actionExecutionIssue([{ type: "card.update", targetId: "note-1", displayProps: { text: "TEST explicit content edit" } }], context())).toBeNull();
  });
});

describe("LLM Note density through the real planner and validator", () => {
  it.each(["minimal", "standard", "expanded"] as const)("accepts a Note-only %s update without rewriting source text", async variant => {
    const actions: Action[] = [{ type: "card.update", targetId: "note-1", variant }], { deps, fetchImpl } = setup([{ actions }]);
    const ctx = context(), before = structuredClone(ctx);
    const result = await runIntent({ text: "按明确要求调整便笺信息密度", canvasContext: ctx }, deps);
    expect(result.kind).toBe("envelope"); expect(ActionEnvelopeSchema.safeParse(result.envelope).success).toBe(true);
    expect(result.envelope?.actions).toEqual(actions); expect(ctx).toEqual(before); expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it.each(["todo-1", "cd-1"])("retries then clarifies non-Note density target %s without partial execution", async targetId => {
    const { deps, fetchImpl } = setup([{ actions: [{ type: "canvas.fit" }, { type: "card.update", targetId, variant: "expanded" }] }]);
    const result = await runIntent({ text: "按要求展开卡片", canvasContext: context() }, deps);
    expect(result.kind).toBe("clarify"); expect(result.envelope).toBeUndefined(); expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1]![1]?.body)).toContain("NoteCard");
  });
  it("retries an original-text rewrite and accepts a repair containing only variant", async () => {
    const { deps, fetchImpl } = setup([
      { actions: [{ type: "card.update", targetId: "note-1", variant: "expanded", sourceData: { originalText: "rewritten" } }] },
      { actions: [{ type: "card.update", targetId: "note-1", variant: "expanded" }] },
    ]);
    const result = await runIntent({ text: "展开便笺但保留原文", canvasContext: context() }, deps);
    expect(result.envelope?.actions).toEqual([{ type: "card.update", targetId: "note-1", variant: "expanded" }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("keeps explicit clarification authoritative even if a density action accompanies it", async () => {
    const { deps } = setup([{ actions: [{ type: "card.update", targetId: "note-1", variant: "expanded" }], clarify: "你想展开哪张便笺？" }]);
    const result = await runIntent({ text: "展开那张便笺", canvasContext: context() }, deps);
    expect(result.kind).toBe("clarify"); expect(result.envelope).toBeUndefined();
  });
  it("instructs the model to clarify ambiguity, keep focus separate, and emit a variant-only update", () => {
    const prompt = buildSystemPrompt();
    for (const text of ["只有NoteCard", "card.update.variant", "card.focus只改变镜头", "多张便笺", "返回clarify", "禁止同时改写displayProps/sourceData"]) expect(prompt).toContain(text);
  });
});
