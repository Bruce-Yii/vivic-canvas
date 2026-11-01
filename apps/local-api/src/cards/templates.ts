import { z } from "zod";
import { ActionSchema, CardRecordSchema, type Action, type CardType, type SceneId } from "@vivic/contracts";
import type { CanvasContext } from "../schemas.js";
import { CARD_CONTRACTS } from "./index.js";
import { newCardLayout } from "./build.js";
import type { CardBuildContext } from "./types.js";
import { buildSceneActions } from "../scenes/index.js";

/**
 * Office card templates are DATA, not a new rule layer and not a new CardType.
 *
 * A template is `template_id + target CardType + required/optional fields +
 * example utterances + the host channel that really builds the card`. The
 * model only picks a template id and fills business fields; every card is
 * still built by an existing host channel (a card contract such as note/todo,
 * or a scene builder such as project_roadmap/option_comparison). CardRecordSchema,
 * ActionSchema and ActionEnvelopeSchema therefore keep their guarantees, and
 * this module can never emit a card type the renderer does not know.
 *
 * Nothing here talks to a model, a network or a database.
 */

/** The only two creation channels that exist today; both are shipped code. */
export type TemplateChannel =
  | { readonly kind: "contract"; readonly contract: keyof typeof CARD_CONTRACTS }
  | { readonly kind: "scene"; readonly scene: SceneId };

export interface CardTemplate {
  readonly id: string;
  readonly name: string;
  /** Must equal what the channel really builds; checked in buildTemplateActions. */
  readonly cardType: CardType;
  readonly description: string;
  /** Model fields. A strict object: unknown keys are rejected, optional keys are the optional fields. */
  readonly fields: z.ZodType;
  /** Presentation labels only (never user facts), merged under the model's fields. */
  readonly defaults?: Readonly<Record<string, unknown>>;
  readonly examples: string[];
  /** Section labels the template produces, for UI previews; not part of the card. */
  readonly skeleton: readonly string[];
  readonly channel: TemplateChannel;
}

const text = (max: number) => z.string().trim().min(1).max(max);

// ------------------------------------------------------------------ field schemas

const MeetingMinutesFields = z.strictObject({
  title: text(60).optional(),
  attendees: z.array(text(40)).min(1).max(8).optional(),
  topics: z.array(text(160)).min(1).max(4),
  decisions: z.array(text(160)).max(4).optional(),
  actions: z.array(text(160)).max(4).optional(),
});

const WeeklyReportFields = z.strictObject({
  title: text(80).optional(),
  /** 本周完成，勾选状态由宿主按 done=true 生成。 */
  done: z.array(text(160)).min(1).max(30),
  next: z.array(text(160)).max(30).optional(),
});

const ProjectPhaseFields = z.strictObject({
  name: text(60),
  period: text(40).optional(),
  status: z.enum(["planned", "active", "done"]).optional(),
  goal: text(160).optional(),
  milestones: z.array(text(120)).max(10).optional(),
});

const ProjectPlanFields = z.strictObject({
  title: text(80),
  phases: z.array(ProjectPhaseFields).min(1).max(8),
});

const TodoChecklistFields = z.strictObject({
  title: text(80).optional(),
  items: z.array(text(160)).min(1).max(30),
});

const DecisionRecordFields = z.strictObject({
  topic: text(60),
  background: text(160).optional(),
  options: z.array(text(120)).min(2).max(4),
  decision: text(160),
  reasons: z.array(text(120)).min(1).max(2).optional(),
});

const RetrospectiveFields = z.strictObject({
  topic: text(60),
  wentWell: z.array(text(120)).min(1).max(3),
  toImprove: z.array(text(120)).min(1).max(3),
  next: z.array(text(120)).min(1).max(3),
});

const ReadingNoteFields = z.strictObject({
  title: text(160),
  author: text(80).optional(),
  status: z.enum(["want", "reading", "paused", "finished"]).optional(),
  currentPage: z.int().min(0).max(100_000).optional(),
  totalPages: z.int().min(1).max(100_000).optional(),
  rating: z.int().min(1).max(5).optional(),
  notes: z.array(text(200)).min(1).max(8),
});

const ComparisonRowFields = z.strictObject({
  name: text(40),
  values: z.array(z.union([text(80), z.number().finite(), z.null()])).min(2).max(5),
  better: z.enum(["higher", "lower"]).optional(),
  unit: text(12).optional(),
});

const ComparisonTableFields = z.strictObject({
  title: text(80),
  options: z.array(text(40)).min(2).max(5),
  criteria: z.array(ComparisonRowFields).min(1).max(12),
  recommendation: text(200).optional(),
  chosen: text(40).optional(),
});

// ------------------------------------------------------------------ template data

export const CARD_TEMPLATES: readonly CardTemplate[] = Object.freeze([
  {
    id: "meeting_minutes",
    name: "会议纪要",
    cardType: "NoteCard",
    description: "把一场会议的参会人、议题、结论和待办写成一张分条便笺；用户没给的项直接省略，不补写。",
    fields: MeetingMinutesFields,
    examples: [
      "把刚才的会议记成会议纪要：议题是预算复盘和排期，结论是延到下周",
      "记一下会议纪要：参会人小王、小李，议题是选型，结论是先用方案A，待办是本周出对比表",
    ],
    skeleton: ["会议", "参会", "议题", "结论", "待办"],
    channel: { kind: "contract", contract: "note" },
  },
  {
    id: "weekly_report",
    name: "周报",
    cardType: "TodoCard",
    description: "本周完成项自动勾选、下周计划留空，两组分别用「本周完成：」「下周计划：」前缀分开；不要替用户编造没做的成果。",
    fields: WeeklyReportFields,
    defaults: { title: "周报" },
    examples: ["写个周报：这周做完了模板调研和接口对齐，下周接入工具层"],
    skeleton: ["本周完成", "下周计划"],
    channel: { kind: "scene", scene: "todo_list" },
  },
  {
    id: "project_plan",
    name: "项目计划",
    cardType: "RoadmapCard",
    description: "按阶段拆解的项目计划路标卡，阶段状态未说明时只标为未开始。",
    fields: ProjectPlanFields,
    examples: ["做个项目计划：第一阶段契约梳理，第二阶段模板落地，第三阶段接线验收"],
    skeleton: ["阶段", "周期", "目标", "里程碑"],
    channel: { kind: "scene", scene: "project_roadmap" },
  },
  {
    id: "todo_checklist",
    name: "待办清单",
    cardType: "TodoCard",
    description: "一张干净的待办清单，条目文字原样保留，编号与完成状态由程序生成。",
    fields: TodoChecklistFields,
    examples: ["列个待办清单：整理会议纪要、发出周报、约下周评审"],
    skeleton: ["标题", "条目"],
    channel: { kind: "contract", contract: "todo" },
  },
  {
    id: "decision_record",
    name: "决策记录",
    cardType: "NoteCard",
    description: "按「决策 / 背景 / 选项 / 理由」四个分区记录一次决策，每个备选方案单独一条；只写用户给出的结论，不替用户拍板。",
    fields: DecisionRecordFields,
    examples: ["记一下决策：模板先存在代码里，理由是改动最小，备选是放数据库"],
    skeleton: ["决策", "背景", "选项", "理由"],
    channel: { kind: "contract", contract: "note" },
  },
  {
    id: "retrospective",
    name: "复盘",
    cardType: "NoteCard",
    description: "按做得好、待改进、下一步四行复盘一件事，缺项省略，不写空话。",
    fields: RetrospectiveFields,
    examples: ["做个复盘：这次模板试点选型很准，但字段太细，下一步合并同义字段"],
    skeleton: ["复盘", "做得好", "待改进", "下一步"],
    channel: { kind: "contract", contract: "note" },
  },
  {
    id: "reading_note",
    name: "阅读笔记",
    cardType: "BookCard",
    description: "一本书的阅读笔记卡：书名、作者、页码进度和笔记条目；页码与进度只填用户说的数字。",
    fields: ReadingNoteFields,
    examples: ["记阅读笔记：《卡片笔记写作法》读到第120页，共300页，笔记是先把想法写成卡片"],
    skeleton: ["书名", "作者", "进度", "笔记"],
    channel: { kind: "scene", scene: "book_record" },
  },
  {
    id: "comparison_table",
    name: "对比表",
    cardType: "ComparisonCard",
    description: "多方案多指标对比表，每行取值数量必须与方案数一致；选中的方案必须来自方案列表。",
    fields: ComparisonTableFields,
    examples: ["做个对比表：代码常量 vs 数据库，比较改动量和可配置程度"],
    skeleton: ["标题", "方案", "指标", "取值", "结论"],
    channel: { kind: "scene", scene: "option_comparison" },
  },
]);

const TEMPLATE_BY_ID: Readonly<Record<string, CardTemplate>> = Object.freeze(
  Object.fromEntries(CARD_TEMPLATES.map(template => [template.id, template])),
);

/** Inherited keys ("toString") must not resolve to a template. */
export const getCardTemplate = (id: string): CardTemplate | undefined =>
  Object.hasOwn(TEMPLATE_BY_ID, id) ? TEMPLATE_BY_ID[id] : undefined;

// ------------------------------------------------------------------ field checks

const shapeOf = (schema: z.ZodType): Record<string, z.ZodType> | null => {
  const shape = (schema as { shape?: unknown }).shape;
  return shape && typeof shape === "object" ? shape as Record<string, z.ZodType> : null;
};

/** Keys the schema requires and the model left out, in declaration order. */
const missingFields = (schema: z.ZodType, input: Record<string, unknown>): string[] => {
  const shape = shapeOf(schema);
  if (!shape) return [];
  return Object.entries(shape)
    .filter(([key, field]) => input[key] === undefined && !field.safeParse(undefined).success)
    .map(([key]) => key);
};

const ISSUE_HINT: Readonly<Record<string, string>> = Object.freeze({
  invalid_type: "缺少必填字段或类型不符",
  too_small: "内容为空或数量不足",
  too_big: "超出长度或数量上限",
  unrecognized_keys: "含未登记的字段，只能填模板声明的字段",
  invalid_union: "取值类型不符",
  invalid_value: "取值不在允许范围",
  invalid_format: "格式不符",
  invalid_key: "字段名不合法",
});

/** Short, field-addressed issue text; never echoes whole model payloads. */
const describeFields = (error: z.ZodError): string =>
  error.issues.slice(0, 3).map(issue => {
    const path = issue.path.map(String).join(".") || "fields";
    // custom issues carry our own Chinese sentence; built-in ones get a hint.
    const hint = issue.code === "custom" ? issue.message.slice(0, 80) : ISSUE_HINT[issue.code] ?? "不合法";
    return `${path}：${hint}`;
  }).join("；");

/** Required-key report first (so a missing field never surfaces as an English type error). */
function parseFields<S extends z.ZodType>(schema: S, input: Record<string, unknown>):
  { ok: true; value: z.output<S> } | { ok: false; issue: string } {
  const missing = missingFields(schema, input);
  if (missing.length) return { ok: false, issue: `缺少必填字段：${missing.join("、")}` };
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, issue: `字段不合法：${describeFields(parsed.error)}` };
  return { ok: true, value: parsed.data as z.output<S> };
}

// ------------------------------------------------------------------ prepared payloads

/** A validated payload plus the real host channel that will build the card. */
type Prepared =
  | { ok: true; channel: "contract"; contract: keyof typeof CARD_CONTRACTS; slots: Record<string, unknown> }
  | { ok: true; channel: "scene"; scene: SceneId; data: Record<string, unknown> }
  | { ok: false; issue: string };

const fail = (issue: string): Prepared => ({ ok: false, issue });

const NOTE_SECTION_MAX = 4;
const NOTE_SECTION_ITEM_MAX = 6;
const NOTE_SECTION_ITEM_LENGTH = 180;

/** Both the todo_list scene payload and CardRecordSchema cap one todo line at 160. */
const TODO_ITEM_MAX = 160;
/** A TodoCard has no grouping layout, so the two weekly groups live in the item
 * text; the prefix is part of the same 160-character line budget. */
const WEEKLY_DONE_PREFIX = "本周完成：";
const WEEKLY_NEXT_PREFIX = "下周计划：";

const noteSectionsPrepared = (sections: ReadonlyArray<{ title: string; items: readonly string[] }>): Prepared => {
  if (!sections.length) return fail("没有可写入便笺的内容");
  if (sections.length > NOTE_SECTION_MAX) {
    return fail(`便笺最多 ${NOTE_SECTION_MAX} 个分区，当前 ${sections.length} 个；请合并内容`);
  }
  for (const section of sections) {
    if (!section.items.length) return fail(`分区「${section.title}」没有内容`);
    if (section.items.length > NOTE_SECTION_ITEM_MAX) {
      return fail(`分区「${section.title}」最多 ${NOTE_SECTION_ITEM_MAX} 条，当前 ${section.items.length} 条；请合并内容`);
    }
    const tooLong = section.items.findIndex(item => item.length > NOTE_SECTION_ITEM_LENGTH);
    if (tooLong !== -1) {
      return fail(`分区「${section.title}」第 ${tooLong + 1} 条超过 ${NOTE_SECTION_ITEM_LENGTH} 字，请精简后再建卡`);
    }
  }
  return { ok: true, channel: "contract", contract: "note", slots: { sections } };
};

/**
 * One mapper per template id. Each mapper re-parses with the same schema object
 * the template publishes, so the field list and the builder cannot drift.
 */
const PREPARERS: Readonly<Record<string, (input: Record<string, unknown>) => Prepared>> = Object.freeze({
  meeting_minutes: input => {
    const parsed = parseFields(MeetingMinutesFields, input);
    if (!parsed.ok) return parsed;
    const { title, attendees, topics, decisions, actions } = parsed.value;
    // 只有会议主题/参会人时才加“会议”分区；其余分区按用户给出的内容出现。
    const meeting = [
      ...(title ? [title] : []),
      ...(attendees?.length ? [`参会：${attendees.join("、")}`] : []),
    ];
    return noteSectionsPrepared([
      ...(meeting.length ? [{ title: "会议", items: meeting }] : []),
      { title: "议题", items: topics },
      ...(decisions?.length ? [{ title: "结论", items: decisions }] : []),
      ...(actions?.length ? [{ title: "待办", items: actions }] : []),
    ]);
  },
  weekly_report: input => {
    const parsed = parseFields(WeeklyReportFields, input);
    if (!parsed.ok) return parsed;
    const { title, done, next = [] } = parsed.value;
    if (done.length + next.length > 30) return fail(`待办卡最多 30 条，当前 ${done.length + next.length} 条；请精简`);
    // 完成项勾选、计划项留空，都是宿主按字段生成的状态，不是对成果的猜测。
    // 待办卡没有分组版式，两组只能靠条目前缀区分：先本周完成，再下周计划。
    const items = [
      ...done.map(item => ({ text: `${WEEKLY_DONE_PREFIX}${item}`, done: true })),
      ...next.map(item => ({ text: `${WEEKLY_NEXT_PREFIX}${item}`, done: false })),
    ];
    // 前缀计入同一条 160 字上限；超了就拒绝，不截断用户原文。
    const overflow = items.findIndex(item => item.text.length > TODO_ITEM_MAX);
    if (overflow !== -1) {
      return fail(`第 ${overflow + 1} 条加上「本周完成/下周计划」前缀后超过 ${TODO_ITEM_MAX} 字，请精简后再建卡`);
    }
    return {
      ok: true, channel: "scene", scene: "todo_list", data: { title: title ?? "周报", items },
    };
  },
  project_plan: input => {
    const parsed = parseFields(ProjectPlanFields, input);
    if (!parsed.ok) return parsed;
    const { title, phases } = parsed.value;
    return {
      ok: true, channel: "scene", scene: "project_roadmap", data: {
        title,
        phases: phases.map(phase => ({
          name: phase.name,
          // 没说进度就只说“未开始”，不冒充进行中或已完成。
          status: phase.status ?? "planned",
          ...(phase.period ? { period: phase.period } : {}),
          ...(phase.goal ? { goal: phase.goal } : {}),
          ...(phase.milestones?.length ? { milestones: phase.milestones.map(item => ({ text: item })) } : {}),
        })),
      },
    };
  },
  todo_checklist: input => {
    const parsed = parseFields(TodoChecklistFields, input);
    if (!parsed.ok) return parsed;
    const { title, items } = parsed.value;
    return { ok: true, channel: "contract", contract: "todo", slots: { ...(title ? { title } : {}), items } };
  },
  decision_record: input => {
    const parsed = parseFields(DecisionRecordFields, input);
    if (!parsed.ok) return parsed;
    const { topic, background, options, decision, reasons } = parsed.value;
    // 以前是 4–5 行 bullets：minimal 320×120 只有 78px 可视高度（≈2.8 行），
    // 选项还被 join 成「选项：A；B」一行。改用 4 区便笺，每个备选方案单独一条，
    // 决定与理由各自分区；用户没给的项省略，不补空分区。
    return noteSectionsPrepared([
      { title: "决策", items: [topic, `决定：${decision}`] },
      ...(background ? [{ title: "背景", items: [background] }] : []),
      { title: "选项", items: options },
      ...(reasons?.length ? [{ title: "理由", items: reasons }] : []),
    ]);
  },
  retrospective: input => {
    const parsed = parseFields(RetrospectiveFields, input);
    if (!parsed.ok) return parsed;
    const { topic, wentWell, toImprove, next } = parsed.value;
    return noteSectionsPrepared([
      { title: "复盘", items: [topic] },
      { title: "做得好", items: wentWell },
      { title: "待改进", items: toImprove },
      { title: "下一步", items: next },
    ]);
  },
  reading_note: input => {
    const parsed = parseFields(ReadingNoteFields, input);
    if (!parsed.ok) return parsed;
    const { title, author, status, currentPage, totalPages, rating, notes } = parsed.value;
    if (currentPage !== undefined && totalPages !== undefined && currentPage > totalPages) {
      return fail(`currentPage（${currentPage}）不能超过 totalPages（${totalPages}）`);
    }
    return {
      ok: true, channel: "scene", scene: "book_record", data: {
        title,
        notes,
        ...(author ? { author } : {}),
        ...(status ? { status } : {}),
        ...(currentPage !== undefined ? { currentPage } : {}),
        ...(totalPages !== undefined ? { totalPages } : {}),
        ...(rating !== undefined ? { rating } : {}),
      },
    };
  },
  comparison_table: input => {
    const parsed = parseFields(ComparisonTableFields, input);
    if (!parsed.ok) return parsed;
    const { title, options, criteria, recommendation, chosen } = parsed.value;
    if (new Set(options).size !== options.length) return fail("options 有重复项，方案名必须唯一");
    const mismatched = criteria.find(row => row.values.length !== options.length);
    if (mismatched) {
      return fail(`指标「${mismatched.name}」有 ${mismatched.values.length} 个取值，但方案有 ${options.length} 个；每行取值必须与方案一一对应`);
    }
    if (chosen && !options.includes(chosen)) return fail(`chosen「${chosen}」不在 options 里，只能选已列出的方案`);
    return {
      ok: true, channel: "scene", scene: "option_comparison", data: {
        title,
        options: options.map(name => ({ name })),
        criteria: criteria.map(row => ({
          name: row.name, values: row.values,
          ...(row.better ? { better: row.better } : {}),
          ...(row.unit ? { unit: row.unit } : {}),
        })),
        ...(recommendation ? { recommendation } : {}),
        ...(chosen ? { chosen } : {}),
      },
    };
  },
});

// ------------------------------------------------------------------ host build

const flattenText = (value: unknown): string[] => {
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(flattenText);
  if (value && typeof value === "object") return Object.values(value).flatMap(flattenText);
  return [];
};

/**
 * Evidence text for the reused scene builders. They ground dates, clock times,
 * numbers and names against an evidence string; this layer only receives the
 * model's field values, so the evidence is exactly "template label + the values
 * the model filled" (the same approach `create_weekly_plan` already uses for a
 * host-suggested plan).
 *
 * Deliberate consequences:
 * - the host still adds no fact beyond the fields (nothing is invented here);
 * - every structural scene check (same week, end > start, page ≤ total, value
 *   count, valid dates/times) still runs and still fails closed;
 * - but grounding cannot prove the fields came from the user's words. That
 *   check belongs to the caller, which is the only layer holding the utterance.
 * Never widen this text with anything the model did not send.
 */
const evidenceText = (template: CardTemplate, data: Record<string, unknown>): string =>
  [template.name, template.cardType, ...flattenText(data)].join("\n").slice(0, 8000);

/** Scene builders read canvas labels as evidence; a card titled "本周待办" must
 * not override this request, so only ids/types/layouts are offered to grounding. */
const sceneGroundingCtx = (ctx: CanvasContext): CanvasContext => ({
  ...ctx,
  cards: ctx.cards.map(card => ({ id: card.id, type: card.type, displayProps: {}, sourceDataSummary: {}, layout: card.layout })),
});

/** Scene builders place cards at the origin; the template layer still owns the
 * empty spot, through the same newCardLayout every creation path uses. */
const placeCards = (actions: Action[], context: CardBuildContext): Action[] => {
  const working: CardBuildContext = { ...context, cards: [...context.cards] };
  return actions.map(action => {
    if (action.type !== "card.create") return action;
    const card = { ...action.card, layout: { ...action.card.layout,
      ...newCardLayout(action.card.layout.width, action.card.layout.height, working) } };
    working.cards.push({ id: card.id, type: card.type, displayProps: card.displayProps,
      sourceDataSummary: card.sourceData, layout: card.layout });
    return { ...action, card };
  });
};

export type TemplateBuildResult =
  | { ok: true; actions: Action[]; cardType: CardType; templateId: string }
  | { ok: false; issue: string };

/**
 * template_id + model fields → validated card actions, or one explicit issue.
 * Pure: no I/O, no model, no clock beyond `now`; the caller owns routing,
 * confirmation and envelope assembly.
 */
export function buildTemplateActions(
  templateId: string,
  fields: unknown,
  ctx: CanvasContext,
  now: number = Date.now(),
  options: { sections?: boolean } = {},
): TemplateBuildResult {
  const template = getCardTemplate(templateId);
  if (!template) {
    const available = CARD_TEMPLATES.map(item => item.id).join("、");
    return { ok: false, issue: `未知模板 ${templateId}；可用模板：${available}` };
  }
  if (fields !== undefined && fields !== null && (typeof fields !== "object" || Array.isArray(fields))) {
    return { ok: false, issue: `模板「${template.name}」的 fields 必须是对象` };
  }
  const provided = (fields ?? {}) as Record<string, unknown>;
  const input: Record<string, unknown> = { ...template.defaults, ...provided };
  const prepare = PREPARERS[template.id];
  if (!prepare) return { ok: false, issue: `模板「${template.name}」没有可用的构建通道` };

  const prepared = prepare(input);
  if (!prepared.ok) return { ok: false, issue: `模板「${template.name}」${prepared.issue}` };

  const context: CardBuildContext = { ...ctx, cards: [...ctx.cards], focusHistory: [...ctx.focusHistory] };
  let actions: Action[];
  try {
    if (prepared.channel === "contract") {
      const contract = CARD_CONTRACTS[prepared.contract];
      if (!contract) return { ok: false, issue: `模板「${template.name}」依赖的卡片契约 ${prepared.contract} 未注册` };
      const slots = contract.slots.safeParse(prepared.slots);
      if (!slots.success) {
        return { ok: false, issue: `模板「${template.name}」生成的内容未通过 ${prepared.contract} 契约校验：${describeFields(slots.error)}` };
      }
      const output = contract.build(slots.data, context, new Date(now));
      // Every built-in contract used here is synchronous; anything else fails closed.
      if (!Array.isArray(output)) return { ok: false, issue: `模板「${template.name}」的契约 ${prepared.contract} 没有返回可执行动作` };
      actions = output;
    } else {
      const built = buildSceneActions(
        [{ scene_id: prepared.scene, data: prepared.data }],
        { text: evidenceText(template, prepared.data), ctx: sceneGroundingCtx(ctx), now },
      );
      if (!built.ok) return { ok: false, issue: `模板「${template.name}」的 ${prepared.scene} 场景未通过构建：${built.issue}` };
      actions = placeCards(built.actions, context);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : "未知错误";
    return { ok: false, issue: `模板「${template.name}」构建失败：${detail}` };
  }

  const created = actions.filter((action): action is Extract<Action, { type: "card.create" }> => action.type === "card.create");
  if (created.length !== 1) return { ok: false, issue: `模板「${template.name}」应生成 1 张卡片，实际 ${created.length} 张` };
  const card = created[0]!.card;
  if (card.type !== template.cardType) {
    return { ok: false, issue: `模板「${template.name}」声明 ${template.cardType}，宿主通道却生成了 ${card.type}` };
  }
  // Attribution for the usage / edit-rate review: the card records which
  // template built it, without touching displayProps or the scene's own fields.
  const attributed = CardRecordSchema.safeParse({ ...card, sourceData: { ...card.sourceData, template: template.id } });
  if (!attributed.success) {
    return { ok: false, issue: `模板「${template.name}」的卡片未通过 CardRecordSchema：${describeFields(attributed.error)}` };
  }
  // The current live frontend contract only accepts text/bullets. When the
  // frontend has not shipped sections yet, flatten sections into text so the
  // host never sends a card the runtime silently drops.
  let finalCard = attributed.data;
  if (options.sections === false) {
    const props = finalCard.displayProps as Record<string, unknown>;
    const sections = Array.isArray(props.sections) ? props.sections as Array<{ title?: unknown; items?: unknown }> : null;
    if (sections) {
      const text = sections.map(section => {
        const title = typeof section.title === "string" ? section.title : "";
        const items = Array.isArray(section.items) ? section.items.filter((item): item is string => typeof item === "string") : [];
        return [title, ...items.map(item => `· ${item}`)].filter(Boolean).join("\n");
      }).join("\n\n");
      const nextProps = { ...props } as Record<string, unknown>;
      delete nextProps.sections;
      nextProps.text = text;
      finalCard = { ...finalCard, displayProps: nextProps } as unknown as typeof finalCard;
    }
  }
  actions = actions.map(action => action.type === "card.create" ? { ...action, card: finalCard } : action);
  if (!actions.some(action => action.type === "card.focus")) actions = [...actions, { type: "card.focus", targetId: attributed.data.id }];
  for (const action of actions) {
    const valid = ActionSchema.safeParse(action);
    if (!valid.success) return { ok: false, issue: `模板「${template.name}」生成的动作未通过 ActionSchema：${describeFields(valid.error)}` };
  }
  return { ok: true, actions, cardType: attributed.data.type, templateId: template.id };
}
