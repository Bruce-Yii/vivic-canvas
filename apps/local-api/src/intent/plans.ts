import type { Action, HostOperation, IntentRouteId } from "@vivic/contracts";
import type { CanvasContext } from "../schemas.js";
import { CARD_CONTRACTS } from "../cards/index.js";
import { newCardLayout } from "../cards/build.js";
import type { CardBuildContext } from "../cards/types.js";
import { buildSceneActions } from "../scenes/index.js";
import { addDays, dayOfWeek, isoOf, mondayOf, todayIn } from "../scenes/calendar.js";
import { isNumberedList, splitClauses } from "../decision/split.js";
import { scheduledReminderIntent } from "./scheduledReminders.js";

/** One clause of a deterministic plan: which contract built it and what it made. */
export interface PlanGroup {
  clause: number;
  contract: string;
  cardIds: string[];
  cards: string[];
  route: IntentRouteId;
}
export interface DeterministicPlan {
  actions: Action[];
  groups: PlanGroup[];
  /** One route per clause, in clause order. */
  routes: IntentRouteId[];
  say: string;
  /** A closed-form host operation the rules resolved; exclusive of `actions`. */
  hostOperation?: HostOperation;
}

const WEEKDAY: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
const WEEKDAY_LABEL = ["一", "二", "三", "四", "五", "六", "日"];
const PERIOD = /^(?:凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|晚间)/u;

/** A single explicit schedule sentence: "周四下午要去健身", "周四上午 9 点要开会". */
export interface AgendaItem { day: number; title: string; start?: string; weekStart: string }
export function parseAgenda(text: string, ctx: CanvasContext, now: number): AgendaItem | null {
  const input = text.trim().replace(/[。！!，,；;]+$/u, "");
  if (/提醒|叫我|喊我|取消|删除|删掉|修改|改成|推迟|提前|如果|要是|除非|别|不要|不用|吗|呢|[？?]|几点|什么|哪[天个]/u.test(input)) return null;
  const head = input.match(/^(?:请|帮我|给我|麻烦)?\s*(?:(上上|上|这|本|下下|下)\s*(?:个)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天])|(?:周|星期|礼拜)\s*([一二三四五六日天]))\s*/u);
  if (!head) return null;
  const prefix = head[1];
  const weekWord = head[2] ?? head[3]!;
  const day = WEEKDAY[weekWord];
  if (!day) return null;
  let rest = input.slice(head[0].length).trim();
  const period = rest.match(PERIOD)?.[0];
  if (period) rest = rest.slice(period.length).trim();
  const clock = rest.match(/^(\d{1,2}|[零〇一二两三四五六七八九十]+)\s*(?:点|[:：])\s*(半|一刻|三刻|\d{1,2}|[零〇一二两三四五六七八九十]+)?\s*分?/u);
  let start: string | undefined;
  if (clock) {
    const hour = /^\d+$/u.test(clock[1]!) ? Number(clock[1]) : chineseHour(clock[1]!);
    const tail = clock[2] ?? "";
    const minute = tail === "半" ? 30 : tail === "一刻" ? 15 : tail === "三刻" ? 45 : tail ? hourNumber(tail) ?? 0 : 0;
    if (hour === null || hour > 23 || minute > 59) return null;
    let normalized = hour;
    if (/下午|傍晚|晚上|晚间/u.test(period ?? "") && normalized < 12) normalized += 12;
    if (normalized === 24) normalized = 0;
    start = `${String(normalized).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    rest = rest.slice(clock[0].length).trim();
  }
  // The action is what is left once the date, period and clock are removed.
  rest = rest.replace(/^(?:要|得|需要|打算|计划|准备|会|去|一起|再|在|到)+/u, "").trim();
  if (rest.length < 1 || rest.length > 40) return null;
  if (!/[\p{L}\p{N}]/u.test(rest)) return null;
  let weekStart = mondayOf(todayIn(ctx.timeZone ?? "Asia/Shanghai", now));
  if (prefix === "下" || prefix === "下下") weekStart = addDays(weekStart, prefix === "下下" ? 14 : 7);
  else if (prefix === "上" || prefix === "上上") weekStart = addDays(weekStart, prefix === "上上" ? -14 : -7);
  else if (!prefix && dayOfWeek(todayIn(ctx.timeZone ?? "Asia/Shanghai", now)) > day) weekStart = addDays(weekStart, 7);
  const title = start || !period ? rest : `${period} ${rest}`;
  return { day, title, ...(start ? { start } : {}), weekStart: isoOf(weekStart) };
}

const chineseHour = (raw: string): number | null => {
  const table: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  if (raw === "十") return 10;
  if (raw.length === 1) return table[raw] ?? null;
  if (raw.length === 2 && raw[0] === "十") return 10 + (table[raw[1]!] ?? 0);
  if (raw.length === 2 && raw[1] === "十") return (table[raw[0]!] ?? 0) * 10;
  return null;
};
const hourNumber = (raw: string): number | null => /^\d+$/u.test(raw) ? Number(raw) : chineseHour(raw);

/** "帮我做一个下周的健身计划" → a suggested weekly plan on the existing scene contract. */
export interface WeeklyPlanRequest { week: "下周" | "本周"; subject: string; weekStart: string }
export function parseWeeklyPlan(text: string, ctx: CanvasContext, now: number): WeeklyPlanRequest | null {
  const input = text.trim().replace(/[。！!]+$/u, "");
  if (/[？?]|不要|别|如果|要是|怎么|如何|什么|哪[天个]|吗|呢/u.test(input)) return null;
  const match = input.match(/^(?:请|帮我|给我|麻烦|劳驾)?\s*(?:做|制定|定|安排|生成|规划|来|搞|写|列)\s*(?:一下|一个|一份|个)?\s*(下下?周|下个?星期|下个?礼拜|本?周|这周|这星期|这个?礼拜)\s*的?\s*(.{1,16}?)\s*计划$/u);
  if (!match) return null;
  const word = match[1]!;
  const subject = match[2]!.trim();
  // "下周五的健身计划" names one day: that is a schedule entry, not a week plan.
  const afterWeek = input.slice(input.indexOf(word) + word.length);
  if (/^\s*(?:个)?\s*(?:周|星期|礼拜)?\s*[一二三四五六日天]/u.test(afterWeek)) return null;
  if (!subject || /提醒|倒计时|天气|搜索|查询/u.test(subject)) return null;
  // This deterministic draft only owns the fitness plan that used to be
  // clarified; other "plan" subjects keep the normal planner path.
  if (!/健身|锻炼|运动|训练|跑步|减脂|增肌/u.test(subject)) return null;
  const week: WeeklyPlanRequest["week"] = /^下/u.test(word) ? "下周" : "本周";
  const monday = mondayOf(todayIn(ctx.timeZone ?? "Asia/Shanghai", now));
  return { week, subject, weekStart: isoOf(week === "下周" ? addDays(monday, 7) : monday) };
}

/** A short, explicitly suggested set of days/exercises; never a clock time. */
const planEventTitles = (subject: string): string[] =>
  /健身|锻炼|运动|训练|跑步|减脂|增肌/u.test(subject) ? ["力量训练", "有氧运动", "拉伸放松"] : [subject, subject, subject];

const contextFor = (ctx: CanvasContext): CardBuildContext =>
  ({ ...ctx, cards: [...ctx.cards], focusHistory: [...ctx.focusHistory] });

const recordCards = (actions: Action[], working: CardBuildContext): string[] => {
  const types: string[] = [];
  for (const action of actions) {
    if (action.type !== "card.create") continue;
    types.push(action.card.type);
    working.cards.push({ id: action.card.id, type: action.card.type, aliases: action.card.metadata.aliases,
      displayProps: action.card.displayProps, sourceDataSummary: action.card.sourceData, layout: action.card.layout });
  }
  return types;
};
const createdIds = (actions: Action[]): string[] =>
  actions.flatMap(action => action.type === "card.create" ? [action.card.id] : []);

/** Scene builders place at the canvas origin; move each card to the first free
 * slot against the cards this turn already proposed. */
const placeSceneCards = (actions: Action[], working: CardBuildContext): Action[] =>
  actions.map(action => action.type === "card.create"
    ? { ...action, card: { ...action.card, layout: { ...action.card.layout,
      ...newCardLayout(action.card.layout.width, action.card.layout.height, working) } } }
    : action);

type Chunk = { actions: Action[]; contract: string; route: IntentRouteId };

/** Try the existing literal contracts for one clause; `null` means "not deterministic". */
async function buildClause(clause: string, working: CardBuildContext, now: number): Promise<Chunk | null> {
  const scheduled = scheduledReminderIntent(clause, working, now);
  if (scheduled) return scheduled.actions?.length ? { actions: scheduled.actions, contract: "countdown", route: "countdown" } : null;
  const countdown = CARD_CONTRACTS.countdown!;
  const slots = countdown.parse?.(clause, working);
  if (slots !== null && slots !== undefined) {
    const built = await countdown.build(slots, working, new Date(now));
    if (Array.isArray(built) && built.length) return { actions: built, contract: "countdown", route: "countdown" };
  }
  const todo = CARD_CONTRACTS.todo!;
  const todoSlots = todo.parse?.(clause, working);
  if (todoSlots !== null && todoSlots !== undefined) {
    const built = await todo.build(todoSlots, working, new Date(now));
    if (Array.isArray(built) && built.length) return { actions: built, contract: "todo", route: "todo" };
  }
  const note = CARD_CONTRACTS.note!;
  const noteSlots = note.parse?.(clause, working);
  if (noteSlots !== null && noteSlots !== undefined) {
    const built = await note.build(noteSlots, working, new Date(now));
    if (Array.isArray(built) && built.length) return { actions: built, contract: "note", route: "note" };
  }
  const agenda = parseAgenda(clause, working, now);
  if (agenda) {
    const built = buildSceneActions([{ scene_id: "weekly_schedule", data: {
      title: `周${WEEKDAY_LABEL[agenda.day - 1]} ${agenda.title}`.slice(0, 80).trim(),
      weekStart: agenda.weekStart,
      events: [{ day: agenda.day, title: agenda.title, ...(agenda.start ? { start: agenda.start } : {}) }],
    } }], { text: clause, ctx: working, now });
    if (built.ok) {
      const placed = placeSceneCards(built.actions, working);
      return { actions: placed, contract: "weekly_schedule", route: "generate" };
    }
  }
  return null;
}

/** A numbered list is only built locally when every item is deterministic;
 * otherwise the existing planner path owns the whole sentence (no partial commit). */
export async function planNumbered(clauses: string[], ctx: CanvasContext, now = Date.now()): Promise<DeterministicPlan | null> {
  if (clauses.length < 2) return null;
  const working = contextFor(ctx);
  const groups: PlanGroup[] = [];
  let actions: Action[] = [];
  for (const [index, clause] of clauses.entries()) {
    const chunk = await buildClause(clause, working, now);
    if (!chunk) return null;
    recordCards(chunk.actions, working);
    const ids = createdIds(chunk.actions);
    const cards = chunk.actions.flatMap(action => action.type === "card.create" ? [action.card.type] : []);
    groups.push({ clause: index, contract: chunk.contract, cardIds: ids, cards, route: chunk.route });
    actions.push(...chunk.actions);
  }
  // One awaken and one camera move for the whole batch.
  const awakened = actions.filter((action, index, all) => action.type !== "stage.awaken" || all.findIndex(item => item.type === "stage.awaken") === index);
  return { actions: normalizeEnvelopeActions(awakened), groups, routes: groups.map(group => group.route),
    say: `已创建 ${groups.reduce((sum, group) => sum + group.cardIds.length, 0)} 张卡片，请查看。` };
}

/** "暂停"/"继续" a named existing countdown: closed form, one card, no planner. */
const COUNTDOWN_CONTROL = /^(?:请|帮我|给我|麻烦)?\s*(暂停|暂停一下|先暂停|停止|继续|恢复|继续计时|接着计时)\s*(?:一下)?\s*(.+?)\s*(?:的)?(?:倒计时|计时器|计时|定时器|提醒)$/u;
const CONTROL_BLOCKER = /[，,；;？?]|然后|同时|顺便|并且|另外|要是|如果|不要|不用|别|吗|呢|删除|删掉|改成|改为|新建|创建|再来/u;

/** The pause/resume host operation the user's own words and one card describe. */
export function parseCountdownControl(text: string, ctx: CanvasContext): HostOperation | null {
  const input = text.trim().replace(/[。！!]+$/u, "");
  if (CONTROL_BLOCKER.test(input)) return null;
  const match = input.match(COUNTDOWN_CONTROL);
  if (!match) return null;
  const verb = match[1]!;
  const name = match[2]!.trim().replace(/^(?:这个|那个|这张|那张)/u, "").trim();
  if (!name || name.length > 40) return null;
  const timers = ctx.cards.filter(card => card.type === "CountdownCard" && (
    card.id === name
    || card.aliases?.some(alias => alias === name || alias.includes(name) || name.includes(alias))
    || (typeof card.displayProps.title === "string" && (card.displayProps.title === name || card.displayProps.title.includes(name)))
    || card.sourceDataSummary.reminderText === name));
  // Ambiguity is not resolved by guessing: the planner/user picks the timer.
  if (timers.length !== 1) return null;
  return { kind: /暂停|停止/u.test(verb) ? "countdown.pause" : "countdown.resume", targetId: timers[0]!.id };
}

/** The single weekly-plan request the model used to answer with a question. */
export async function planWeekly(text: string, ctx: CanvasContext, now = Date.now()): Promise<DeterministicPlan | null> {
  const request = parseWeeklyPlan(text, ctx, now);
  if (!request) return null;
  const working = contextFor(ctx);
  const titles = planEventTitles(request.subject);
  const built = buildSceneActions([{ scene_id: "weekly_schedule", data: {
    title: `${request.week}${request.subject}计划（建议）`.slice(0, 80),
    weekStart: request.weekStart,
    events: [1, 3, 5].map((day, index) => ({ day, title: titles[index]! })),
  } }], { text, ctx: working, now });
  if (!built.ok) return null;
  const placed = placeSceneCards(built.actions, working);
  recordCards(placed, working);
  const cards = placed.flatMap(action => action.type === "card.create" ? [action.card.type] : []);
  return { actions: normalizeEnvelopeActions(placed), routes: ["generate"],
    say: `这是${request.week}${request.subject}计划的通用建议，可继续修改。`,
    groups: [{ clause: 0, contract: "weekly_schedule", cardIds: createdIds(placed), cards, route: "generate" }] };
}

/** Explicit same-day agenda items need no invented hours or model-generated schema. */
export async function planDay(text: string, ctx: CanvasContext, now = Date.now()): Promise<DeterministicPlan | null> {
  const input = text.trim().replace(/[。！!]+$/u, "");
  if (/不要|不用|别|如果|要是|怎么|如何|取消|删除|修改|改成|[？?]/u.test(input)) return null;
  const match = input.match(/^(?:请|帮我|给我|麻烦)?\s*(?:做|制定|安排|生成|规划)\s*(?:一下|一个|一份|个)?\s*(今天|明天|后天)\s*的?\s*(.{0,20}?)(?:计划|日程|安排)\s*[，,：:]\s*(?:包含|包括|内容是)?\s*(.+)$/u);
  if (!match) return null;
  const items = match[3]!.split(/[、，,；;]/u).map(item => item.trim()).filter(Boolean);
  if (items.length < 2 || items.length > 8 || items.some(item => !PERIOD.test(item))) return null;
  const target = addDays(todayIn(ctx.timeZone ?? "Asia/Shanghai", now), match[1] === "今天" ? 0 : match[1] === "明天" ? 1 : 2);
  const day = dayOfWeek(target), events: Array<{ day: number; title: string; start?: string }> = [];
  for (const item of items) {
    const parsed = parseAgenda(`本周${WEEKDAY_LABEL[day - 1]}${item}`, ctx, now);
    if (!parsed) return null;
    events.push({ day, title: parsed.title, ...(parsed.start ? { start: parsed.start } : {}) });
  }
  const title = `${match[1]}${match[2]!.trim()}计划`.slice(0, 80), working = contextFor(ctx);
  const built = buildSceneActions([{ scene_id: "weekly_schedule", data: { title, weekStart: isoOf(mondayOf(target)), events } }], { text, ctx: working, now });
  if (!built.ok) return null;
  const actions = placeSceneCards(built.actions, working), cardIds = createdIds(actions);
  return { actions, groups: [{ clause: 0, contract: "weekly_schedule", cardIds,
    cards: actions.flatMap(action => action.type === "card.create" ? [action.card.type] : []), route: "generate" }], routes: ["generate"], say: `已为你准备好${title}，请确认。` };
}

/** Batches use one camera move; card.focus from a single-card builder is dropped. */
function normalizeEnvelopeActions(actions: Action[]): Action[] {
  const creates = actions.filter(action => action.type === "card.create");
  if (creates.length <= 1) return actions;
  return [...actions.filter(action => action.type !== "card.focus" && action.type !== "canvas.fit" && action.type !== "canvas.restore"),
    { type: "canvas.fit" }];
}

/** "加个待办" / "记个任务": the clause is only the command, not its content. */
const BARE_TODO_APPEND = /^(?:再|顺便|另外|然后)?\s*(?:帮我|给我)?\s*(?:加|添加|新增|创建|新建|记|建|弄|搞|列)(?:一个|个|一条|一下|下)?\s*(?:待办|任务|待办项|todo|to-?do)(?:项|清单|列表)?$/iu;
/** The content clause must be an item, not another operation. */
const OPERATION_CLAUSE = /倒计时|计时器|计时|提醒|闹钟|天气|气温|搜索|查询|聚焦|删掉|删除|移除|显示全部|恢复原视图|撤销|重做|高亮|移动|挪|固定|打开|关闭|暂停|继续|放大|缩小/u;

/** The item text of a "…, 加个待办" sentence, or null when it is not that shape. */
export function parseTodoAppend(text: string): string | null {
  const clauses = splitClauses(text);
  if (clauses.length !== 2) return null;
  const [content, command] = clauses as [string, string];
  if (!BARE_TODO_APPEND.test(command.trim())) return null;
  const item = content.trim().replace(/[，,；;。！!]+$/u, "");
  // Keep the user's own words (an explicit time word belongs to the item text);
  // never invent or rewrite content the planner would otherwise have written.
  if (item.length < 2 || item.length > 160) return null;
  if (OPERATION_CLAUSE.test(item)) return null;
  return item;
}

/** "明天上午先把合同发给王经理，加个待办" → one TodoCard, no planner call. */
export async function planTodoAppend(text: string, ctx: CanvasContext, now = Date.now()): Promise<DeterministicPlan | null> {
  const item = parseTodoAppend(text);
  if (!item) return null;
  const working = contextFor(ctx);
  const todo = CARD_CONTRACTS.todo!;
  const built = await todo.build({ items: [item] }, working, new Date(now));
  if (!Array.isArray(built) || !built.length) return null;
  recordCards(built, working);
  const cards = built.flatMap(action => action.type === "card.create" ? [action.card.type] : []);
  // Both clauses belong to the one todo: the content clause carries the item and
  // the trailing append clause is only its command, so provenance covers both.
  return { actions: normalizeEnvelopeActions(built), routes: splitClauses(text).map(() => "todo" as const), say: "已记下这条待办。",
    groups: [{ clause: 0, contract: "todo", cardIds: createdIds(built), cards, route: "todo" }] };
}

/** "聚焦会议记录，把标题改成首页改版讨论": the second clause names no card. */
const FOCUS_CLAUSE = /^(?:请|帮我|给我|麻烦)?\s*(?:聚焦|聚焦到|选中|定位到|定位)\s*(.+)$/u;
const TITLE_EDIT_CLAUSE = /^(?:请|帮我)?\s*(?:把|将)?\s*(?:这张卡片的|这张卡的|这张|它的|该卡片的|卡片的)?\s*标题\s*(?:改成|改为|设为|设置成|设成|换成|变成)\s*(.+)$/u;

const titleOf = (card: CanvasContext["cards"][number]): string => {
  const title = card.displayProps.title;
  return typeof title === "string" ? title : "";
};

/** Resolve the single card a focus clause names; ambiguity is never guessed. */
export function resolveFocusCard(text: string, ctx: CanvasContext): CanvasContext["cards"][number] | null {
  const input = text.trim().replace(/[。！!]+$/u, "");
  const match = input.match(FOCUS_CLAUSE);
  if (!match) return null;
  const name = match[1]!.trim().replace(/^(?:一下|到)/u, "").trim();
  if (!name || name.length > 40 || /[，,；;。！!？?]/u.test(name)) return null;
  const cards = ctx.cards.filter(card => card.id === name || titleOf(card) === name
    || card.aliases?.some(alias => alias === name || alias === `${name}卡` || alias === `${name}卡片`));
  return cards.length === 1 ? cards[0]! : null;
}

/** The focus+edit-title pair where only the first clause names the card. */
export function planFocusEdit(text: string, ctx: CanvasContext): DeterministicPlan | null {
  const clauses = splitClauses(text);
  if (clauses.length !== 2) return null;
  const card = resolveFocusCard(clauses[0]!, ctx);
  if (!card || !["NoteCard", "TodoCard"].includes(card.type)) return null;
  const edit = clauses[1]!.trim().replace(/[。！!]+$/u, "").match(TITLE_EDIT_CLAUSE);
  if (!edit) return null;
  const title = edit[1]!.trim();
  if (!title || title.length > 80) return null;
  const update: Action = card.type === "TodoCard"
    ? { type: "card.update", targetId: card.id, displayProps: { title } }
    // A note's visible heading is its text; the card editor already maps 标题 to it.
    : { type: "card.update", targetId: card.id, displayProps: { text: title } };
  const actions: Action[] = [...(ctx.stage === "STANDBY" ? [{ type: "stage.awaken" } as const] : []),
    { type: "card.focus", targetId: card.id }, update];
  return { actions, routes: ["focus", "edit"], say: "已聚焦这张卡片并改好标题。",
    groups: [{ clause: 0, contract: "focus", cardIds: [], cards: [], route: "focus" },
      { clause: 1, contract: "edit", cardIds: [], cards: [], route: "edit" }] };
}

/** Entry point shared by the rules fast path and the on-mode proposal path. */
export async function planDeterministic(text: string, ctx: CanvasContext, now = Date.now()): Promise<DeterministicPlan | null> {
  const day = await planDay(text, ctx, now); if (day) return day;
  const clauses = splitClauses(text);
  if (clauses.length > 1) {
    if (isNumberedList(text)) return planNumbered(clauses, ctx, now);
    return await planTodoAppend(text, ctx, now) ?? planFocusEdit(text, ctx);
  }
  const weekly = await planWeekly(text, ctx, now);
  if (weekly) return weekly;
  // "暂停喝水倒计时" is one existing card and one closed-form host operation:
  // the rules own the target, the owner still applies and reports it.
  const control = parseCountdownControl(text, ctx);
  // Narrow to the timer operations this entry point can resolve a target for.
  if (control?.kind !== "countdown.pause" && control?.kind !== "countdown.resume") return null;
  const targetId = control.targetId;
  if (!targetId) return null;
  // Never claim the timer was already paused/resumed: this is a proposal that
  // still needs the owner's receipt. Name the resolved card instead.
  const target = ctx.cards.find(card => card.id === targetId);
  const label = (target?.aliases?.[0] ?? (target ? titleOf(target) : "")).slice(0, 40);
  const verb = control.kind === "countdown.pause" ? "暂停" : "继续";
  return { actions: [], groups: [], routes: ["edit"], hostOperation: control,
    say: label ? `已提交「${label}」的${verb}，等待执行确认。` : `已提交计时${verb}，等待执行确认。` };
}

/** The target guard for a rules-resolved countdown host operation: the target
 *  must still be a loaded CountdownCard. Null means "proposal may proceed";
 *  otherwise the caller must ask instead of submitting anything. */
export function countdownControlIssue(operation: HostOperation, ctx: CanvasContext): string | null {
  const verb = operation.kind === "countdown.resume" ? "继续" : "暂停";
  if (operation.kind !== "countdown.pause" && operation.kind !== "countdown.resume") return null;
  if (!operation.targetId) return `没有找到要${verb}的计时卡片，请指明卡名。`;
  const target = ctx.cards.find(card => card.id === operation.targetId);
  if (!target) return `没有找到要${verb}的计时卡片，请指明卡名。`;
  if (target.type !== "CountdownCard") return `「${target.aliases?.[0] ?? target.id}」不是计时卡片，请指明要${verb}的计时。`;
  return null;
}
