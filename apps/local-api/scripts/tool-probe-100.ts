import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { TOOL_DEFINITIONS, buildToolSystemPrompt } from "../src/intent/toolCalls.js";
import type { CanvasContext } from "../src/schemas.js";

/**
 * Real-model 100-case probe for the conversational tool-calling experiment.
 * Local only: calls the DeepSeek API directly, never the Vivic server.
 * `DEEPSEEK_API_KEY` is read from the environment and never written to disk.
 */

const KEY = process.env.DEEPSEEK_API_KEY;
if (!KEY) {
  console.error("DEEPSEEK_API_KEY missing");
  process.exit(1);
}
const BASE = process.env.VIVIC_DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1";
const MODEL = process.env.VIVIC_DEEPSEEK_MODEL ?? "deepseek-chat";
const WORKSPACE = resolve(import.meta.dirname, "../../../../..");
const CASES_PATH = resolve(WORKSPACE, "work/tool-calling-product/cases-100.json");
const OUT_DIR = resolve(WORKSPACE, "work/tool-calling-product");

interface ExpectedCall { name: string; args: Record<string, unknown> }
interface Case { id: string; text: string; expected: ExpectedCall[]; tags?: string[]; note?: string }
interface ActualCall { name: string; arguments: Record<string, unknown> }

const ctx: CanvasContext = {
  canvasId: "canvas_tool_probe",
  stage: "WORKSPACE",
  viewport: { x: 0, y: 0, zoom: 1 },
  focusHistory: ["note_meeting"],
  timeZone: "Asia/Shanghai",
  cards: [
    { id: "note_meeting", type: "NoteCard", aliases: ["会议记录"], displayProps: { text: "会议记录" }, sourceDataSummary: {}, layout: { x: 0, y: 0, width: 320, height: 120 } },
    { id: "note_shopping", type: "NoteCard", aliases: ["购物便笺"], displayProps: { text: "购物便笺" }, sourceDataSummary: {}, layout: { x: 344, y: 0, width: 320, height: 120 } },
    { id: "todo_week", type: "TodoCard", aliases: ["本周待办"], displayProps: { title: "本周待办" }, sourceDataSummary: {}, layout: { x: 688, y: 0, width: 288, height: 160 } },
    { id: "countdown_tea", type: "CountdownCard", aliases: ["泡茶 5 分钟"], displayProps: {}, sourceDataSummary: {}, layout: { x: 1000, y: 0, width: 220, height: 220 } },
  ],
};

const SYSTEM = buildToolSystemPrompt(ctx);

interface RawResponse {
  choices?: Array<{ message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }>;
  error?: { message?: string };
}

const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

async function callOnce(text: string): Promise<{ calls: ActualCall[]; ms: number; error?: string }> {
  const started = Date.now();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: "system", content: SYSTEM }, { role: "user", content: text }],
          tools: TOOL_DEFINITIONS,
          tool_choice: "auto",
          temperature: 0,
          max_tokens: 512,
        }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      if (attempt === 2) return { calls: [], ms: Date.now() - started, error: `transport: ${String(error)}` };
      await sleep(800 * (attempt + 1));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt === 2) return { calls: [], ms: Date.now() - started, error: `HTTP ${res.status}` };
      await sleep(1500 * (attempt + 1));
      continue;
    }
    if (!res.ok) return { calls: [], ms: Date.now() - started, error: `HTTP ${res.status}` };
    const body = (await res.json()) as RawResponse;
    const raw = body.choices?.[0]?.message?.tool_calls ?? [];
    const calls: ActualCall[] = [];
    for (const item of raw) {
      const name = item.function?.name;
      if (!name) continue;
      let args: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(item.function?.arguments ?? "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
      } catch { /* keep empty args, judged as wrong */ }
      calls.push({ name, arguments: args });
    }
    return { calls, ms: Date.now() - started };
  }
  return { calls: [], ms: Date.now() - started, error: "unreachable" };
}

const norm = (value: unknown) => String(value ?? "").replace(/\s+/gu, "").trim();

function argsMatch(expected: ExpectedCall, actual: ActualCall): boolean {
  if (expected.name !== actual.name) return false;
  const want = expected.args ?? {};
  const got = actual.arguments ?? {};
  switch (expected.name) {
    case "create_countdown": {
      if (Math.abs(Number(want.minutes) - Number(got.minutes)) > 1e-6) return false;
      if (want.text !== undefined && norm(want.text) !== norm(got.text)) return false;
      return true;
    }
    case "create_todo": {
      const a = (want.items as string[]).map(norm);
      const b = ((got.items as string[]) ?? []).map(norm);
      return a.length === b.length && a.every(item => b.includes(item));
    }
    case "create_note":
      return norm(want.text) === norm(got.text);
    case "create_weekly_plan":
      return norm(want.topic).length > 0 && (norm(got.topic).includes(norm(want.topic)) || norm(want.topic).includes(norm(got.topic)));
    case "create_schedule": {
      if (norm(want.title) !== norm(got.title)) return false;
      if (want.day !== undefined && norm(want.day) !== norm(got.day)) return false;
      if (want.time !== undefined && norm(want.time) !== norm(got.time)) return false;
      return true;
    }
    case "focus_card":
      return norm(want.card_id) === norm(got.card_id);
    case "clarify":
      return norm(got.question).length > 0;
    default:
      return true;
  }
}

const cases = JSON.parse(readFileSync(CASES_PATH, "utf8")) as Case[];
console.log(`loaded ${cases.length} cases from ${CASES_PATH}`);

const rows: Array<Record<string, unknown>> = [];
for (const [index, testCase] of cases.entries()) {
  const { calls, ms, error } = await callOnce(testCase.text);
  const nameOk = calls.length === testCase.expected.length && testCase.expected.every((want, position) => calls[position]?.name === want.name);
  const argsOk = nameOk && testCase.expected.every((want, position) => argsMatch(want, calls[position]!));
  rows.push({ id: testCase.id, text: testCase.text, tags: testCase.tags ?? [], expected: testCase.expected,
    actual: calls, ms, error, nameOk, argsOk, multi: testCase.expected.length >= 2 });
  console.log(`${String(index + 1).padStart(3)}/${cases.length} ${testCase.id} ${nameOk ? "name" : "NAME"} ${argsOk ? "args" : "ARGS"} ${ms}ms ${error ?? ""}`);
  await sleep(120);
}

const total = rows.length;
const nameOkCount = rows.filter(row => row.nameOk).length;
const argsOkCount = rows.filter(row => row.argsOk).length;
const multiRows = rows.filter(row => row.multi);
const multiOk = multiRows.filter(row => row.argsOk).length;
const errors = rows.filter(row => row.error).length;
const latencies = rows.map(row => Number(row.ms)).sort((a, b) => a - b);
const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
const p90 = latencies[Math.floor(latencies.length * 0.9)] ?? 0;
const byTag: Record<string, { total: number; nameOk: number; argsOk: number }> = {};
for (const row of rows) {
  for (const tag of row.tags as string[]) {
    const bucket = (byTag[tag] ??= { total: 0, nameOk: 0, argsOk: 0 });
    bucket.total += 1;
    if (row.nameOk) bucket.nameOk += 1;
    if (row.argsOk) bucket.argsOk += 1;
  }
}

const summary = { ranAt: new Date().toISOString(), model: MODEL, total, nameOk: nameOkCount, argsOk: argsOkCount,
  multi: multiRows.length, multiOk, errors, p50, p90, byTag, rows };
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(resolve(OUT_DIR, "results-100.json"), JSON.stringify(summary, null, 2));

const failures = rows.filter(row => !row.argsOk);
const markdown = [
  "# 工具调用 100 条真实模型探针（本地）",
  "",
  `- 运行时间：${summary.ranAt}`,
  `- 模型：${MODEL}（DeepSeek 官方直连）`,
  `- 用例：${total}`,
  `- 工具序列正确：**${nameOkCount}/${total} = ${(nameOkCount / total * 100).toFixed(1)}%**`,
  `- 参数正确：**${argsOkCount}/${total} = ${(argsOkCount / total * 100).toFixed(1)}%**`,
  `- 多卡（≥2 调用）：**${multiOk}/${multiRows.length}**`,
  `- 请求错误：${errors}`,
  `- 延迟：P50 ${p50}ms / P90 ${p90}ms`,
  "",
  "## 失败明细",
  "",
  "| id | 原话 | 期望 | 实际 |",
  "|---|---|---|---|",
  ...failures.map(row => `| ${row.id} | ${String(row.text).replace(/\|/gu, "\\|")} | ${JSON.stringify(row.expected)} | ${JSON.stringify(row.actual)} |`),
  "",
  "## 分 tag",
  "",
  "| tag | 总数 | 序列 | 参数 |",
  "|---|---:|---:|---:|",
  ...Object.entries(byTag).sort((a, b) => b[1].total - a[1].total).map(([tag, value]) => `| ${tag} | ${value.total} | ${value.nameOk} | ${value.argsOk} |`),
].join("\n");
writeFileSync(resolve(OUT_DIR, "REPORT-100.md"), markdown);
console.log(`\nname ${nameOkCount}/${total}, args ${argsOkCount}/${total}, multi ${multiOk}/${multiRows.length}, errors ${errors}`);
console.log(`wrote ${resolve(OUT_DIR, "results-100.json")} and REPORT-100.md`);
