/** Explicit real-service acceptance after user-completed Vivic OAuth.
 * API-only synthetic context: no browser storage, dispatch, audio or microphone. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
const requireApi = createRequire(new URL("../apps/local-api/package.json", import.meta.url));
const sharp = requireApi("sharp");
const base = "http://localhost:5173";
const dir = new URL(`../evidence/manual-feedback/live-${new Date().toISOString().replace(/[:.]/g, "-")}/`, import.meta.url);
await mkdir(dir, { recursive: true });
const context = { canvasId: "TEST-manual-feedback", stage: "WORKSPACE", viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], cards: [] };
const report = { startedAt: new Date().toISOString(), source: "Application API; user completed new authorization, using current Vivic login", canvasPersisted: false, audio: false, microphone: false, cases: [] };
const save = () => writeFile(new URL("report.json", dir), JSON.stringify(report, null, 2));
async function request(path, body) {
  const response = await fetch(base + path, { ...(body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(95000) });
  assert(response.ok, `HTTP ${response.status}`); return response.json();
}
const only = process.argv.find(value => value.startsWith("--only="))?.slice(7);
async function check(name, text, verify, attachments) {
  if (only && name !== only) return;
  const out = { name, input: text, ok: false }; const start = performance.now();
  try { const result = await request("/api/intent", { text, canvasContext: context, ...(attachments ? { attachments } : {}) });
    out.result = result; assert.equal(result.kind, "envelope", result.message); await verify(result); out.ok = true;
  } catch (error) { out.error = String(error); }
  out.ms = Math.round(performance.now() - start); report.cases.push(out); await save();
  console.log(JSON.stringify({ name, ok: out.ok, ms: out.ms, error: out.error }));
}
const status = await request("/api/providers/status");
const gpt = status.providers.find(provider => provider.name === "gpt");
assert.equal(status.activeProvider, "gpt"); assert.equal(gpt?.connected, true); assert.equal(gpt.source, "vivic");
report.model = gpt.defaultModel; report.authentication = { connected: true, source: gpt.source };
await check("real-gpt-note", "请把这次测试结论记成一张简短便笺：GPT 人工登录验证完成。", result => {
  assert.equal(result.usedProvider, "gpt"); assert(result.envelope.actions.some(action => action.type === "card.create" && action.card.type === "NoteCard" && JSON.stringify(action.card.displayProps).includes("验证")));
});
await check("real-gpt-three-reminders", "请安排三个提醒：八分钟后喝水，十分钟后休息，十三分钟后开会。", result => {
  assert.equal(result.usedProvider, "gpt"); const cards = result.envelope.actions.filter(action => action.type === "card.create").map(action => action.card);
  assert.equal(cards.length, 3); assert.deepEqual(cards.map(card => card.sourceData.reminderText), ["喝水", "休息", "开会"]);
  assert.deepEqual(cards.map(card => (Date.parse(card.sourceData.targetAt) - Date.parse(card.sourceData.startedAt)) / 1000), [480, 600, 780]);
});
await check("real-gpt-search", "搜索 React Flow 官方文档", result => {
  assert.equal(result.usedProvider, "search"); assert(result.envelope.actions.some(action => action.type === "card.create" && action.card.sources.some(source => source.provider === "pi-web-access/gpt-oauth")));
});
if (gpt.capabilities.includes("vision")) {
  const bytes = await sharp(Buffer.from('<svg width="400" height="160" xmlns="http://www.w3.org/2000/svg"><rect width="400" height="160" fill="white"/><text x="20" y="40" font-family="Arial" font-size="24" fill="black">TEST</text><text x="20" y="112" font-family="Arial" font-size="54" fill="black">17 + 26</text></svg>')).png().toBuffer();
  await check("real-gpt-image", "读取图片里的算式并算出结果，创建一张简短便笺。", result => {
    assert.equal(result.usedProvider, "gpt"); assert(result.envelope.actions.some(action => action.type === "card.create" && action.card.type === "NoteCard" && JSON.stringify(action.card.displayProps).includes("43")));
    assert(!JSON.stringify(result.envelope).includes(bytes.toString("base64")));
  }, [{ type: "image", mime: "image/png", data: bytes.toString("base64") }]);
}
await check("live-shanghai-direct", "上海天气", result => {
  const card = result.envelope.actions.find(action => action.type === "card.create" && action.card.type === "WeatherCard")?.card;
  assert(card && card.sourceData.location.admin1 === "上海市" && card.sources.some(source => source.provider === "open-meteo/forecast"));
});
await check("blank-table-without-model", "给我创建一个表格", result => {
  assert.equal(result.usedProvider, "rules"); assert(result.envelope.actions.some(action => action.type === "card.create" && action.card.type === "TableCard" && action.card.displayProps.rows.length === 0));
});
report.completedAt = new Date().toISOString(); report.ok = report.cases.every(item => item.ok); await save();
console.log(JSON.stringify({ ok: report.ok, cases: report.cases.length, evidence: dir.pathname }));
process.exitCode = report.ok ? 0 : 1;
