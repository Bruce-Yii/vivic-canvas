import { describe, expect, it } from "vitest";
import { ActionEnvelopeSchema, ActionSchema, type Action } from "@vivic/contracts";
import { applyOutputChannels, normalizeOutputChannels } from "../src/intent/channels.js";

describe("normalizeOutputChannels", () => {
  it("keeps Chinese speech and visual details in separate channels", () => {
    expect(normalizeOutputChannels({ say: " 已查到联系方式。 ", text: " 电话：12345678901，详情：https://example.test/info " }))
      .toEqual({ say: "已查到联系方式。", text: "电话：12345678901，详情：https://example.test/info" });
  });

  it.each([
    "详情见 http://example.test",
    "详情通过HTTP查看",
    "详情见 HTTPS://example.test",
    "请拨打12345678901",
    "编号123456",
    "编号１２３４５６",
    "编号𝟙𝟚𝟛𝟜𝟝𝟞",
    "• 第一项",
    "内容 · 第一项",
    "- 第一项",
    "*第一项",
    "+ 第一项",
    "1. 第一项",
    "1、第一项",
    "1) 第一项",
    "（一）第一项",
    "一、第一项",
    "① 第一项",
    "第一行\n- 第二行",
  ])("replaces unsafe speech %s with a safe subtitle sentence", say => {
    const text = "详情已显示。电话：12345678901；链接：https://example.test";
    expect(normalizeOutputChannels({ say, text })).toEqual({ say: "详情已显示。", text });
  });

  it.each([
    "https://example.test",
    "电话：12345678901。",
    "- 第一项\n- 第二项",
    "1. 第一项\n2. 第二项",
  ])("keeps unsafe fallback %s visible without speaking it", text => {
    expect(normalizeOutputChannels({ say: "http://unsafe.test", text })).toEqual({ text });
  });

  it.each(["完成。", "完成！", "完成？", "Done.", "Done!", "Done?", "完成\n"])(
    "uses only the first subtitle sentence ending in %s", firstSentence => {
      const text = `${firstSentence}电话：12345678901`;
      expect(normalizeOutputChannels({ say: null, text })).toEqual({ say: firstSentence.trim(), text });
    },
  );

  it("does not mistake a decimal point for a sentence boundary", () => {
    expect(normalizeOutputChannels({ text: "温度为3.5度。电话：12345678901" }).say).toBe("温度为3.5度。");
  });

  it.each([undefined, null, 123, {}, [], "", "   "])("uses fallbackText when text is %j", text => {
    expect(normalizeOutputChannels({ say: false, text }, " 已显示详情。网址：https://example.test "))
      .toEqual({ say: "已显示详情。", text: "已显示详情。网址：https://example.test" });
  });

  it("prefers supplied text and never manufactures subtitles from say", () => {
    expect(normalizeOutputChannels({ text: "首选字幕。" }, "备用字幕。")).toEqual({ say: "首选字幕。", text: "首选字幕。" });
    expect(normalizeOutputChannels({ say: "已完成。" })).toEqual({ say: "已完成。" });
  });

  it("revalidates fallbackText before allowing speech", () => {
    expect(normalizeOutputChannels({}, "电话：12345678901")).toEqual({ text: "电话：12345678901" });
  });

  it("accepts 40 units of speech and replaces longer speech", () => {
    const say = "好".repeat(40);
    expect(normalizeOutputChannels({ say })).toEqual({ say });
    expect(normalizeOutputChannels({ say: `${say}好`, text: "简短提示。" }))
      .toEqual({ say: "简短提示。", text: "简短提示。" });
    expect(normalizeOutputChannels({ say: `${say}好` })).toEqual({});
  });

  it("allows short numbers and truncates a long safe fallback sentence", () => {
    expect(normalizeOutputChannels({ say: "还有12345秒" })).toEqual({ say: "还有12345秒" });
    const text = "好".repeat(121);
    expect(normalizeOutputChannels({ text })).toEqual({ say: "好".repeat(40), text: "好".repeat(120) });
  });

  it("does not split surrogate pairs at the subtitle limit", () => {
    const prefix = "好".repeat(119);
    const result = normalizeOutputChannels({ say: "已完成。", text: `${prefix}😀详情` });
    expect(result.text).toBe(prefix);
    expect(normalizeOutputChannels({ text: `${"好".repeat(118)}😀详情` }).text).toBe(`${"好".repeat(118)}😀`);
    expect(normalizeOutputChannels({ text: "😀".repeat(61) }).text).toBe("😀".repeat(60));
    expect(ActionSchema.safeParse({ type: "subtitle.show", text: result.text }).success).toBe(true);
  });

  it("does not split surrogate pairs when shortening fallback speech", () => {
    expect(normalizeOutputChannels({ text: `${"好".repeat(39)}😀详情` }).say).toBe("好".repeat(39));
    expect(normalizeOutputChannels({ text: `${"好".repeat(38)}😀详情` }).say).toBe(`${"好".repeat(38)}😀`);
    expect(normalizeOutputChannels({ say: "😀".repeat(20) }).say).toBe("😀".repeat(20));
    expect(normalizeOutputChannels({ say: "😀".repeat(21) })).toEqual({});
  });

  it("returns no channels for absent or invalid content", () => {
    expect(normalizeOutputChannels({})).toEqual({});
    expect(normalizeOutputChannels({ say: 42, text: { message: "not a string" } })).toEqual({});
    expect(normalizeOutputChannels({ say: "  ", text: "\n" }, "\t")).toEqual({});
  });
});

describe("applyOutputChannels", () => {
  const createCard: Action = {
    type: "card.create",
    card: {
      id: "existing-note",
      type: "NoteCard",
      variant: "standard",
      displayProps: { text: "用户的原卡片" },
      sourceData: {},
      sources: [],
      layout: { x: 100, y: 200, width: 320, height: 200, pinned: true },
      metadata: { createdAt: "2026-10-29T00:00:00.000Z", updatedAt: "2026-10-29T00:00:00.000Z" },
    },
  };

  it("replaces every old subtitle with one text subtitle and preserves card actions", () => {
    const actions: Action[] = [
      { type: "stage.awaken" },
      { type: "subtitle.show", text: "旧字幕", durationMs: 300 },
      createCard,
      { type: "card.update", targetId: "existing-note", displayProps: { text: "更新" } },
      { type: "subtitle.show", text: "重复旧字幕", priority: "reminder" },
      { type: "card.focus", targetId: "existing-note" },
    ];
    const original = structuredClone(actions);
    const result = applyOutputChannels(actions, { say: "详情已显示。", text: "电话：12345678901；https://example.test" });

    expect(result).toEqual({
      actions: [actions[0], createCard, actions[3], actions[5], { type: "subtitle.show", text: "电话：12345678901；https://example.test" }],
      spokenText: "详情已显示。",
    });
    expect(result.actions[1]).toBe(createCard);
    expect(actions).toEqual(original);
    expect(ActionEnvelopeSchema.safeParse({ schemaVersion: "0.6", requestId: "channels-test", canvasId: "test-canvas", ...result }).success).toBe(true);
  });

  it("does not use say as a subtitle or infer speech from text", () => {
    expect(applyOutputChannels([], { say: "已完成。" })).toEqual({ actions: [], spokenText: "已完成。" });
    expect(applyOutputChannels([], { text: "请查看字幕。" })).toEqual({ actions: [{ type: "subtitle.show", text: "请查看字幕。" }] });
  });

  it.each(["http://unsafe.test", "电话123456", "• 第一项", "好".repeat(41)])(
    "never exposes unsafe say %s as spokenText", say => {
      expect(applyOutputChannels([createCard], { say, text: "可见信息。" }))
        .toEqual({ actions: [createCard, { type: "subtitle.show", text: "可见信息。" }] });
    },
  );

  it("bounds subtitle text without breaking Unicode even for unnormalized channels", () => {
    const result = applyOutputChannels([], { say: " 已完成。 ", text: `${"好".repeat(119)}😀详情` });
    expect(result).toEqual({ actions: [{ type: "subtitle.show", text: "好".repeat(119) }], spokenText: "已完成。" });
  });

  it("preserves subtitle.hide and other actions when channels are empty", () => {
    const actions: Action[] = [createCard, { type: "subtitle.hide" }, { type: "canvas.fit" }];
    expect(applyOutputChannels(actions, {})).toEqual({ actions });
  });

  it("removes stale subtitles without inventing content", () => {
    expect(applyOutputChannels([{ type: "subtitle.show", text: "旧字幕" }, createCard], {})).toEqual({ actions: [createCard] });
    expect(applyOutputChannels([], { say: " ", text: "\n" })).toEqual({ actions: [] });
  });

  it("is idempotent when applying the same channels twice", () => {
    const channels = normalizeOutputChannels({ say: "已完成。", text: "请查看已有卡片。" });
    const result = applyOutputChannels([createCard], channels);
    expect(applyOutputChannels(result.actions, channels)).toEqual(result);
  });
});
