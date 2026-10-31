import type { Action, IntentRouteId } from "@vivic/contracts";
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

/** Batches use one camera move; card.focus from a single-card builder is dropped. */
function normalizeEnvelopeActions(actions: Action[]): Action[] {
  const creates = actions.filter(action => action.type === "card.create");
  if (creates.length <= 1) return actions;
  return [...actions.filter(action => action.type !== "card.focus" && action.type !== "canvas.fit" && action.type !== "canvas.restore"),
    { type: "canvas.fit" }];
}

/** Entry point shared by the rules fast path and the on-mode proposal path. */
export async function planDeterministic(text: string, ctx: CanvasContext, now = Date.now()): Promise<DeterministicPlan | null> {
  const clauses = splitClauses(text);
  if (clauses.length > 1) return isNumberedList(text) ? planNumbered(clauses, ctx, now) : null;
  return planWeekly(text, ctx, now);
}
