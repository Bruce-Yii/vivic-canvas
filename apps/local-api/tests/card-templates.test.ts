import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ActionEnvelopeSchema, ActionSchema, SCENE_CARD_TYPE, type Action, type CardRecord } from "@vivic/contracts";
import { CARD_CONTRACTS } from "../src/cards/index.js";
import { CARD_TEMPLATES, buildTemplateActions, getCardTemplate } from "../src/cards/templates.js";
import type { CanvasContext } from "../src/schemas.js";
import { emptyContext } from "./helpers.js";

const now = Date.parse("2026-10-29T02:00:00.000Z");

const context = (cards: CanvasContext["cards"] = [], stage: CanvasContext["stage"] = "WORKSPACE"): CanvasContext =>
  ({ ...emptyContext(cards), stage, timeZone: "Asia/Shanghai" });

const build = (id: string, fields: unknown, ctx: CanvasContext = context()) => buildTemplateActions(id, fields, ctx, now);
const buildLegacy = (id: string, fields: unknown, ctx: CanvasContext = context()) =>
  buildTemplateActions(id, fields, ctx, now, { sections: false });

const created = (actions: Action[]): CardRecord[] =>
  actions.filter((action): action is Extract<Action, { type: "card.create" }> => action.type === "card.create").map(action => action.card);

/** displayProps is a per-card-type union; the assertions below read scene fields. */
const propsOf = (card: CardRecord): Record<string, unknown> => card.displayProps as Record<string, unknown>;
const sourceOf = (card: CardRecord): Record<string, unknown> => card.sourceData as Record<string, unknown>;

const samples: Record<string, Record<string, unknown>> = {
  meeting_minutes: {
    title: "Q4 预算复盘",
    attendees: ["王敏", "李想"],
    topics: ["预算超支原因"],
    decisions: ["先削减外包"],
    actions: ["周五前给出新预算"],
  },
  weekly_report: { title: "W44 周报", done: ["完成模板调研"], next: ["接入工具层"] },
  project_plan: {
    title: "模板系统",
    phases: [
      { name: "契约梳理", period: "第1周", goal: "确认可用通道" },
      { name: "模板落地", milestones: ["8 个模板可用"] },
    ],
  },
  todo_checklist: { title: "本周待办", items: ["整理会议纪要", "发出周报"] },
  decision_record: {
    topic: "模板存放在哪",
    options: ["代码常量", "数据库"],
    decision: "先用代码常量",
    reasons: ["改动最小"],
  },
  retrospective: { topic: "模板试点", wentWell: ["选型准确"], toImprove: ["字段过细"], next: ["合并同义字段"] },
  reading_note: {
    title: "卡片笔记写作法",
    author: "申克·阿伦斯",
    currentPage: 120,
    totalPages: 300,
    notes: ["先把想法写成卡片"],
  },
  comparison_table: {
    title: "两种存储方案",
    options: ["代码常量", "数据库"],
    criteria: [
      { name: "改动量", values: ["小", "大"], better: "lower" },
      { name: "可配置", values: ["否", "是"], better: "higher" },
    ],
    chosen: "代码常量",
  },
};

/** The renderer registry is the ground truth for "this CardType exists"; a
 * template must never name a type the web app cannot render. */
const REGISTRY_SOURCE = readFileSync(new URL("../../web/src/cards/registry.tsx", import.meta.url), "utf8");
const RENDERED_CARD_TYPES = new Set([...REGISTRY_SOURCE.matchAll(/^\s*([A-Za-z]+Card):/gm)].map(match => match[1]!));

describe("office card templates are data over real creation channels", () => {
  it("ships 8 templates whose declared card type is what their channel really builds", () => {
    expect(CARD_TEMPLATES).toHaveLength(8);
    expect(new Set(CARD_TEMPLATES.map(template => template.id)).size).toBe(8);
    // Sanity check on the registry the existence test below relies on.
    expect(RENDERED_CARD_TYPES.size).toBe(27);
    for (const template of CARD_TEMPLATES) {
      expect(template.description.length, template.id).toBeGreaterThan(0);
      expect(template.examples.length, template.id).toBeGreaterThan(0);
      expect(template.skeleton.length, template.id).toBeGreaterThan(0);
      expect(RENDERED_CARD_TYPES.has(template.cardType), template.id).toBe(true);
      const channelCardType = template.channel.kind === "contract"
        ? CARD_CONTRACTS[template.channel.contract]?.cardType
        : SCENE_CARD_TYPE[template.channel.scene];
      expect(channelCardType, template.id).toBe(template.cardType);
      // Every template has at least one required field, so an empty object is never a card.
      expect(template.fields.safeParse({}).success, template.id).toBe(false);
    }
  });

  it("only resolves declared template ids, never inherited object keys", () => {
    expect(getCardTemplate("meeting_minutes")?.name).toBe("会议纪要");
    for (const id of ["missing", "toString", "constructor", "__proto__"]) expect(getCardTemplate(id)).toBeUndefined();
  });

  it.each(Object.keys(samples))("builds %s into exactly one schema-valid card of its declared type", id => {
    const template = getCardTemplate(id)!;
    const result = build(id, samples[id]);
    expect(result.ok, result.ok ? "" : result.issue).toBe(true);
    if (!result.ok) return;
    expect(result.templateId).toBe(id);
    expect(result.cardType).toBe(template.cardType);
    const cards = created(result.actions);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.type).toBe(template.cardType);
    expect(RENDERED_CARD_TYPES.has(cards[0]!.type)).toBe(true);
    expect(cards[0]!.metadata.createdAt).toBe(new Date(now).toISOString());
    expect(cards[0]!.metadata.updatedAt).toBe(new Date(now).toISOString());
    // 归因字段：用于后续按模板统计使用率与改卡率。
    expect(sourceOf(cards[0]!).template).toBe(id);
    expect(result.actions.at(-1)).toEqual({ type: "card.focus", targetId: cards[0]!.id });
    for (const action of result.actions) {
      expect(ActionSchema.safeParse(action).success, JSON.stringify(action)).toBe(true);
    }
    const envelope = ActionEnvelopeSchema.safeParse({
      schemaVersion: "0.6", requestId: `template_${id}`, canvasId: context().canvasId, actions: result.actions,
    });
    expect(envelope.success, envelope.success ? "" : JSON.stringify(envelope.error.issues)).toBe(true);
  });

  it("uses a different card id per build", () => {
    const first = build("todo_checklist", samples.todo_checklist);
    const second = build("todo_checklist", samples.todo_checklist);
    if (!first.ok || !second.ok) throw new Error("expected two builds");
    expect(created(first.actions)[0]!.id).not.toBe(created(second.actions)[0]!.id);
  });
});

describe("missing and unknown fields fail with an explicit issue", () => {
  it.each(CARD_TEMPLATES.map(template => template.id))("names missing required fields for %s", id => {
    const result = build(id, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issue).toContain("缺少必填字段");
    expect(result.issue).toContain(getCardTemplate(id)!.name);
  });

  it("names the exact field that is missing", () => {
    const result = build("project_plan", { title: "模板系统" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue).toContain("phases");
    const noTopic = build("decision_record", { options: ["A", "B"], decision: "用 A" });
    expect(noTopic.ok).toBe(false);
    if (!noTopic.ok) expect(noTopic.issue).toContain("topic");
  });

  it("refuses unknown template ids, non-object fields and injected record fields", () => {
    const unknown = build("standup_notes", {});
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.issue).toContain("未知模板");

    const notObject = build("meeting_minutes", ["预算复盘"]);
    expect(notObject.ok).toBe(false);
    if (!notObject.ok) expect(notObject.issue).toContain("fields 必须是对象");

    const injected = build("meeting_minutes", { topics: ["预算复盘"], cardId: "TEST-card", displayProps: {}, layout: {} });
    expect(injected.ok).toBe(false);
    if (!injected.ok) expect(injected.issue).toContain("未登记的字段");
  });

  it("refuses oversized note content instead of truncating it", () => {
    // Eight 40-character attendees joined into one line pass the field schema
    // but exceed the 180-character section line; the host must reject, not cut.
    const tooLongLine = build("meeting_minutes", {
      topics: ["预算复盘"], attendees: Array.from({ length: 8 }, () => "参".repeat(40)),
    });
    expect(tooLongLine.ok).toBe(false);
    if (!tooLongLine.ok) expect(tooLongLine.issue).toContain("180 字");

    const sectionOverflow = build("retrospective", {
      topic: "试点", wentWell: ["选型准确"], toImprove: ["字段过细"], next: ["合并同义字段"],
      extra: "not-a-field",
    });
    expect(sectionOverflow.ok).toBe(false);
    if (!sectionOverflow.ok) expect(sectionOverflow.issue).toContain("未登记的字段");
  });
});

describe("templates do not invent facts and keep the scene checks", () => {
  it("writes only the fields the model supplied", () => {
    const minutes = build("meeting_minutes", { topics: ["预算复盘"] });
    if (!minutes.ok) throw new Error(minutes.issue);
    expect(created(minutes.actions)[0]!.displayProps).toEqual({
      sections: [{ title: "议题", items: ["预算复盘"] }],
    });

    const todo = build("todo_checklist", { items: ["发出周报"] });
    if (!todo.ok) throw new Error(todo.issue);
    expect(created(todo.actions)[0]!.displayProps).toEqual({ items: [{ id: "item-1", text: "发出周报", done: false }] });

    const comparison = build("comparison_table", {
      title: "两种存储方案", options: ["代码常量", "数据库"], criteria: [{ name: "改动量", values: ["小", "大"] }],
    });
    if (!comparison.ok) throw new Error(comparison.issue);
    expect(propsOf(created(comparison.actions)[0]!).chosenId).toBeUndefined();
  });

  it("lays meeting minutes and retrospectives out as labeled sections", () => {
    const minutes = build("meeting_minutes", samples.meeting_minutes);
    if (!minutes.ok) throw new Error(minutes.issue);
    const minutesCard = created(minutes.actions)[0]!;
    expect(minutesCard.displayProps).toEqual({
      sections: [
        { title: "会议", items: ["Q4 预算复盘", "参会：王敏、李想"] },
        { title: "议题", items: ["预算超支原因"] },
        { title: "结论", items: ["先削减外包"] },
        { title: "待办", items: ["周五前给出新预算"] },
      ],
    });
    // Sections replace the old flat bullet list; they never coexist with it.
    expect(propsOf(minutesCard).text).toBeUndefined();
    expect(propsOf(minutesCard).bullets).toBeUndefined();
    expect(minutesCard.variant).toBe("standard");
    expect(minutesCard.layout.width).toBe(340);
    expect(minutesCard.layout.height).toBeGreaterThanOrEqual(220);

    const retro = build("retrospective", samples.retrospective);
    if (!retro.ok) throw new Error(retro.issue);
    expect(created(retro.actions)[0]!.displayProps).toEqual({
      sections: [
        { title: "复盘", items: ["模板试点"] },
        { title: "做得好", items: ["选型准确"] },
        { title: "待改进", items: ["字段过细"] },
        { title: "下一步", items: ["合并同义字段"] },
      ],
    });
  });

  it("lays the decision record out as 决策/背景/选项/理由 sections", () => {
    const result = build("decision_record", {
      topic: "模板存放在哪",
      background: "模板要与代码一起评审",
      options: ["代码常量", "数据库"],
      decision: "先用代码常量",
      reasons: ["改动最小", "不用迁移"],
    });
    if (!result.ok) throw new Error(result.issue);
    const card = created(result.actions)[0]!;
    expect(card.type).toBe("NoteCard");
    expect(card.displayProps).toEqual({
      sections: [
        { title: "决策", items: ["模板存放在哪", "决定：先用代码常量"] },
        { title: "背景", items: ["模板要与代码一起评审"] },
        { title: "选项", items: ["代码常量", "数据库"] },
        { title: "理由", items: ["改动最小", "不用迁移"] },
      ],
    });
    const sections = propsOf(card).sections as Array<{ title: string; items: string[] }>;
    expect(sections.map(section => section.title)).toEqual(["决策", "背景", "选项", "理由"]);
    // 每个备选方案单独成条，不再被 join 成「选项：A；B」一行。
    expect(sections.find(section => section.title === "选项")!.items).toEqual(["代码常量", "数据库"]);
    // 4 区便笺必须是 standard：minimal 320×120 只有 78px 可视高度（≈2.8 行）。
    expect(card.variant).toBe("standard");
    expect(card.layout.width).toBe(340);
    expect(card.layout.height).toBeGreaterThanOrEqual(220);
    expect(propsOf(card).text).toBeUndefined();
    expect(propsOf(card).bullets).toBeUndefined();
  });

  it("omits decision sections the user did not give", () => {
    const result = build("decision_record", { topic: "模板存放在哪", options: ["代码常量", "数据库"], decision: "先用代码常量" });
    if (!result.ok) throw new Error(result.issue);
    const sections = propsOf(created(result.actions)[0]!).sections as Array<{ title: string; items: string[] }>;
    expect(sections.map(section => section.title)).toEqual(["决策", "选项"]);
    expect(sections[0]!.items).toEqual(["模板存放在哪", "决定：先用代码常量"]);
    // 仍然没有一条被 join 的「选项：…」行。
    expect(sections[1]!.items).toEqual(["代码常量", "数据库"]);
  });

  it("keeps every section line exactly as supplied, without joining or truncating", () => {
    const topic = "长".repeat(160);
    const result = build("meeting_minutes", { topics: [topic] });
    if (!result.ok) throw new Error(result.issue);
    const sections = propsOf(created(result.actions)[0]!).sections as Array<{ title: string; items: string[] }>;
    expect(sections).toEqual([{ title: "议题", items: [topic] }]);
    expect(sections[0]!.items[0]).toBe(topic);
  });


  it("splits the weekly report into 本周完成 / 下周计划 groups on one TodoCard", () => {
    const result = build("weekly_report", { done: ["模板调研", "接口对齐"], next: ["接入工具层"] });
    if (!result.ok) throw new Error(result.issue);
    const card = created(result.actions)[0]!;
    expect(card.type).toBe("TodoCard");
    expect(card.displayProps).toEqual({
      title: "周报",
      items: [
        { id: "item-1", text: "本周完成：模板调研", done: true },
        { id: "item-2", text: "本周完成：接口对齐", done: true },
        { id: "item-3", text: "下周计划：接入工具层", done: false },
      ],
    });
    // 分组只落在条目文字上：完成组全部勾选，计划组只是一条待开始的事项，
    // 不能因为「下一周要做」就被读成这周没做完的事。
    const items = propsOf(card).items as Array<{ text: string; done: boolean }>;
    expect(items.filter(item => item.text.startsWith("本周完成：")).every(item => item.done)).toBe(true);
    expect(items.filter(item => item.text.startsWith("下周计划：")).every(item => !item.done)).toBe(true);
    expect(items.filter(item => item.text.startsWith("下周计划："))).toHaveLength(1);

    // 没有 next 时不凭空补一个「下周计划」组。
    const doneOnly = build("weekly_report", { done: ["模板调研"] });
    if (!doneOnly.ok) throw new Error(doneOnly.issue);
    expect(propsOf(created(doneOnly.actions)[0]!).items).toEqual([
      { id: "item-1", text: "本周完成：模板调研", done: true },
    ]);
  });

  it("refuses a weekly item that overflows the todo line once prefixed", () => {
    // 160 字刚好通过字段校验，加上「本周完成：」前缀就超过待办卡 160 字上限；
    // 这里必须拒绝而不是截断用户原文。
    const result = build("weekly_report", { done: ["完成".repeat(80)] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue).toContain("160 字");
  });

  it("leaves roadmap progress at its stated state and invents no milestones", () => {
    const result = build("project_plan", { title: "模板系统", phases: [{ name: "契约梳理", status: "done" }, { name: "模板落地" }] });
    if (!result.ok) throw new Error(result.issue);
    const phases = propsOf(created(result.actions)[0]!).phases as Array<Record<string, unknown>>;
    expect(phases.map(phase => phase.status)).toEqual(["done", "planned"]);
    expect(phases.every(phase => Array.isArray(phase.milestones) && (phase.milestones as unknown[]).length === 0)).toBe(true);
  });

  it("keeps the real scene checks for the comparison table", () => {
    const mismatched = build("comparison_table", {
      title: "三种存储", options: ["常量", "数据库", "配置文件"], criteria: [{ name: "改动量", values: ["小", "中"] }],
    });
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) {
      expect(mismatched.issue).toContain("改动量");
      expect(mismatched.issue).toContain("3 个");
    }
    const duplicate = build("comparison_table", {
      title: "重复方案", options: ["常量", "常量"], criteria: [{ name: "改动量", values: ["小", "大"] }],
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.issue).toContain("重复");
    const strayChoice = build("comparison_table", {
      title: "存储", options: ["常量", "数据库"], criteria: [{ name: "改动量", values: ["小", "大"] }], chosen: "文件",
    });
    expect(strayChoice.ok).toBe(false);
    if (!strayChoice.ok) expect(strayChoice.issue).toContain("chosen");
  });

  it("refuses a reading page beyond the total page count", () => {
    const result = build("reading_note", { title: "卡片笔记写作法", notes: ["先写卡片"], currentPage: 400, totalPages: 300 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue).toContain("currentPage");
  });
});

describe("template cards join the canvas like every other creation path", () => {
  it.each(["project_plan", "todo_checklist"])("places %s clear of existing cards and never moves them", id => {
    const ctx = context([{ id: "TEST-pinned", type: "NoteCard", displayProps: { text: "TEST fixed" }, sourceDataSummary: {},
      layout: { x: 0, y: 0, width: 900, height: 700, pinned: true } }]);
    const before = structuredClone(ctx);
    const result = build(id, samples[id], ctx);
    if (!result.ok) throw new Error(result.issue);
    const card = created(result.actions)[0]!;
    expect(card.layout.pinned).toBe(false);
    expect(card.layout.x).toBeGreaterThanOrEqual(900);
    expect(card.layout.y).toBe(0);
    expect(ctx).toEqual(before);
  });

  it("awakens a standby canvas exactly once", () => {
    const result = build("todo_checklist", samples.todo_checklist, context([], "STANDBY"));
    if (!result.ok) throw new Error(result.issue);
    expect(result.actions.filter(action => action.type === "stage.awaken")).toHaveLength(1);
    expect(result.actions[0]).toEqual({ type: "stage.awaken" });
    expect(ActionEnvelopeSchema.safeParse({ schemaVersion: "0.6", requestId: "template_standby",
      canvasId: context().canvasId, actions: result.actions }).success).toBe(true);
  });
});

describe("sections compatibility fallback", () => {
  it("flattens sections to text when the frontend contract does not support sections", () => {
    const result = buildLegacy("meeting_minutes", samples.meeting_minutes);
    if (!result.ok) throw new Error(result.issue);
    const card = created(result.actions)[0]!;
    const props = propsOf(card);
    expect(props.sections).toBeUndefined();
    expect(String(props.text)).toContain("议题");
    expect(String(props.text)).toContain("结论");
  });
});
