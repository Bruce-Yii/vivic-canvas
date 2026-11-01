/**
 * Dry-run the tool-call mapper against the recorded probe responses.
 *
 * Reads work/tool-probe/results-v4.json (`baseline.rows[].actual`), maps every
 * recorded `tool_calls` batch through `planFromToolCalls` on a fixed four-card
 * canvas at a fixed clock, and writes a report. Nothing is created, no canvas
 * is touched and no network request is made: the mapper is a pure function.
 *
 * Run from the worktree root:
 *   pnpm --filter @vivic/local-api exec tsx scripts/tool-dry-run.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ActionEnvelopeSchema } from "@vivic/contracts";
import { planFromToolCalls, type ToolCall, type ToolCallPlan } from "../src/intent/toolCalls.js";
import { addDays, isoOf, mondayOf, parseIso, todayIn } from "../src/scenes/calendar.js";
import { CanvasContextSchema, type CanvasContext } from "../src/schemas.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** scripts → local-api → apps → worktree root; `work/` is the worktree's parent. */
const REPO_ROOT = resolve(HERE, "../../..");
const WORK_ROOT = resolve(REPO_ROOT, "..");
const PROBE_PATH = process.env.VIVIC_TOOL_PROBE_RESULTS?.trim()
  || join(WORK_ROOT, "tool-probe", "results-v4.json");
const OUT_DIR = process.env.VIVIC_TOOL_DRY_RUN_OUT?.trim()
  || join(WORK_ROOT, "tool-calling-product");

/** Sunday 2026-11-01 02:00 Shanghai; next Monday is 2026-11-02. */
const NOW = Date.parse("2026-11-01T02:00:00+08:00");
const ZONE = "Asia/Shanghai";

const CREATE_TOOLS = new Set(["create_countdown", "create_todo", "create_note", "create_weekly_plan", "create_schedule"]);
const CARD_OF_TOOL: Record<string, string> = {
  create_countdown: "CountdownCard",
  create_todo: "TodoCard",
  create_note: "NoteCard",
  create_weekly_plan: "WeeklyScheduleCard",
  create_schedule: "WeeklyScheduleCard",
};

interface ProbeCall { name: string; args?: Record<string, unknown> | null }
interface ProbeRow {
  text: string;
  expected: ProbeCall[];
  actual: ProbeCall[] | null;
  ms?: number;
  nameOk?: boolean;
  argsOk?: boolean;
}
interface ProbeFile {
  baseline: { rows: ProbeRow[] };
  refined?: { rows?: ProbeRow[] };
}

/** The four cards the probe showed the model (titles only; no note bodies). */
const canvas = (variant: "probe" | "production" | "weekday-note" = "probe"): CanvasContext => ({
  canvasId: "dry-run-canvas",
  stage: "WORKSPACE",
  viewport: { x: 0, y: 0, zoom: 1 },
  focusHistory: ["note_meeting"],
  timeZone: ZONE,
  cards: [
    { id: "note_meeting", type: "NoteCard", aliases: ["会议记录"],
      displayProps: { text: variant === "weekday-note" ? "会议记录" : "周会纪要" }, sourceDataSummary: {},
      layout: { x: 0, y: 0, width: 320, height: 120, pinned: false } },
    { id: "note_shopping", type: "NoteCard", aliases: ["购物便笺"],
      displayProps: { text: variant === "weekday-note" ? "周末采购清单" : "采购清单" }, sourceDataSummary: {},
      layout: { x: 344, y: 0, width: 320, height: 120 } },
    { id: "todo_week", type: "TodoCard", aliases: ["本周待办"],
      displayProps: { items: [{ id: "item-1", text: "交周报", done: false }] }, sourceDataSummary: {},
      layout: { x: 0, y: 144, width: 288, height: 160 } },
    { id: "countdown_tea", type: "CountdownCard", aliases: ["泡茶 5 分钟"], displayProps: { totalSeconds: 300 },
      // A real countdown card always carries absolute timestamps; the probe sent
      // titles only, so the primary run keeps them out and the sensitivity run
      // adds them back.
      sourceDataSummary: variant === "production"
        ? { targetAt: "2026-10-31T18:05:00.000Z", startedAt: "2026-10-31T18:00:00.000Z", remainingSeconds: 300 }
        : { remainingSeconds: 300 },
      layout: { x: 312, y: 144, width: 260, height: 200 } },
  ],
});

const toCalls = (calls: ProbeCall[] | null): ToolCall[] =>
  (calls ?? []).map(call => ({ name: call.name, arguments: (call.args ?? {}) as Record<string, unknown> }));

const today = todayIn(ZONE, NOW);
const TODAY_ISO = isoOf(today);
const NEXT_MONDAY = isoOf(addDays(mondayOf(today), 7));

/** The host revalidates any produced batch through the same envelope schema. */
const replayEnvelope = (plan: ToolCallPlan, ctx: CanvasContext) => {
  if (!plan.actions.length) return { revalidated: false, issue: null as string | null };
  const parsed = ActionEnvelopeSchema.safeParse({
    schemaVersion: "0.6",
    requestId: "dry_run",
    canvasId: ctx.canvasId,
    actions: plan.actions,
  });
  return parsed.success
    ? { revalidated: true, issue: null }
    : { revalidated: false, issue: parsed.error.issues.slice(0, 3).map(issue => issue.message).join("；") };
};

/** One recorded call inside one batch: did the plan actually carry it out? */
const callSucceeded = (call: ToolCall, plan: ToolCallPlan): boolean => {
  if (plan.kind === "invalid") return false;
  const focuses = plan.actions.flatMap(action => (action.type === "card.focus" ? [action.targetId] : []));
  switch (call.name) {
    case "create_countdown": case "create_todo": case "create_note":
    case "create_weekly_plan": case "create_schedule":
      return plan.created.some(item => item.tool === call.name && item.cardType === CARD_OF_TOOL[call.name]);
    case "focus_created": {
      const id = plan.created.at(-1)?.id;
      return Boolean(id) && focuses.includes(id!);
    }
    case "focus_card":
      return typeof call.arguments.card_id === "string" && focuses.includes(call.arguments.card_id);
    case "canvas_fit":
      return plan.actions.some(action => action.type === "canvas.fit");
    case "clarify":
      return plan.kind === "clarify";
    case "chat":
      return plan.kind === "chat";
    default:
      return false;
  }
};

interface RowResult {
  index: number;
  text: string;
  expectedNames: string[];
  callNames: string[];
  calls: ToolCall[];
  kind: ToolCallPlan["kind"];
  issues: string[];
  actions: ToolCallPlan["actions"];
  created: ToolCallPlan["created"];
  envelopeRevalidated: boolean;
  envelopeIssue: string | null;
  contractOk: boolean;
  expectedCreates: number;
  createdCards: number;
  misbuild: boolean;
  omission: boolean;
  countMatch: boolean;
  failedCalls: string[];
}

const evaluate = async (row: ProbeRow, index: number, ctx: CanvasContext): Promise<RowResult> => {
  const calls = toCalls(row.actual);
  const plan = await planFromToolCalls(calls, ctx, NOW);
  const replay = replayEnvelope(plan, ctx);
  const expectedCreates = (row.expected ?? []).filter(call => CREATE_TOOLS.has(call.name)).length;
  const createdCards = plan.created.length;
  return {
    index: index + 1,
    text: row.text,
    expectedNames: (row.expected ?? []).map(call => call.name),
    callNames: calls.map(call => call.name),
    calls,
    kind: plan.kind,
    issues: plan.issues,
    actions: plan.actions,
    created: plan.created,
    envelopeRevalidated: replay.revalidated,
    envelopeIssue: replay.issue,
    // A clarify/chat plan is contract-valid without an envelope; anything that
    // produced actions must survive the host's own envelope schema.
    contractOk: plan.kind !== "invalid" && (!plan.actions.length || replay.revalidated),
    expectedCreates,
    createdCards,
    misbuild: expectedCreates === 0 && createdCards > 0,
    omission: expectedCreates > 0 && createdCards === 0,
    countMatch: expectedCreates === createdCards,
    failedCalls: calls.filter(call => !callSucceeded(call, plan)).map(call => call.name),
  };
};

const rate = (part: number, whole: number): string => whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}%`;
const pct = (part: number, whole: number): number => whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10;

const probe = JSON.parse(readFileSync(PROBE_PATH, "utf8")) as ProbeFile;
const rows = probe.baseline?.rows ?? [];
if (!rows.length) throw new Error(`没有找到 baseline.rows：${PROBE_PATH}`);

const baseCanvas = canvas("probe");
// Fail loudly if the fixture drifts from the schema Control actually sends.
CanvasContextSchema.parse(baseCanvas);

const results: RowResult[] = [];
for (const [index, row] of rows.entries()) results.push(await evaluate(row, index, baseCanvas));

const total = results.length;
const envelopeRows = results.filter(result => result.kind === "envelope");
const clarifyRows = results.filter(result => result.kind === "clarify");
const chatRows = results.filter(result => result.kind === "chat");
const invalidRows = results.filter(result => result.kind === "invalid");
const contractPass = results.filter(result => result.contractOk).length;
const envelopeRevalidated = envelopeRows.filter(result => result.envelopeRevalidated).length;

const toolNames = [...new Set(results.flatMap(result => result.callNames))].sort();
const tools = toolNames.map(name => {
  const calls = results.flatMap(result => result.calls.filter(call => call.name === name));
  const ok = results.reduce((sum, result) => sum + result.calls.filter(call => call.name === name && callSucceeded(call, result)).length, 0);
  return { name, calls: calls.length, ok, failed: calls.length - ok };
}).sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));

const cardTypes = results.flatMap(result => result.created.map(item => item.cardType))
  .reduce<Record<string, number>>((all, type) => ({ ...all, [type]: (all[type] ?? 0) + 1 }), {});

const misbuilds = results.filter(result => result.misbuild);
const omissions = results.filter(result => result.omission);
const countMismatches = results.filter(result => !result.countMatch);
const multiRows = results.filter(result => result.expectedCreates >= 2);
const multiMatch = multiRows.filter(result => result.countMatch).length;
const singleRows = results.filter(result => result.expectedCreates >= 1);

const failures = results.filter(result => !result.contractOk || result.misbuild || result.omission || !result.countMatch)
  .map(result => ({
    index: result.index, text: result.text, kind: result.kind,
    expected: result.expectedNames, toolCalls: result.calls.map(call => ({ name: call.name, args: call.arguments })),
    createdCards: result.created.map(item => item.cardType),
    issues: [...result.issues, ...(result.envelopeIssue ? [`envelope: ${result.envelopeIssue}`] : [])],
    flags: [result.misbuild ? "误建" : "", result.omission ? "漏建" : "", !result.countMatch && !result.misbuild && !result.omission ? "条数不符" : ""].filter(Boolean),
  }));

// --- Adapter findings the mapper cannot hide -------------------------------
// Every weekly card is built for "next week"; the scene guard re-anchors the
// week from any 本周/下周 text on the canvas, so record what actually came out.
const weeklyCards = results.flatMap(result => result.created
  .filter(item => item.cardType === "WeeklyScheduleCard")
  .flatMap(item => {
    const action = result.actions.find(entry => entry.type === "card.create" && entry.card.id === item.id);
    if (action?.type !== "card.create") return [];
    const weekStart = typeof action.card.displayProps.weekStart === "string" ? action.card.displayProps.weekStart : null;
    const events = (action.card.displayProps.events as Array<Record<string, unknown>> | undefined) ?? [];
    return [{ index: result.index, text: result.text, tool: item.tool, weekStart, expectedNextMonday: NEXT_MONDAY, events }];
  }));

const weeklyAnchors = weeklyCards.map(card => ({
  index: card.index, text: card.text, tool: card.tool,
  weekStart: card.weekStart, expectedNextMonday: card.expectedNextMonday,
}));

const scheduleDates = weeklyCards.filter(card => card.tool === "create_schedule").map(card => {
  const event = card.events[0] ?? {};
  const day = typeof event.day === "number" ? event.day : null;
  const start = parseIso(card.weekStart ?? "");
  const eventDate = start && day ? isoOf(addDays(start, day - 1)) : null;
  const call = results[card.index - 1]!.calls.find(entry => entry.name === "create_schedule");
  const rawTime = typeof call?.arguments.time === "string" ? call.arguments.time : "";
  const period = rawTime.match(/凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|晚间/u)?.[0] ?? null;
  const title = event.title;
  return { index: card.index, text: card.text, weekStart: card.weekStart, day,
    start: typeof event.start === "string" ? event.start : null, eventDate,
    title, period,
    // "周四下午要去健身" must keep 下午 in the title when no clock was stated.
    periodDropped: Boolean(period) && typeof event.start !== "string" && !String(title ?? "").includes(period!),
    past: eventDate !== null && eventDate < TODAY_ISO };
});

/** Same 59 rows on canvases shaped like a real Control payload. */
const sensitivity = (["production", "weekday-note"] as const).map(variant => {
  const ctx = canvas(variant);
  const changed: Array<Record<string, unknown>> = [];
  return { variant, changed, checked: 0, ctx };
});
for (const entry of sensitivity) {
  for (const [index, row] of rows.entries()) {
    const plan = await planFromToolCalls(toCalls(row.actual), entry.ctx, NOW);
    const baseline = results[index]!;
    entry.checked += 1;
    if (plan.kind !== baseline.kind || plan.issues.join("|") !== baseline.issues.join("|")
      || plan.created.map(item => item.cardType).join(",") !== baseline.created.map(item => item.cardType).join(",")) {
      entry.changed.push({ index: index + 1, text: row.text, kind: plan.kind, issues: plan.issues });
    }
  }
}

const summary = {
  total,
  contractPass,
  contractPassRate: pct(contractPass, total),
  envelopeRows: envelopeRows.length,
  envelopeRevalidated,
  clarify: clarifyRows.length,
  chat: chatRows.length,
  invalid: invalidRows.length,
  misbuild: misbuilds.length,
  omission: omissions.length,
  countCorrect: total - countMismatches.length,
  countCorrectRate: pct(total - countMismatches.length, total),
  createRowsExpected: singleRows.length,
  multiRowsExpected: multiRows.length,
  multiCountCorrect: multiMatch,
  multiCountRate: pct(multiMatch, multiRows.length),
  cardTypes,
};

const json = {
  generatedAt: new Date().toISOString(),
  now: new Date(NOW).toISOString(),
  today: TODAY_ISO,
  nextMonday: NEXT_MONDAY,
  timeZone: ZONE,
  source: relative(REPO_ROOT, PROBE_PATH).replace(/\\/g, "/"),
  note: "planFromToolCalls only: no card is created, no network, no canvas mutation.",
  canvas: baseCanvas.cards.map(card => ({ id: card.id, type: card.type })),
  summary,
  tools,
  failures,
  findings: {
    weeklyAnchors,
    scheduleDates,
    sensitivity: sensitivity.map(entry => ({
      variant: entry.variant, checked: entry.checked, changed: entry.changed.length, rows: entry.changed,
    })),
  },
  rows: results.map(result => ({
    index: result.index, text: result.text, expected: result.expectedNames, toolCalls: result.callNames,
    kind: result.kind, created: result.created.map(item => item.cardType),
    actions: result.actions.map(action => action.type), issues: result.issues,
  })),
};

const md: string[] = [];
md.push("# Vivic 工具调用 dry-run 报告", "",
  `- 生成时间：${json.generatedAt}`,
  `- 输入：\`${json.source}\`（baseline 59 条已记录 tool_calls）`,
  `- 固定画布：${json.canvas.map(card => `${card.id}(${card.type})`).join("、")}`,
  `- 固定时钟：${json.now}，时区 ${ZONE}（今天 ${TODAY_ISO}，下周一 ${NEXT_MONDAY}）`,
  "- 边界：只调用纯函数 `planFromToolCalls`，不建卡、不联网、不改画布。", "",
  "## 总览", "",
  "| 指标 | 数值 |", "| --- | --- |",
  `| 总条数 | ${summary.total} |`,
  `| 契约通过（envelope 重校验通过 / clarify / chat） | ${summary.contractPass} / ${summary.total} = ${rate(summary.contractPass, summary.total)} |`,
  `| 其中 envelope 条数 / 重校验通过 | ${summary.envelopeRows} / ${summary.envelopeRevalidated} |`,
  `| clarify / chat / invalid | ${summary.clarify} / ${summary.chat} / ${summary.invalid} |`,
  `| 误建（期望不建卡却出卡） | ${summary.misbuild} |`,
  `| 漏建（期望出卡却没有卡） | ${summary.omission} |`,
  `| 多卡条数正确率（期望 ≥2 张） | ${summary.multiCountCorrect} / ${summary.multiRowsExpected} = ${rate(summary.multiCountCorrect, summary.multiRowsExpected)} |`,
  `| 全部出卡条数正确率 | ${summary.countCorrect} / ${summary.total} = ${rate(summary.countCorrect, summary.total)} |`, "",
  "## 各工具成功数", "",
  "| 工具 | 调用次数 | 成功 | 失败 |", "| --- | --- | --- | --- |");
for (const tool of tools) md.push(`| ${tool.name} | ${tool.calls} | ${tool.ok} | ${tool.failed} |`);
md.push("", "## 产生的卡型分布", "", "| 卡型 | 张数 |", "| --- | --- |");
for (const [type, count] of Object.entries(cardTypes).sort((a, b) => b[1] - a[1])) md.push(`| ${type} | ${count} |`);

md.push("", "## 失败明细", "");
if (!failures.length) md.push("无。");
for (const failure of failures) {
  md.push(`### #${failure.index} ${failure.text}`, "",
    `- 期望：${failure.expected.join(" + ") || "(无)"}`,
    `- 实际调用：${failure.toolCalls.map(call => `${call.name}(${JSON.stringify(call.args)})`).join(" + ") || "(无)"}`,
    `- 结果：${failure.kind}${failure.flags.length ? `（${failure.flags.join("、")}）` : ""}`,
    `- 产出卡：${failure.createdCards.join("、") || "无"}`,
    `- issues：${failure.issues.join("；") || "无"}`, "");
}

md.push("## 适配器观察（dry-run 发现）", "",
  "这些不是 59 条用例的失败，而是映射层与既有场景契约之间的接缝；记录供 lead 判断是否要改核心。", "",
  "### 周计划/日程的实际周锚点", "",
  "| # | 原话 | 工具 | weekStart | 期望下周一 |", "| --- | --- | --- | --- | --- |");
for (const anchor of weeklyAnchors) md.push(`| ${anchor.index} | ${anchor.text} | ${anchor.tool} | ${anchor.weekStart ?? "?"} | ${anchor.expectedNextMonday} |`);
md.push("", "### 日程落到的具体日期", "",
  "| # | 原话 | weekStart | day | start | 标题 | 实际日期 | 已过去 | 时段词丢失 |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const schedule of scheduleDates) {
  md.push(`| ${schedule.index} | ${schedule.text} | ${schedule.weekStart ?? "?"} | ${schedule.day ?? "?"} | ${schedule.start ?? "-"} | ${schedule.title ?? "-"} | ${schedule.eventDate ?? "?"} | ${schedule.past ? "是" : "否"} | ${schedule.periodDropped ? "是" : "否"} |`);
}
md.push("", "### 画布敏感度（同样 59 条，换画布）", "");
for (const entry of json.findings.sensitivity) {
  md.push(`- ${entry.variant}：${entry.changed} / ${entry.checked} 条结果变化` +
    (entry.changed ? `，受影响 #${entry.rows.map(row => row.index).join("、#")}` : ""), "");
  for (const row of entry.rows) md.push(`  - #${row.index} ${row.text} → ${row.kind}：${row.issues.join("；") || "无"}`);
}

md.push("", "## 结论", "",
  `1. 映射层本身稳定：59 条记录里 ${summary.contractPass} 条契约通过，误建 ${summary.misbuild} 条，多卡条数 ${summary.multiCountCorrect}/${summary.multiRowsExpected} 正确。`,
  `2. 唯一漏建 #45 是探针记录里模型自己返回了 clarify（probe 的 nameOk=false），不是映射器丢卡。`,
  `3. create_weekly_plan 的周锚点被画布文案带偏：${weeklyAnchors.filter(anchor => anchor.tool === "create_weekly_plan" && anchor.weekStart !== anchor.expectedNextMonday).length}/${weeklyAnchors.filter(anchor => anchor.tool === "create_weekly_plan").length} 张周计划落在本周（${weeklyAnchors[0]?.weekStart ?? "?"}）而不是下周（${NEXT_MONDAY}）。`,
  `4. create_weekly_plan 在真实画布上会整批 invalid：production / weekday-note 两种画布各 ${json.findings.sensitivity.map(entry => entry.changed).join(" / ")} 条（#14、#15、#47）变成「星期不在用户的话里」。`,
  `5. create_schedule 只认“周X”，不认“明天/下周一”：#39 明天→${scheduleDates.find(row => row.index === 39)?.eventDate ?? "?"}（今天），#40 下周一→${scheduleDates.find(row => row.index === 40)?.eventDate ?? "?"}（本周，已过去）。`,
  `6. create_schedule 在没有钟点时丢掉时段词：${scheduleDates.filter(row => row.periodDropped).map(row => `#${row.index}`).join("、") || "无"}。`,
  "", "## 附：59 条逐条结果", "",
  "| # | 原话 | 期望 | 实际调用 | kind | 产出卡 |", "| --- | --- | --- | --- | --- | --- |");
for (const row of json.rows) {
  md.push(`| ${row.index} | ${row.text.replace(/\|/g, "\\|")} | ${row.expected.join(" + ") || "-"} | ${row.toolCalls.join(" + ") || "-"} | ${row.kind} | ${row.created.join("、") || "-"} |`);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "dry-run.json"), `${JSON.stringify(json, null, 2)}\n`, "utf8");
writeFileSync(join(OUT_DIR, "dry-run-report.md"), `${md.join("\n")}\n`, "utf8");

console.log(`dry-run: ${summary.contractPass}/${summary.total} 契约通过 (${rate(summary.contractPass, summary.total)}), ` +
  `误建 ${summary.misbuild}, 漏建 ${summary.omission}, 多卡条数 ${summary.multiCountCorrect}/${summary.multiRowsExpected}`);
console.log(`report: ${join(OUT_DIR, "dry-run-report.md")}`);
