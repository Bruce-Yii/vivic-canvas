import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ActionEnvelopeSchema, SCENE_IDS, type Action, type HostOperation, type IntentRouteId } from "@vivic/contracts";

import type { CanvasContext } from "../schemas.js";
import { CARD_CONTRACTS } from "../cards/index.js";
import { newCardLayout } from "../cards/build.js";
import type { CardBuildContext } from "../cards/types.js";
import { buildSceneActions } from "../scenes/index.js";
import { addDays, dayOfWeek, isoOf, mondayOf, todayIn } from "../scenes/calendar.js";

/**
 * Conversational tool calling (local experiment, `VIVIC_TOOL_CALLS=on`).
 *
 * The model picks capabilities and fills business arguments only. Every
 * `card.create` is still built by the host's existing card contracts, so the
 * model never writes a CardRecord, never executes anything and never bypasses
 * ActionEnvelope validation. This module is a pure mapper: tool calls in →
 * actions / clarify / chat out. It performs no network I/O.
 */

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolCallCreated {
  tool: string;
  cardType: string;
  id: string;
}

export interface ToolCallPlan {
  kind: "envelope" | "clarify" | "chat" | "invalid" | "host-operation" | "composite";
  actions: Action[];
  routes: IntentRouteId[];
  created: ToolCallCreated[];
  issues: string[];
  say?: string;
  message?: string;
  /** History-style operations are executed by the host, not encoded as cards. */
  hostOperation?: HostOperation;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const empty = { type: "object", additionalProperties: false, required: [], properties: {} } as const;

/** One source of truth for the tool layer; descriptions state host-owned facts. */
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  { type: "function", function: { name: "create_countdown", description: "创建一个倒计时/计时器/一次提醒。minutes 为分钟数（30秒=0.5），text 仅在用户给出提醒事项时填写。", parameters: { type: "object", additionalProperties: false, required: ["minutes"], properties: { minutes: { type: "number", description: "倒计时分钟数，例如 30、0.5、90" }, text: { type: "string", description: "提醒事项，没有就不填" } } } } },
  { type: "function", function: { name: "create_todo", description: "创建一个待办清单，items 是待办条目数组；用户一次列出多条时全部放进 items。", parameters: { type: "object", additionalProperties: false, required: ["items"], properties: { items: { type: "array", items: { type: "string" }, minItems: 1 } } } } },
  { type: "function", function: { name: "create_note", description: "创建便笺/笔记。用户说记一下、记下、记录、便笺、笔记时用这个；不要把这类内容建成待办。text 是正文。", parameters: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string" } } } } },
  { type: "function", function: { name: "create_weekly_plan", description: "创建周计划/健身计划/学习计划等按周安排，topic 为计划主题。", parameters: { type: "object", additionalProperties: false, required: ["topic"], properties: { topic: { type: "string" } } } } },
  { type: "function", function: { name: "create_schedule", description: "创建一个日程/会议/约定，title 为事项；有星期或钟点时填 day/time，不确定不要编。", parameters: { type: "object", additionalProperties: false, required: ["title"], properties: { title: { type: "string" }, day: { type: "string", description: "如 周四、下周一；没有不填" }, time: { type: "string", description: "如 上午9点；没有不填" } } } } },
  { type: "function", function: { name: "create_scene_card", description: "创建 21 种场景卡之一（路线图/柱状图/时间线/金句/照片故事/运动流水/目标进度/习惯打卡/书籍/月历/对比表/网页收藏/照片纪念/通知/文献/图库/新闻/日程/待办/倒计时；travel_offers 需走旅行查询，不要用本工具）。scene_id 必须是枚举之一；data 按该场景字段填（如 title/items/events/points/phases/slides），日期用 YYYY-MM-DD，时间用 HH:MM，数值/链接/日期必须来自用户原话，不能编。", parameters: { type: "object", additionalProperties: false, required: ["scene_id", "data"], properties: { scene_id: { type: "string", enum: SCENE_IDS }, data: { type: "object", additionalProperties: true } } } } },
  { type: "function", function: { name: "create_chart", description: "把用户给的一组数值做成图表。用户说柱状图/折线图/饼图或给出「名称+数值」序列时用这个；points 的 y 必须是用户原话里的数，不要反问数据、不要走表格。", parameters: { type: "object", additionalProperties: false, required: ["chartKind", "points"], properties: { chartKind: { type: "string", enum: ["bar", "line", "pie"] }, points: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, required: ["x", "y"], properties: { x: { type: "string" }, y: { type: "number" } } } }, title: { type: "string" } } } } },
  { type: "function", function: { name: "create_notification", description: "创建单条通知卡。title 必填，body 为内容，level 取 info/success/warning/error；用户说「重要/紧急」用 warning，「完成」用 success，「故障」用 error。", parameters: { type: "object", additionalProperties: false, required: ["title"], properties: { title: { type: "string" }, body: { type: "string" }, level: { type: "string", enum: ["info", "success", "warning", "error"] } } } } },
  { type: "function", function: { name: "create_habit", description: "创建习惯打卡卡。habit 必填；用户给了具体日期就填 checkins（YYYY-MM-DD），只给「本周一/二/三」时按 prompt 里的今天换算；给不出具体日期就先 clarify。", parameters: { type: "object", additionalProperties: false, required: ["habit"], properties: { habit: { type: "string" }, checkins: { type: "array", items: { type: "string" } }, weeklyGoal: { type: "integer", minimum: 1, maximum: 7 } } } } },
  { type: "function", function: { name: "focus_created", description: "聚焦刚刚在这次请求中创建的卡片。用户在同一句里说“聚焦它/打开刚建的”时，必须在同一次响应里追加这个工具，不能只创建。", parameters: empty } },
  { type: "function", function: { name: "canvas_fit", description: "显示全部/适应画布/看全部卡片；不是创建卡片。", parameters: empty } },
  { type: "function", function: { name: "focus_card", description: "聚焦/打开画布上某张已有卡片，card_id 必须来自画布摘要里的 id。", parameters: { type: "object", additionalProperties: false, required: ["card_id"], properties: { card_id: { type: "string" } } } } },
  { type: "function", function: { name: "highlight_card", description: "高亮/闪烁画布上某张已有卡片（或待办条目），card_id 必须来自画布摘要里的 id。", parameters: { type: "object", additionalProperties: false, required: ["card_id"], properties: { card_id: { type: "string" } } } } },
  { type: "function", function: { name: "restore_view", description: "恢复聚焦前的视图/退出聚焦，不更改任何卡片。", parameters: empty } },
  { type: "function", function: { name: "delete_card", description: "删除画布上某一张已有卡片。card_id 必须来自画布摘要；删除必须由宿主要求用户确认后才执行。", parameters: { type: "object", additionalProperties: false, required: ["card_id"], properties: { card_id: { type: "string" } } } } },
  { type: "function", function: { name: "undo_last", description: "撤销/重做上一步操作，不创建卡片；redo=true 表示重做。", parameters: { type: "object", additionalProperties: false, required: [], properties: { redo: { type: "boolean", description: "为 true 时重做，否则撤销" } } } } },
  { type: "function", function: { name: "edit_card", description: "修改已有卡片的状态：暂停/继续倒计时。card_id 必须来自画布摘要。", parameters: { type: "object", additionalProperties: false, required: ["card_id", "action"], properties: { card_id: { type: "string" }, action: { type: "string", enum: ["pause_countdown", "resume_countdown"] } } } } },
  { type: "function", function: { name: "arrange_card", description: "移动或固定已有卡片。card_id 必须来自画布摘要；action 为 pin/unpin 或 move_left/move_right/move_up/move_down。", parameters: { type: "object", additionalProperties: false, required: ["card_id", "action"], properties: { card_id: { type: "string" }, action: { type: "string", enum: ["pin", "unpin", "move_left", "move_right", "move_up", "move_down"] } } } } },
  { type: "function", function: { name: "arrange_canvas", description: "自动整理/排列整个画布布局，不移动单张卡。", parameters: empty } },
  { type: "function", function: { name: "clarify", description: "目标不明确、缺少关键信息、或无法安全执行时追问；不要猜。", parameters: { type: "object", additionalProperties: false, required: ["question"], properties: { question: { type: "string" } } } } },
  { type: "function", function: { name: "chat", description: "纯聊天、问答、搜索、天气、写作等不需要创建/操作卡片的请求；调用它表示不建卡。", parameters: empty } },
];

/**
 * Catalog metadata for the "freeze 16 routes, derive behavior from tools"
 * direction. Runtime behavior still reads the existing route tables; this
 * catalog is the single place a future capability migration reads from.
 */
export interface ToolCapability {
  name: string;
  /** Intent/attribution route this tool implements ("clarify" is an action, not a route). */
  capability: IntentRouteId | "clarify";
  /** Safe to run as a direct rule/fast path when args are exact. */
  directEligible: boolean;
  /** Needs a target card resolved from the canvas summary. */
  targeted: boolean;
  /** Irreversible user-visible change. */
  destructive: boolean;
  /** Host must ask the user to confirm before execution. */
  needsConfirm: boolean;
  /** Defined by an installed extension instead of the built-in catalog. */
  extension: boolean;
}

export const TOOL_CATALOG: ToolCapability[] = [
  { name: "create_countdown", capability: "countdown", directEligible: true, targeted: false, destructive: false, needsConfirm: false, extension: false },
  { name: "create_todo", capability: "todo", directEligible: true, targeted: false, destructive: false, needsConfirm: false, extension: false },
  { name: "create_note", capability: "note", directEligible: true, targeted: false, destructive: false, needsConfirm: false, extension: false },
  { name: "create_weekly_plan", capability: "generate", directEligible: false, targeted: false, destructive: false, needsConfirm: false, extension: false },
  { name: "create_schedule", capability: "generate", directEligible: false, targeted: false, destructive: false, needsConfirm: false, extension: false },
  { name: "create_scene_card", capability: "generate", directEligible: false, targeted: false, destructive: false, needsConfirm: false, extension: false },
  { name: "create_chart", capability: "generate", directEligible: false, targeted: false, destructive: false, needsConfirm: false, extension: false },
  { name: "create_notification", capability: "generate", directEligible: false, targeted: false, destructive: false, needsConfirm: false, extension: false },
  { name: "create_habit", capability: "generate", directEligible: false, targeted: false, destructive: false, needsConfirm: false, extension: false },
  { name: "focus_created", capability: "focus", directEligible: true, targeted: false, destructive: false, needsConfirm: false, extension: false },
  { name: "canvas_fit", capability: "overview", directEligible: true, targeted: false, destructive: false, needsConfirm: false, extension: false },
  { name: "focus_card", capability: "focus", directEligible: true, targeted: true, destructive: false, needsConfirm: false, extension: false },
  { name: "highlight_card", capability: "highlight", directEligible: true, targeted: true, destructive: false, needsConfirm: false, extension: false },
  { name: "restore_view", capability: "restore", directEligible: true, targeted: false, destructive: false, needsConfirm: false, extension: false },
  { name: "delete_card", capability: "delete", directEligible: false, targeted: true, destructive: true, needsConfirm: true, extension: false },
  { name: "undo_last", capability: "undo", directEligible: false, targeted: false, destructive: false, needsConfirm: false, extension: false },
  { name: "edit_card", capability: "edit", directEligible: false, targeted: true, destructive: false, needsConfirm: false, extension: false },
  { name: "arrange_card", capability: "arrange", directEligible: false, targeted: true, destructive: false, needsConfirm: false, extension: false },
  { name: "arrange_canvas", capability: "arrange", directEligible: true, targeted: false, destructive: false, needsConfirm: false, extension: false },
  { name: "clarify", capability: "clarify", directEligible: false, targeted: false, destructive: false, needsConfirm: false, extension: false },
  { name: "chat", capability: "chat", directEligible: false, targeted: false, destructive: false, needsConfirm: false, extension: false },
];

const CountdownArgs = z.strictObject({ minutes: z.number().finite().positive().max(1440), text: z.string().trim().max(160).optional() });
const TodoArgs = z.strictObject({ items: z.array(z.string().trim().min(1).max(160)).min(1).max(30) });
const NoteArgs = z.strictObject({ text: z.string().trim().min(1).max(500) });
const WeeklyArgs = z.strictObject({ topic: z.string().trim().min(1).max(40) });
const ScheduleArgs = z.strictObject({ title: z.string().trim().min(1).max(80), day: z.string().trim().max(8).optional(), time: z.string().trim().max(16).optional() });
const FocusCardArgs = z.strictObject({ card_id: z.string().trim().min(1).max(128) });
const UndoArgs = z.strictObject({ redo: z.boolean().optional() });
const SceneCardArgs = z.strictObject({
  scene_id: z.enum(SCENE_IDS),
  data: z.record(z.string(), z.unknown()),
});
const ChartArgs = z.strictObject({
  chartKind: z.enum(["bar", "line", "pie"]),
  points: z.array(z.strictObject({ x: z.string().trim().min(1).max(40), y: z.number().finite() })).min(1).max(100),
  title: z.string().trim().max(80).optional(),
});
const NotificationArgs = z.strictObject({
  title: z.string().trim().min(1).max(80),
  body: z.string().trim().max(300).optional(),
  level: z.enum(["info", "success", "warning", "error"]).optional(),
});
const HabitArgs = z.strictObject({
  habit: z.string().trim().min(1).max(60),
  checkins: z.array(z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/)).max(800).optional(),
  weeklyGoal: z.int().min(1).max(7).optional(),
});
const EditCardArgs = z.strictObject({
  card_id: z.string().trim().min(1).max(128),
  action: z.enum(["pause_countdown", "resume_countdown"]),
});
const ArrangeCardArgs = z.strictObject({
  card_id: z.string().trim().min(1).max(128),
  action: z.enum(["pin", "unpin", "move_left", "move_right", "move_up", "move_down"]),
});
const HOST_OPERATION_TOOLS = new Set(["undo_last", "edit_card", "arrange_card", "arrange_canvas"]);
const ClarifyArgs = z.strictObject({ question: z.string().trim().min(1).max(180) });

const WEEKDAY: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
const WEEKDAY_LABEL = ["一", "二", "三", "四", "五", "六", "日"];
const PERIOD = /(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|晚间)/u;

const zone = (ctx: CanvasContext) => ctx.timeZone ?? "Asia/Shanghai";
const contextFor = (ctx: CanvasContext): CardBuildContext =>
  ({ ...ctx, cards: [...ctx.cards], focusHistory: [...ctx.focusHistory] });

const recordCards = (actions: Action[], working: CardBuildContext): ToolCallCreated[] => {
  const created: ToolCallCreated[] = [];
  for (const action of actions) {
    if (action.type !== "card.create") continue;
    working.cards.push({ id: action.card.id, type: action.card.type, aliases: action.card.metadata.aliases,
      displayProps: action.card.displayProps, sourceDataSummary: action.card.sourceData, layout: action.card.layout });
    created.push({ tool: "", cardType: action.card.type, id: action.card.id });
  }
  return created;
};

/** "周四"/"下周一"/"一" → 1..7; absent is the host's today, never invented. */
/** "上午9点"/"9:30"/"下午两点半" → HH:mm; a period without a clock stays out of `start`. */
const CN_DIGIT: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const cnNumber = (raw: string): number => {
  if (/^\d+$/u.test(raw)) return Number(raw);
  if (raw === "十") return 10;
  if (raw.length === 1) return CN_DIGIT[raw] ?? Number.NaN;
  if (raw.length === 2 && raw[0] === "十") return 10 + (CN_DIGIT[raw[1]!] ?? 0);
  if (raw.length === 2 && raw[1] === "十") return (CN_DIGIT[raw[0]!] ?? 0) * 10;
  return Number.NaN;
};
const parseClock = (raw: string | undefined): string | undefined => {
  if (!raw) return undefined;
  const match = raw.match(/(\d{1,2}|[零〇一二两三四五六七八九十]{1,2})\s*(?:[:：]\s*(\d{1,2})|点\s*(半|一刻|三刻|\d{1,2}|[零〇一二两三四五六七八九十]{1,2})?)?/u);
  if (!match) return undefined;
  let hour = cnNumber(match[1]!);
  const tail = match[2] ?? match[3] ?? "";
  const minute = tail === "半" ? 30 : tail === "一刻" ? 15 : tail === "三刻" ? 45 : tail ? cnNumber(tail) : 0;
  if (!Number.isFinite(hour) || hour > 23 || !Number.isFinite(minute) || minute > 59) return undefined;
  if (/(下午|傍晚|晚上|晚间)/u.test(raw) && hour < 12) hour += 12;
  if (hour === 24) hour = 0;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
};

const planEventTitles = (topic: string): string[] =>
  /健身|锻炼|运动|训练|跑步|减脂|增肌/u.test(topic) ? ["力量训练", "有氧运动", "拉伸放松"] : [topic, topic, topic];

/** Scene builders ground their payload against the whole canvas; a canvas alias
 * such as "本周待办" would otherwise override the tool's explicit 下周. Tool
 * calls already carry host-normalized dates, so scene grounding uses ids/types
 * only and the request text for the facts. */
const sceneGroundingCtx = (ctx: CanvasContext): CanvasContext =>
  ({ ...ctx, cards: ctx.cards.map(card => ({ id: card.id, type: card.type,
    displayProps: {}, sourceDataSummary: {}, layout: card.layout })) });

/** Resolve a tool `day` argument to a concrete weekday + week start.
 * Supports 今天/明天/后天 and 本周X/下周X; a bare 周X means the next occurrence. */
const parseScheduleDate = (raw: string | undefined, ctx: CanvasContext, now: number):
  { day: number; weekStart: string; label: string } => {
  const today = todayIn(zone(ctx), now);
  const thisMonday = mondayOf(today);
  const todayDow = dayOfWeek(today);
  if (!raw) return { day: todayDow, weekStart: isoOf(thisMonday), label: `周${WEEKDAY_LABEL[todayDow - 1]}` };
  const relative: Record<string, number> = { 今天: 0, 今日: 0, 明天: 1, 明日: 1, 后天: 2, 大后天: 3 };
  for (const [word, offset] of Object.entries(relative)) {
    if (raw.includes(word)) {
      const target = addDays(today, offset);
      const day = dayOfWeek(target);
      return { day, weekStart: isoOf(mondayOf(target)), label: `周${WEEKDAY_LABEL[day - 1]}` };
    }
  }
  const char = raw.match(/[一二三四五六日天]/u)?.[0];
  const day = char ? WEEKDAY[char]! : todayDow;
  let monday = thisMonday;
  if (/下(?:个)?(?:周|星期|礼拜)/u.test(raw)) monday = addDays(thisMonday, 7);
  else if (/上(?:个)?(?:周|星期|礼拜)/u.test(raw)) monday = addDays(thisMonday, -7);
  else if (!/本(?:周|星期|礼拜)|这(?:周|星期|礼拜)/u.test(raw) && day < todayDow) monday = addDays(thisMonday, 7);
  return { day, weekStart: isoOf(monday), label: `周${WEEKDAY_LABEL[day - 1]}` };
};

const placeSceneCards = (actions: Action[], working: CardBuildContext): Action[] =>
  actions.map(action => action.type === "card.create"
    ? { ...action, card: { ...action.card, layout: { ...action.card.layout,
      ...newCardLayout(action.card.layout.width, action.card.layout.height, working) } } }
    : action);

/** All-or-nothing: one unbuildable call rejects the whole turn (no partial commit). */
/** A missing required key is a clarification; a bad value stays an invalid fallback. */
const missingRequired = (error: z.ZodError): boolean =>
  error.issues.some(issue => issue.code === "invalid_type" && String((issue as { received?: unknown }).received) === "undefined");

export async function planFromToolCalls(calls: ToolCall[], ctx: CanvasContext, now = Date.now(), utterance = ""): Promise<ToolCallPlan> {
  const issues: string[] = [];
  const routes: IntentRouteId[] = [];
  const actions: Action[] = [];
  const created: ToolCallCreated[] = [];
  const working = contextFor(ctx);
  let hostOperation: HostOperation | undefined;

  if (calls.length === 0) return { kind: "invalid", actions: [], routes: [], created: [], issues: ["模型没有返回任何工具调用"] };
  if (calls.length === 1 && calls[0]!.name === "clarify") {
    const parsed = ClarifyArgs.safeParse(calls[0]!.arguments);
    return parsed.success
      ? { kind: "clarify", actions: [], routes: [], created: [], issues: [], message: parsed.data.question }
      : { kind: "invalid", actions: [], routes: [], created: [], issues: ["clarify 参数不合法"] };
  }
  if (calls.length === 1 && calls[0]!.name === "chat") {
    return { kind: "chat", actions: [], routes: ["chat"], created: [], issues: [] };
  }
  if (calls.some(call => call.name === "clarify" || call.name === "chat")) {
    return { kind: "invalid", actions: [], routes: [], created: [], issues: ["clarify/chat 不能与其他工具同批出现"] };
  }
  // Focus is single-target; two focus calls in one turn is ambiguous, not a
  // batch of two actions.
  if (calls.filter(call => call.name === "focus_card").length > 1) {
    return { kind: "clarify", actions: [], routes: [], created: [], issues: [],
      message: "一次只能聚焦一张卡，你想先打开哪一张？" };
  }
  // Host operations are single actions, but may be paired with view/focus
  // actions from the same sentence (e.g. focus a card, then pin it).

  const push = (chunk: Action[], tool: string, route: IntentRouteId) => {
    const added = recordCards(chunk, working);
    for (const item of added) created.push({ ...item, tool });
    actions.push(...chunk);
    routes.push(route);
  };

  for (const [index, call] of calls.entries()) {
    const fail = (issue: string) => {
      issues.push(`#${index + 1} ${call.name}: ${issue}`);
      return { kind: "invalid" as const, actions: [], routes: [], created: [], issues };
    };
    // Missing parameters must stop the whole batch with a question, never let
    // the planner create a partial result from the remaining clauses.
    const need = (message: string) => ({ kind: "clarify" as const, actions: [], routes: [], created: [], issues: [], message });
    const askOrFail = (error: z.ZodError, message: string) => missingRequired(error) ? need(message) : fail("参数不合法");
    switch (call.name) {
      case "create_countdown": {
        const parsed = CountdownArgs.safeParse(call.arguments);
        if (!parsed.success) return askOrFail(parsed.error, "倒计时设多长时间？");
        // A duration the user never said must not be invented by the model.
        if (utterance && !/(?:\d+|[一二两三四五六七八九十百半]+)\s*(?:分钟|分|小时|时|秒|钟头|minutes?|mins?)/iu.test(utterance)) {
          return need("倒计时设多长时间？");
        }
        const seconds = Math.max(1, Math.min(86_400, Math.round(parsed.data.minutes * 60)));
        const slots = { seconds, ...(parsed.data.text ? { text: parsed.data.text } : {}) };
        const built = await CARD_CONTRACTS.countdown!.build(slots, working, new Date(now));
        if (!Array.isArray(built) || !built.length) return fail("倒计时契约构建失败");
        push(built, call.name, "countdown");
        break;
      }
      case "create_todo": {
        const parsed = TodoArgs.safeParse(call.arguments);
        if (!parsed.success) return askOrFail(parsed.error, "要记哪些待办？");
        const built = await CARD_CONTRACTS.todo!.build({ items: parsed.data.items }, working, new Date(now));
        if (!Array.isArray(built) || !built.length) return fail("待办契约构建失败");
        push(built, call.name, "todo");
        break;
      }
      case "create_note": {
        const parsed = NoteArgs.safeParse(call.arguments);
        if (!parsed.success) return askOrFail(parsed.error, "便笺内容是什么？");
        const built = await CARD_CONTRACTS.note!.build({ text: parsed.data.text }, working, new Date(now));
        if (!Array.isArray(built) || !built.length) return fail("便笺契约构建失败");
        push(built, call.name, "note");
        break;
      }
      case "create_weekly_plan": {
        const parsed = WeeklyArgs.safeParse(call.arguments);
        if (!parsed.success) return askOrFail(parsed.error, "想安排哪方面的周计划？");
        // A bare "健身计划" has no days/duration; ask instead of inventing a plan.
        // A generic "周计划" is allowed: the user asked for the plan itself.
        if (/健身|减肥|跑步|训练|学习|阅读|背单词/u.test(utterance)
          && !/周[一二三四五六日天]|每天|每周|早上|上午|下午|晚上|\d+\s*(?:点|小时|分钟|公里|组|次|天)/u.test(utterance)) {
          return need("下周想练哪几天、每次多久？");
        }
        const monday = mondayOf(todayIn(zone(ctx), now));
        const titles = planEventTitles(parsed.data.topic);
        const planTitle = parsed.data.topic.replace(/计划$/u, "");
        const built = buildSceneActions([{ scene_id: "weekly_schedule", data: {
          title: `下周${planTitle}计划（建议）`.slice(0, 80),
          weekStart: isoOf(addDays(monday, 7)),
          events: [1, 3, 5].map((day, position) => ({ day, title: titles[position]! })),
        } }], { text: `下周${planTitle}计划`, ctx: sceneGroundingCtx(working), now });
        if (!built.ok) return fail(`周计划场景构建失败：${built.issue}`);
        const placed = placeSceneCards(built.actions, working);
        push(placed, call.name, "generate");
        break;
      }
      case "create_schedule": {
        const parsed = ScheduleArgs.safeParse(call.arguments);
        if (!parsed.success) return askOrFail(parsed.error, "这件事安排在哪天、几点？");
        const { day, weekStart, label } = parseScheduleDate(parsed.data.day, ctx, now);
        const start = parseClock(parsed.data.time);
        const period = parsed.data.time?.match(PERIOD)?.[0];
        // A period without a clock ("周四下午") stays in the title, never invented
        // as a start time; a real clock is carried by `start`.
        const title = start ? parsed.data.title : period ? `${period}${parsed.data.title}` : parsed.data.title;
        const built = buildSceneActions([{ scene_id: "weekly_schedule", data: {
          title: `${label} ${title}`.slice(0, 80),
          weekStart,
          events: [{ day, title, ...(start ? { start } : {}) }],
        } }], { text: `${label} ${parsed.data.time ?? ""} ${parsed.data.title}`, ctx: sceneGroundingCtx(working), now });
        if (!built.ok) return fail(`日程场景构建失败：${built.issue}`);
        const placed = placeSceneCards(built.actions, working);
        push(placed, call.name, "generate");
        break;
      }
      case "create_scene_card": {
        const parsed = SceneCardArgs.safeParse(call.arguments);
        if (!parsed.success) return fail("参数不合法");
        if (parsed.data.scene_id === "travel_offers") return need("旅游报价需要联网查询，请在旅行查询里发起。");
        const built = buildSceneActions([{ scene_id: parsed.data.scene_id, data: parsed.data.data }],
          { text: utterance || `创建${parsed.data.scene_id}`, ctx: sceneGroundingCtx(working), now });
        if (!built.ok) {
          issues.push(`#${index + 1} ${call.name}: ${built.issue}`);
          return need(SCENE_ASK[parsed.data.scene_id] ?? "这张卡还缺一点信息，能补充一下吗？");
        }
        push(placeSceneCards(built.actions, working), call.name, "generate");
        break;
      }
      case "create_chart": {
        const parsed = ChartArgs.safeParse(call.arguments);
        if (!parsed.success) return askOrFail(parsed.error, "这张图表要展示哪些名称和数值？");
        const built = buildSceneActions([{ scene_id: "data_visualization", data: {
          chartKind: parsed.data.chartKind, points: parsed.data.points,
          ...(parsed.data.title ? { title: parsed.data.title } : {}),
        } }], { text: utterance || "图表", ctx: sceneGroundingCtx(working), now });
        if (!built.ok) return need("图表里的数值要来自你的原话，给我具体的名称和数值吧。");
        push(placeSceneCards(built.actions, working), call.name, "generate");
        break;
      }
      case "create_notification": {
        const parsed = NotificationArgs.safeParse(call.arguments);
        if (!parsed.success) return askOrFail(parsed.error, "这条通知的内容是什么？");
        const level = parsed.data.level ?? (/重要|紧急/u.test(utterance) ? "warning" : undefined);
        const built = buildSceneActions([{ scene_id: "single_notification", data: {
          title: parsed.data.title, ...(parsed.data.body ? { body: parsed.data.body } : {}), ...(level ? { level } : {}),
        } }], { text: utterance || parsed.data.title, ctx: sceneGroundingCtx(working), now });
        if (!built.ok) return need("这条通知的内容和提醒时间是什么？");
        push(placeSceneCards(built.actions, working), call.name, "generate");
        break;
      }
      case "create_habit": {
        const parsed = HabitArgs.safeParse(call.arguments);
        if (!parsed.success) return askOrFail(parsed.error, "要打卡的习惯是什么？");
        const built = buildSceneActions([{ scene_id: "habit_tracking", data: {
          habit: parsed.data.habit, ...(parsed.data.checkins ? { checkins: parsed.data.checkins } : {}),
          ...(parsed.data.weeklyGoal ? { weeklyGoal: parsed.data.weeklyGoal } : {}),
        } }], { text: `${utterance} ${(parsed.data.checkins ?? []).join(" ")}`.trim(), ctx: sceneGroundingCtx(working), now });
        if (!built.ok) return need("打卡要具体到日期：这周哪几天打了卡？");
        push(placeSceneCards(built.actions, working), call.name, "generate");
        break;
      }
      case "focus_created": {
        const targetId = created.at(-1)?.id;
        if (!targetId) return fail("本次没有可聚焦的新卡片");
        actions.push({ type: "card.focus", targetId });
        routes.push("focus");
        break;
      }
      case "focus_card": {
        const parsed = FocusCardArgs.safeParse(call.arguments);
        if (!parsed.success) return fail("参数不合法");
        if (!working.cards.some(card => card.id === parsed.data.card_id)) return fail(`画布上没有卡片 ${parsed.data.card_id}`);
        // "那个便签" with several notes is ambiguous; never pick one silently.
        if (/那个?(便签|便笺|笔记)/u.test(utterance)) {
          const notes = working.cards.filter(card => card.type === "NoteCard");
          if (notes.length > 1) {
            const labels = notes.map(card => {
              const title = typeof card.displayProps.title === "string" ? card.displayProps.title
                : typeof card.displayProps.text === "string" ? card.displayProps.text : card.aliases?.[0] ?? card.id;
              return `「${String(title).slice(0, 16)}」`;
            }).join("、");
            return need(`画布上有 ${notes.length} 张便签（${labels}），你要打开哪一张？`);
          }
        }
        actions.push({ type: "card.focus", targetId: parsed.data.card_id });
        routes.push("focus");
        break;
      }
      case "highlight_card": {
        const parsed = FocusCardArgs.safeParse(call.arguments);
        if (!parsed.success) return fail("参数不合法");
        if (!working.cards.some(card => card.id === parsed.data.card_id)) return fail(`画布上没有卡片 ${parsed.data.card_id}`);
        // "第一条" is ambiguous when several cards carry item lists.
        if (/第[一1]条|第一项/u.test(utterance)) {
          const lists = working.cards.filter(card => card.type === "TodoCard");
          if (lists.length > 1) return need("多张卡都有第一条，你要标哪张卡的第一条？");
        }
        actions.push({ type: "card.highlight", targetId: parsed.data.card_id });
        routes.push("highlight");
        break;
      }
      case "restore_view":
        actions.push({ type: "canvas.restore" });
        routes.push("restore");
        break;
      case "delete_card": {
        const parsed = FocusCardArgs.safeParse(call.arguments);
        if (!parsed.success) return fail("参数不合法");
        if (!working.cards.some(card => card.id === parsed.data.card_id)) return fail(`画布上没有卡片 ${parsed.data.card_id}`);
        actions.push({ type: "card.delete", targetId: parsed.data.card_id });
        routes.push("delete");
        break;
      }
      case "undo_last": {
        const parsed = UndoArgs.safeParse(call.arguments);
        if (!parsed.success) return fail("参数不合法");
        if (hostOperation) return fail("一次只能执行一个宿主操作");
        hostOperation = parsed.data.redo ? { kind: "history.redo" } : { kind: "history.undo" };
        routes.push("undo");
        break;
      }
      case "edit_card": {
        const parsed = EditCardArgs.safeParse(call.arguments);
        if (!parsed.success) return fail("参数不合法");
        const card = working.cards.find(value => value.id === parsed.data.card_id);
        if (!card) return fail(`画布上没有卡片 ${parsed.data.card_id}`);
        if (card.type !== "CountdownCard") return fail("只有倒计时卡片支持暂停/继续");
        if (hostOperation) return fail("一次只能执行一个宿主操作");
        hostOperation = parsed.data.action === "pause_countdown"
          ? { kind: "countdown.pause", targetId: card.id }
          : { kind: "countdown.resume", targetId: card.id };
        routes.push("edit");
        break;
      }
      case "arrange_card": {
        const parsed = ArrangeCardArgs.safeParse(call.arguments);
        if (!parsed.success) return fail("参数不合法");
        if (!working.cards.some(value => value.id === parsed.data.card_id)) return fail(`画布上没有卡片 ${parsed.data.card_id}`);
        if (hostOperation) return fail("一次只能执行一个宿主操作");
        hostOperation = parsed.data.action.startsWith("move_")
          ? { kind: "card.move", targetId: parsed.data.card_id, direction: parsed.data.action.slice(5) as "left" | "right" | "up" | "down" }
          : { kind: "card.pin", targetId: parsed.data.card_id, pinned: parsed.data.action === "pin" };
        routes.push("arrange");
        break;
      }
      case "arrange_canvas":
        if (hostOperation) return fail("一次只能执行一个宿主操作");
        hostOperation = { kind: "canvas.arrange" };
        routes.push("arrange");
        break;
      case "canvas_fit":
        actions.push({ type: "canvas.fit" });
        routes.push("overview");
        break;
      default:
        return fail("未知工具");
    }
  }

  // One awaken per batch; several new cards get one camera move and no per-card focus.
  const firstAwaken = actions.findIndex(action => action.type === "stage.awaken");
  let normalized = actions.filter((action, index) => action.type !== "stage.awaken" || index === firstAwaken);
  // A builder focuses the card it just created; an explicit focus_created adds
  // the same target again — keep one focus per target.
  const seenFocus = new Set<string>();
  normalized = normalized.filter(action => action.type !== "card.focus"
    || (seenFocus.has(action.targetId) ? false : (seenFocus.add(action.targetId), true)));
  const creates = normalized.filter(action => action.type === "card.create");
  if (creates.length > 1) {
    normalized = [...normalized.filter(action => action.type !== "card.focus" && action.type !== "canvas.fit" && action.type !== "canvas.restore"),
      { type: "canvas.fit" }];
  } else if (creates.length === 1 && !normalized.some(action => action.type === "card.focus")) {
    // Scene builders do not focus; note/todo/countdown contracts do. Keep the
    // single-card experience consistent: a new card gets the camera.
    const at = normalized.findIndex(action => action.type === "card.create");
    normalized = [...normalized.slice(0, at + 1), { type: "card.focus", targetId: creates[0]!.card.id },
      ...normalized.slice(at + 1)];
  }
  if (hostOperation && normalized.length === 0) {
    return { kind: "host-operation", actions: [], routes, created, issues: [], hostOperation };
  }
  const envelope = ActionEnvelopeSchema.safeParse({
    schemaVersion: "0.6",
    requestId: `tool_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
    canvasId: ctx.canvasId,
    ...(normalized.some(action => action.type === "card.create") ? { spokenText: `已创建 ${creates.length} 张卡片，请查看。` } : {}),
    actions: normalized,
  });
  if (!envelope.success) {
    issues.push(`envelope 校验失败：${envelope.error.issues.slice(0, 3).map(issue => issue.message).join("；")}`);
    return { kind: "invalid", actions: [], routes: [], created: [], issues };
  }
  return { kind: hostOperation ? "composite" : "envelope", actions: envelope.data.actions, routes, created, issues: [],
    say: envelope.data.spokenText, ...(hostOperation ? { hostOperation } : {}) };
}

/** One honest, in-progress line per tool; never claims completion. */
export const TOOL_FEEDBACK_PHRASES: Record<string, string> = {
  create_countdown: "我来设个倒计时",
  create_todo: "我来记下待办",
  create_note: "我来记下",
  create_weekly_plan: "我来安排周计划",
  create_schedule: "我来安排日程",
  create_scene_card: "我来做这张卡",
  create_chart: "我来画图表",
  create_notification: "我来发通知",
  create_habit: "我来建打卡",
  focus_card: "我来找到那张卡",
  focus_created: "我来找到那张卡",
  highlight_card: "我来标出来",
  restore_view: "我来恢复视图",
  delete_card: "我先确认要删哪张",
  undo_last: "我来撤销",
  edit_card: "我来修改这张卡",
  arrange_card: "我来移动这张卡",
  arrange_canvas: "我来整理布局",
  canvas_fit: "我来显示全部",
  clarify: "我先确认一下",
  chat: "我先看一下",
};
export const toolFeedbackPhrase = (name: string): string => TOOL_FEEDBACK_PHRASES[name] ?? "我正在处理";

/** System prompt for the tool layer: host facts only, no card schemas. */
const SCENE_ASK: Record<string, string> = {
  data_visualization: "这张图表要展示哪些数据点？",
  historical_timeline: "时间线里有哪些事件和日期？",
  quote_note: "要记的金句内容是什么？",
  photo_story: "照片故事有哪几段内容？",
  activity_feed: "要记录的动态有哪些？",
  goal_progress: "目标是什么、现在到哪、目标值多少？",
  habit_tracking: "要打卡的习惯是什么？哪些日期打过卡？",
  book_record: "书名是什么？读到哪、有什么笔记？",
  monthly_calendar: "这个月有哪些事、分别在哪天？",
  option_comparison: "要对比哪些方案、看哪些指标？",
  web_bookmark: "要收藏的链接是什么？",
  photo_memory: "这张纪念卡的标题和照片信息是什么？",
  single_notification: "这条通知的内容和提醒时间是什么？",
  weekly_schedule: "这周/下周有哪些日程？",
  todo_list: "要记哪些待办？",
  news_summary: "要整理的新闻内容和摘要是什么？",
  academic_paper: "这篇文献的标题和要点是什么？",
  photo_gallery: "要展示哪些图片？",
  countdown: "这个倒计时的标题和目标日期是什么？",
};

const SCENE_FIELDS = [
  "countdown: title*, targetDate* (YYYY-MM-DD), targetTime?, note?",
  "data_visualization: chartKind*(line|bar|pie), points*[{x,y}], title?, xLabel?, yLabel?",
  "project_roadmap: title*, phases*[{name*, period?, status?(planned|active|done), goal?, milestones?}]",
  "historical_timeline: title*, events*[{date(YYYY[-MM[-DD]]), title*, description?}]",
  "quote_note: text*, author?, source?, tag?",
  "photo_story: title*, slides*[{heading?, text*, imageUrl?}]",
  "activity_feed: title*, live?, items?[{kind?(done|update|create|comment|alert|event), text*, time?}]",
  "goal_progress: title*, current*, target*, unit?, deadline?, note?",
  "habit_tracking: habit*, checkins?[YYYY-MM-DD], weeklyGoal?, startDate?",
  "book_record: title*, author?, status?(want|reading|paused|finished), currentPage?, totalPages?, rating?, notes?",
  "monthly_calendar: title?, month? (YYYY-MM), events*[{date*, title*, time?}]",
  "option_comparison: title*, options*[{name*}], criteria*[{name*, values*, better?(higher|lower), unit?}], recommendation?, chosen?",
  "web_bookmark: url*, title?, siteName?, description?, tags?",
  "photo_memory: title*, date?, caption?, imageUrl?",
  "single_notification: title*, body?, level?(info|success|warning|error), at?, source?",
  "weekly_schedule: title*, weekStart?, events*[{day?, date?, start?, end?, title*, location?}]",
  "todo_list: title?, items*[{text*, done?}]",
  "news_summary: headline*, summary*, source?, publishedAt?, keyPoints?, url?, imageUrl?",
  "academic_paper: title*, authors?, venue?, year?, abstract?, keyPoints?, doi?, url?, tags?",
  "photo_gallery: title*, images?[{url*, caption?}]",
].join("\n");

const CARD_LABEL_MAX = 40;

/** A card's one-line label: title first, then the text the user would recognise
 * it by. The model needs this to resolve "最左边那张" and "把它固定住". */
const cardLabel = (card: CanvasContext["cards"][number]): string => {
  const props = card.displayProps as Record<string, unknown>;
  const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
  const items = Array.isArray(props.items) ? props.items : [];
  const firstItem = items[0] as { text?: unknown } | undefined;
  const label = text(props.title) || text(props.text) || text(props.headline)
    || text(firstItem?.text) || (card.aliases ?? [])[0] || "";
  return label.length > CARD_LABEL_MAX ? `${label.slice(0, CARD_LABEL_MAX)}…` : label;
};

/** `@x,y 320x120 [固定]` — the geometry the model needs for leftmost/topmost. */
const cardGeometry = (card: CanvasContext["cards"][number]): string => {
  const { x, y, width, height, pinned } = card.layout;
  const round = (value: number): number => Math.round(value);
  const size = width && height ? ` ${round(width)}x${round(height)}` : "";
  return `@${round(x)},${round(y)}${size}${pinned ? " [固定]" : ""}`;
};

export function buildToolSystemPrompt(ctx: CanvasContext): string {
  const cards = ctx.cards.slice(0, 24).map(card => {
    const label = cardLabel(card);
    return `- ${card.id} (${card.type})${label ? ` 「${label}」` : ""} ${cardGeometry(card)}`;
  });
  // Newest first: focusHistory is append-only, so the tail is what "它/刚才那张"
  // refers to. Three entries are enough to disambiguate without bloating the prompt.
  const recentFocus = [...ctx.focusHistory].reverse().slice(0, 3).map(id => {
    const card = ctx.cards.find(value => value.id === id);
    const label = card ? cardLabel(card) : "";
    return `${id}${label ? `「${label}」` : ""}`;
  });
  const hidden = ctx.cards.length - cards.length;
  return [
    "你是 Vivic 画布的指令路由器。只选择工具并填写业务参数；卡片由宿主按契约创建，你不能生成卡片 JSON、不能执行代码、不能编造事实。",
    "规则：",
    "1. 用户一句话里有几件事就返回几个工具调用，顺序与用户顺序一致；不能漏做、不能多做。",
    "2. 明确要创建/操作卡片才调用 create_*；纯聊天、问答、搜索、天气、写作调用 chat（不建卡）。",
    "3. 目标不明确、缺关键信息或无法安全执行时调用 clarify 并给一句具体问题；不要猜。",
    "4. 用户在同一句里要求“聚焦刚建的卡”时，在 create_* 后追加 focus_created；聚焦已有卡用 focus_card，card_id 必须来自下面的画布摘要。",
    "5. 只填用户说过的事实；没说的钟点、日期、数量不要编。",
    "6. 不要调用未提供的工具，不要在参数里放解释性长文。",
    "7. 图表优先用 create_chart，通知用 create_notification，习惯打卡用 create_habit；其余图表/对比/时间线/金句/书籍/运动流水/目标进度/月历/照片/文献/图库/新闻等场景卡用 create_scene_card；data 字段如下（* 为必填）：",
    SCENE_FIELDS,
    "9. 缺必填参数时不要猜、也不要用 create_note 顶替，直接 clarify 问一句；一句话多个动作必须返回多个工具调用，见下面的「多动作」示例。",
    "10. 用户给了几个阶段/事件就建几个，不要追问没提到的部分；今天/明天/本周/下周等相对日期按下面的今天换算成 YYYY-MM-DD，不要编造。",
    "11. 指代与位置：用户说“它/这张/那张/刚才那张”时优先取「最近聚焦」的卡；说“最左/最右/最上/最下/第一张/最后一张”时按卡片 @x,y 判断（x 最小=最左，y 最小=最上）。画布上有能唯一对上的卡就直接用它的 id，不要说“摘要里没有位置”或“指代不明”；只有真的对不上才 clarify。",
    "12. 否定句只执行用户最后要求的动作：「别删，先聚焦它」→ 只调用 focus_card，不要调用 delete_card。",
    "",
    "图表与通知（必须建场景卡；不要改用表格/便笺模板，也不要反问用户已经说过的数据）：",
    "- 「把这几个数做成柱状图：周一12，周二8，周三15」→ create_scene_card(scene_id=\"data_visualization\", data={\"chartKind\":\"bar\",\"points\":[{\"x\":\"周一\",\"y\":12},{\"x\":\"周二\",\"y\":8},{\"x\":\"周三\",\"y\":15}]})。折线图 chartKind=\"line\"，饼图 chartKind=\"pie\"；用户已经给出数值就是数据齐全，直接建卡。",
    "- 「明天九点交材料，级别重要」→ create_scene_card(scene_id=\"single_notification\", data={\"title\":\"交材料\",\"body\":\"明天九点交材料\",\"level\":\"warning\"})。“重要/紧急”≈warning，普通≈info，完成≈success，故障≈error；title 和 body 都要填。",
    "",
    "多动作（用户说了两个动作就必须返回两个工具调用，一个都不能少）：",
    "- 「先聚焦购物清单，再把它固定住」→ focus_card(card_id=购物清单的 id) + arrange_card(card_id=同一个 id, action=\"pin\")；只返回 focus_card 属于漏做。",
    "- 「显示全部再整理」→ canvas_fit + arrange_canvas；只返回 canvas_fit 属于漏做。",
    "- 一句话里同时出现“看/聚焦/高亮/显示全部”和“固定/移动/整理/删除/撤销”时，按用户顺序把两个工具都返回，不要合并成一个，也不要只做前半句。",
    "",
    `画布：canvasId=${ctx.canvasId}，stage=${ctx.stage}，共 ${ctx.cards.length} 张卡。`,
    `今天：${isoOf(todayIn(zone(ctx), Date.now()))} 周${"一二三四五六日"[dayOfWeek(todayIn(zone(ctx), Date.now())) - 1]}（时区 ${zone(ctx)}）。`,
    cards.length
      ? `画布卡片（id 可直接用于 focus_card；@x,y 为左上角坐标，320x120 为宽x高，[固定] 表示已固定${hidden > 0 ? `；共 ${ctx.cards.length} 张，这里只列前 ${cards.length} 张` : ""}）：\n${cards.join("\n")}`
      : "画布当前没有卡片。",
    recentFocus.length ? `最近聚焦（越靠前越近）：${recentFocus.join(" → ")}` : "最近聚焦：无",
  ].join("\n");
}
