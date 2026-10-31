// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { consumeTemplateDraft, prepareTemplateDraft, readTemplateDraft } from "../draftTransfer";
afterEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });
describe("launcher task templates stay drafts", () => {
  it("survives repeat reads and only consumes the same draft", () => {
    prepareTemplateDraft("日程冲突检查：我会补充日程资料");
    expect(readTemplateDraft()).toBe("日程冲突检查：我会补充日程资料");
    expect(readTemplateDraft()).toBe("日程冲突检查：我会补充日程资料");
    consumeTemplateDraft("不同的草稿"); expect(readTemplateDraft()).not.toBe("");
    consumeTemplateDraft("日程冲突检查：我会补充日程资料"); expect(readTemplateDraft()).toBe("");
  });
  it("rejects stale, malformed and future drafts and bounds text", () => {
    prepareTemplateDraft("字".repeat(3000)); expect(readTemplateDraft()).toHaveLength(2000);
    vi.spyOn(Date, "now").mockReturnValue(Date.now()+300001); expect(readTemplateDraft()).toBe("");
    sessionStorage.setItem("vivic.pending-template.v1", "{}"); expect(readTemplateDraft()).toBe("");
    sessionStorage.setItem("vivic.pending-template.v1", JSON.stringify({ text:"未来", at:Date.now()+10000 })); expect(readTemplateDraft()).toBe("");
  });
});
