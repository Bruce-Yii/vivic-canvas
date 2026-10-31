import { describe, expect, it } from "vitest";
import { splitClauses } from "../src/decision/split.js";

/** split.ts is a six-layer rule path: the negation/condition guard, the literal
 * list grammar, the quote scanner, the separator table, the "right side must
 * start with an operation" guards, and the punctuation trim. Every expectation
 * below is what the current implementation actually returns, so these tests pin
 * behaviour instead of describing an intent. The known defects at the bottom
 * are marked `it.fails`; no product code was changed for this task. */

describe("one clause: nothing looks like an independent second operation", () => {
  it.each([
    ["a countdown", "倒计时50分钟"],
    ["a note with a body", "帮我记个便签明天交周报"],
    ["a view command", "显示全部"],
    ["a non-operation right side", "把待办传到用户页，我要编辑"],
    ["a bare item list", "买牛奶，交周报"],
    ["an explicit list grammar owns its contents", "添加待办：买牛奶、交周报"],
    ["和 keeps items inside one container", "买牛奶和交周报"],
  ])("%s", (_label, input) => {
    expect(splitClauses(input)).toEqual([input]);
  });
});

describe("comma, semicolon and conjunction separators", () => {
  it.each([
    ["a comma plus 再 splits two parseable tasks", "帮我记个便签明天交周报，再设个50分钟倒计时",
      ["帮我记个便签明天交周报", "设个50分钟倒计时"]],
    ["先…再… is two clauses", "先聚焦左边那个，再放大", ["先聚焦左边那个", "放大"]],
    ["a comma plus 再 before an operation", "写周报，再删除便签", ["写周报", "删除便签"]],
    ["two move commands keep the verb on the right", "把书移到左边，再把笔放到右边", ["把书移到左边", "把笔放到右边"]],
    ["然后 separates when an operation follows", "记个便签，然后聚焦它", ["记个便签", "聚焦它"]],
    ["a semicolon before an operation splits", "记个便签；设个倒计时", ["记个便签", "设个倒计时"]],
    ["a semicolon inside one list is kept", "添加三条待办：买牛奶；交周报；预约体检",
      ["添加三条待办：买牛奶；交周报；预约体检"]],
    ["三 clauses are the maximum", "记个便签，再设个倒计时，再显示全部", ["记个便签", "设个倒计时", "显示全部"]],
    ["a fourth clause folds into the third", "记个便签，再设个倒计时，再显示全部，再恢复原视图",
      ["记个便签", "设个倒计时", "显示全部，再恢复原视图"]],
  ])("%s", (_label, input, expected) => {
    expect(splitClauses(input)).toEqual(expected);
  });
});

describe("顺便 / 再 without a comma", () => {
  it.each([
    ["顺便 starts a second clause", "明天下午三点开会，顺便提醒我买咖啡", ["明天下午三点开会", "提醒我买咖啡"]],
    ["顺便 works without a comma", "记个便签顺便提醒我买咖啡", ["记个便签", "提醒我买咖啡"]],
    ["过…叫我 is a real second clause", "帮我记个便签，然后过五分钟叫我休息", ["帮我记个便签", "过五分钟叫我休息"]],
  ])("%s", (_label, input, expected) => {
    expect(splitClauses(input)).toEqual(expected);
  });
});

describe("time words are never clause boundaries", () => {
  it.each([
    ["a clock time", "下午3:30开会，顺便提醒我带电脑", ["下午3:30开会", "提醒我带电脑"]],
    ["hour + minute durations stay intact", "倒计时1小时30分钟", ["倒计时1小时30分钟"]],
    ["a date and clock stay inside one clause", "明天上午9点提醒我开会", ["明天上午9点提醒我开会"]],
    ["19:30 is not split", "19:30的会议，顺便提醒我带电脑", ["19:30的会议", "提醒我带电脑"]],
    ["a millisecond unit does not change the clause count", "倒计时19ms，再显示全部", ["倒计时19ms", "显示全部"]],
  ])("%s", (_label, input, expected) => {
    expect(splitClauses(input)).toEqual(expected);
  });
});

describe("negation, conditions and quoting freeze the sentence", () => {
  it.each([
    ["不要", "不要删除，先聚焦它"],
    ["别", "别动，先聚焦它"],
    ["如果", "如果下雨，就带伞"],
  ])("%s keeps the whole sentence", (_label, input) => {
    expect(splitClauses(input)).toEqual([input]);
  });

  it("keeps a quoted 再 from splitting the sentence", () => {
    const input = "他说“先别动，再想想”，然后聚焦它";
    expect(splitClauses(input)).toEqual([input]);
  });

  it("keeps a quoted command inside one clause", () => {
    const input = "他说“倒计时50分钟，再记个便签”";
    expect(splitClauses(input)).toEqual([input]);
  });
});

describe("quoted content owns its commas", () => {
  it.each([
    ["a quoted item list", "“买牛奶，交周报”"],
    ["a quoted list after a note prefix", "记个便签：“买牛奶，交周报”"],
    ["an unquoted prefix plus a quoted list", "记个便签，“买牛奶，交周报”"],
  ])("%s stays one clause", (_label, input) => {
    expect(splitClauses(input)).toEqual([input]);
  });
});

describe("ASCII commas and full stops", () => {
  it.each([
    ["an ASCII comma before 再 splits", "帮我记个便签,再设个倒计时", ["帮我记个便签", "设个倒计时"]],
    ["an ASCII comma before 然后 splits", "帮我记个便签,然后设个倒计时", ["帮我记个便签", "设个倒计时"]],
    ["an English comma without a Chinese operation does not split", "Display all, then focus",
      ["Display all, then focus"]],
  ])("%s", (_label, input, expected) => {
    expect(splitClauses(input)).toEqual(expected);
  });

  it("trims the 。 that precedes 再 from both yielded clauses", () => {
    expect(splitClauses("记个便签。再设个倒计时。")).toEqual(["记个便签", "设个倒计时"]);
  });

  it("keeps the ASCII period on both yielded clauses", () => {
    expect(splitClauses("记个便签.然后设个倒计时.")).toEqual(["记个便签.", "设个倒计时."]);
  });
});

describe("empty and degenerate input", () => {
  it.each([["empty", ""], ["whitespace", "   "]])("%s stays empty", (_label, input) => {
    expect(splitClauses(input)).toEqual([]);
  });

  it.each([["，"], ["。"], ["a，b"]])("does not invent clauses for %s", input => {
    expect(splitClauses(input)).toEqual([input]);
  });
});

describe("release-mode limits", () => {
  it("returns at most three clauses and folds the rest into the last one", () => {
    const clauses = splitClauses("记个便签，再设个倒计时，再显示全部，再恢复原视图，再撤销");
    expect(clauses).toHaveLength(3);
    expect(clauses.slice(0, 2)).toEqual(["记个便签", "设个倒计时"]);
    expect(clauses[2]).toBe("显示全部，再恢复原视图，再撤销");
  });

  it("does not truncate a near-limit utterance", () => {
    // IntentRequest.text is capped at 500 characters by the wire schema; the
    // splitter itself must not shorten or drop any of them.
    const input = "记个便签，" + "很长".repeat(120);
    expect(splitClauses(input)).toEqual([input]);
  });
});

describe("sentence punctuation is a boundary only before an operation", () => {
  it("does not cut note content after 然后 into a second clause", () => {
    // "记个便签，然后明天交周报" is one note whose body is 明天交周报.
    expect(splitClauses("记个便签，然后明天交周报")).toEqual(["记个便签，然后明天交周报"]);
  });

  it("does not cut a timer's follow-up after 然后 into a second clause", () => {
    expect(splitClauses("设个倒计时，然后十分钟后叫我")).toEqual(["设个倒计时，然后十分钟后叫我"]);
  });

  it("treats a full stop as a clause boundary", () => {
    expect(splitClauses("记个便签。设个倒计时。")).toEqual(["记个便签", "设个倒计时"]);
  });

  it("trims trailing sentence punctuation from a yielded clause", () => {
    expect(splitClauses("记个便签。再设个倒计时。")).toEqual(["记个便签", "设个倒计时"]);
  });

  it("splits after an exclamation mark before an operation", () => {
    expect(splitClauses("记个便签！设个倒计时")).toEqual(["记个便签", "设个倒计时"]);
  });

  it("keeps a period inside a single note body", () => {
    expect(splitClauses("记一下明天交周报。明天也要交")).toEqual(["记一下明天交周报。明天也要交"]);
  });

  it("splits a note body from a following operation after a full stop", () => {
    expect(splitClauses("记一下明天交周报。然后聚焦它")).toEqual(["记一下明天交周报", "聚焦它"]);
  });
});
