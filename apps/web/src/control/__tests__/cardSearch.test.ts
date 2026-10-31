import { describe, expect, it } from "vitest";
import { cardMatches, cardSearchSummary, searchPreview } from "../cardSearch";
import { testCards } from "@/cards/__tests__/fixtures";

describe("current-card search text", () => {
  const note = { ...testCards.NoteCard, displayProps: { text: "上海发布会\n核对体验优化", bullets: ["下午整理阅读资料"] }, metadata: { ...testCards.NoteCard.metadata, aliases: ["工作记录"] } };
  it.each(["发布会", "shanghai", "shfbh", "ＴＥＳＴ", "xiawu", "工作记录"])("matches Chinese, pinyin, initials, aliases and normalized input: %s", query => {
    const card = query === "ＴＥＳＴ" ? testCards.NoteCard : note;
    expect(cardMatches(card, query)).toBe(true);
  });
  it("matches later todo items and reminder task text", () => {
    expect(cardMatches({ ...testCards.TodoCard, displayProps: { items: [{ id: "1", text: "买菜", done: false }, { id: "2", text: "整理资料", done: false }] } }, "zlzl")).toBe(true);
    expect(cardMatches({ ...testCards.CountdownCard, sourceData: { ...testCards.CountdownCard.sourceData, reminderText: "喝水" } }, "heshui")).toBe(true);
  });
  it("keeps empty query and rejects unrelated words", () => {
    expect(cardMatches(note, "  ")).toBe(true);
    expect(cardMatches(note, "不相关的内容xyz")).toBe(false);
    expect(cardSearchSummary(note)).toContain("下午整理阅读资料");
  });
  it("removes markdown notation only from result previews", () => {
    expect(searchPreview("## 标题\n**阅读** [来源](https://example.com) `代码`")).toBe("标题 阅读 来源 代码");
    expect(searchPreview("abcdef", 3)).toBe("abc");
    expect(note.displayProps.text).toContain("上海发布会");
  });
});
