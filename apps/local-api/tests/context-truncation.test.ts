import { describe, expect, it } from "vitest";
import { actionExecutionIssue } from "../src/intent/validation.js";
import { transformDataIntent } from "../src/data/transform.js";
import { sceneCorpus } from "../src/scenes/index.js";
import { groundedNumber } from "../src/scenes/grounding.js";
import { emptyContext } from "./helpers.js";
import { incompleteCanvasIssue } from "../src/intent/contextSafety.js";
import { CredentialStore } from "../src/credentials.js";
import { runIntent } from "../src/intent/pipeline.js";
describe("summarized context cannot overwrite or derive partial data", () => {
  const card = { id: "table", type: "TableCard", layout: { x: 0, y: 0 }, displayProps: { columns: ["名称", "数值"], rows: [["a", 999]] }, sourceDataSummary: { provenance: "user-input" }, contextSummary: { truncatedFields: ["rows"] } };
  it("allows target resolution but rejects writes to truncated fields", () => {
    expect(actionExecutionIssue([{ type: "card.focus", targetId: "table" }], emptyContext([card]))).toBeNull();
    expect(actionExecutionIssue([{ type: "card.update", targetId: "table", displayProps: { rows: [["a", 1]] } }], emptyContext([card]))).toContain("摘要");
  });
  it("rejects partial table/chart conversions and removes summaries from grounding", () => {
    expect(transformDataIntent("把这张表格转成柱状图", emptyContext([card]))).toMatchObject({ kind: "clarify", message: expect.stringContaining("摘要") });
    const { corpus } = sceneCorpus({ text: "做趋势图", ctx: emptyContext([card]) });
    expect(groundedNumber(corpus, 999)).toBe(false);
  });
  const partial = { ...emptyContext(Array.from({ length: 64 }, (_, i) => ({ ...card, id: `card-${i}`, aliases: [`个人计划${i}`] }))), totalCardCount: 80, focusHistory: ["card-0"] };
  it.each(["删除第1张表格", "把左边的表格转成柱状图", "删除所有卡片", "修改全部便笺", "删除表格"])("does not reinterpret subset scope: %s", async text => {
    const result = await runIntent({ text, canvasContext: partial }, { credentials: new CredentialStore(), stepfun: { baseUrl: "https://unused.test" } });
    expect(result.kind).toBe("clarify");
    expect(result.envelope).toBeUndefined();
  });
  it("still permits named/focused selected targets and global camera commands", () => {
    for (const text of ["删除个人计划0", "聚焦card-0", "把当前聚焦的表格转成柱状图", "显示全部", "恢复原视图", "创建待办清单：修改文档、更新依赖"]) expect(incompleteCanvasIssue(text, partial)).toBeNull();
    expect(incompleteCanvasIssue("删除第1张表格", { ...partial, totalCardCount: 64 })).toBeNull();
  });
  it("carries incomplete-scope safety across clarification turns until the user names a selected target", async () => {
    const deps = { credentials: new CredentialStore(), stepfun: { baseUrl: "https://unused.test" },
      planner: { provider: "gpt" as const, connected: true, isCurrent: () => true,
        generate: async () => ({ ok: true as const, value: { actions: [{ type: "card.focus", targetId: "card-0" }] } }) } };
    const continuation = { utterance: "聚焦第1张表格", question: "哪张表格？" };
    const ambiguous = await runIntent({ text: "就是那张", canvasContext: partial, continuation }, deps);
    expect(ambiguous.kind).toBe("clarify"); expect(ambiguous.envelope).toBeUndefined();
    const named = await runIntent({ text: "是个人计划0", canvasContext: partial, continuation }, deps);
    expect(named.kind).toBe("envelope");
    expect(named.envelope?.actions).toEqual([{ type: "card.focus", targetId: "card-0" }]);
  });
});
