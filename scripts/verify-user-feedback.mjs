// Real-service regression. Synthetic TEST contexts only; no credentials,
// microphone, audio playback or user browser storage are read or recorded.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const base = process.env.VIVIC_VERIFY_URL ?? "http://localhost:5175";
const dir = new URL(`../evidence/user-feedback-${new Date().toISOString().replace(/[:.]/g, "-")}/`, import.meta.url);
await mkdir(dir, { recursive: true });
const report = { startedAt: new Date().toISOString(), base, mode: "real API, synthetic context", cases: [] };
const save = () => writeFile(new URL("api.json", dir), JSON.stringify(report, null, 2));
const context = { canvasId: "TEST-feedback", timeZone: "Asia/Shanghai", stage: "WORKSPACE", viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], cards: [] };
async function check(id, text, verify, extra = {}) {
  const out = { id, input: text, ok: false }, began = performance.now();
  try {
    const response = await fetch(base + "/api/intent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, canvasContext: context, ...extra }), signal: AbortSignal.timeout(95000) });
    out.http = response.status; out.result = await response.json();
    assert.equal(out.http, 200); await verify(out.result); out.ok = true;
  } catch (error) { out.error = String(error); }
  out.ms = Math.round(performance.now() - began); report.cases.push(out); await save();
  console.log(JSON.stringify({ id, ok: out.ok, ms: out.ms, kind: out.result?.kind, message: out.result?.message, error: out.error }));
  return out.result;
}
const created = (result, type) => {
  assert.equal(result.kind, "envelope", result.message);
  const card = result.envelope.actions.find(a => a.type === "card.create" && a.card.type === type)?.card;
  assert(card, `Expected ${type}`); return card;
};
function remember(card) { context.cards.push({ id: card.id, type: card.type, aliases: card.metadata.aliases, displayProps: card.displayProps, sourceDataSummary: card.sourceData, layout: { x: card.layout.x, y: card.layout.y } }); }
const status = await (await fetch(base + "/api/providers/status")).json();
report.connection = { activeProvider: status.activeProvider, providers: status.providers.map(p => ({ name: p.name, connected: p.connected, model: p.defaultModel })) };
await check("note-exact", "记一张便笺：今天只做一件事，先把基础体验做好。", r => { const card = created(r, "NoteCard"); assert.equal(card.displayProps.text, "今天只做一件事，先把基础体验做好。"); });
await check("reply-real-model", "你好，能帮我做些什么？", r => { assert.equal(r.kind, "envelope", r.message); assert.equal(r.usedProvider, status.activeProvider); assert(r.envelope.spokenText?.length > 3); });
await check("C1", "明天上午9点提醒我开会", r => created(r, "CountdownCard"));
await check("C2", "每天09:00提醒我喝水", r => assert.equal(created(r, "CountdownCard").sourceData.schedule.kind, "calendar"));
await check("C3", "工作日09:00提醒我开始工作", r => assert.deepEqual(created(r, "CountdownCard").sourceData.schedule.weekdays, [1,2,3,4,5]));
await check("C4", "每周一、三、五下午3点提醒我休息", r => assert.deepEqual(created(r, "CountdownCard").sourceData.schedule.weekdays, [1,3,5]));
await check("C5", "纽约时间明天上午9点提醒我参加电话会议", r => assert.equal(created(r, "CountdownCard").sourceData.timeZone, "America/New_York"));
await check("C6", "每隔20秒提醒我活动一下", r => { const card = created(r, "CountdownCard"); assert.equal(card.sourceData.schedule.everySeconds, 20); remember(card); });
await check("C7", "暂停活动一下提醒", r => { assert.equal(r.kind, "envelope", r.message); assert(r.envelope.actions.some(a => a.type === "card.update" && a.sourceData?.pausedAt)); });
await check("D1", "添加待办：完成条件测试", r => remember(created(r, "TodoCard")));
await check("D2", "当待办第1项完成后5秒提醒我休息", r => assert.equal(created(r, "CountdownCard").sourceData.condition.kind, "todo.completed"));
await check("D3", "把待办第1项标记为完成", r => { assert.equal(r.kind, "envelope", r.message); assert(r.envelope.actions.some(a => a.type === "card.update" && a.displayProps?.items?.[0]?.done)); });
await check("D4", "一分钟倒计时", r => { const card = created(r, "CountdownCard"); context.cards = context.cards.filter(c => c.type !== "CountdownCard"); remember(card); });
await check("D5", "当倒计时结束后提醒我检查结果", r => assert.equal(created(r, "CountdownCard").sourceData.condition.kind, "countdown.completed"));
await check("E1", "给我创建一个表格", r => { context.cards = []; remember(created(r, "TableCard")); });
await check("E2", "周一3，周二5，周三4", r => { const a = r.envelope?.actions.find(a => a.type === "card.update"); assert.equal(r.kind, "envelope", r.message); assert.deepEqual(a?.displayProps?.rows?.map(row => row[1]), [3,5,4]); });
await check("E4", "折线图：周一3，周二5，周三4", r => created(r, "ChartCard"));
await check("E5", "饼图：苹果3，香蕉5，橙子4", r => created(r, "ChartCard"));
await check("E6", "饼图：苹果-3，香蕉5", r => { assert.equal(r.kind, "clarify"); assert.match(r.message, /负/); });
await check("weather-real", "上海天气", r => { const card = created(r, "WeatherCard"); assert(card.sources.some(s => s.provider === "open-meteo/forecast")); });
await check("weather-natural", "上海现在多少度", r => { const card = created(r, "WeatherCard"); assert(card.sources.some(s => s.provider === "open-meteo/forecast")); });
await check("search-real", "搜索三个开源 React 画布库并比较", r => { created(r, "SearchResultCard"); assert.equal(r.usedProvider, "search"); });
await check("search-natural", "帮我找几个开源的 React 画布库", r => { created(r, "SearchResultCard"); assert.equal(r.usedProvider, "search"); });
await check("article-real", "阅读网页 https://example.com", r => { const card = created(r, "SearchResultCard"); assert(card.sources.some(s => s.readFullPage)); });
await check("article-private-refused", "阅读网页 http://127.0.0.1:8787/healthz", r => { assert.notEqual(r.kind, "envelope"); });
report.completedAt = new Date().toISOString(); report.ok = report.cases.every(c => c.ok); await save();
console.log(JSON.stringify({ ok: report.ok, total: report.cases.length, evidence: dir.pathname }));
process.exitCode = report.ok ? 0 : 1;
