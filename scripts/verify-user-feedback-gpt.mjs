// Uses only an already connected Vivic/Pi OAuth provider. No credential reads,
// new login, microphone, audio or user-canvas changes.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
const requireApi = createRequire(new URL("../apps/local-api/package.json", import.meta.url));
const base = process.env.VIVIC_VERIFY_URL ?? "http://localhost:5175";
const dir = new URL(`../evidence/user-feedback-gpt-${new Date().toISOString().replace(/[:.]/g, "-")}/`, import.meta.url);
await mkdir(dir, { recursive: true });
const report = { startedAt: new Date().toISOString(), isolatedContext: true, audio: false, microphone: false, cases: [] };
const save = () => writeFile(new URL("gpt.json", dir), JSON.stringify(report, null, 2));
async function post(path, data) { const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data), signal: AbortSignal.timeout(95000) }); assert(r.ok, `HTTP ${r.status}`); return r.json(); }
const status = await (await fetch(base + "/api/providers/status")).json();
const provider = status.providers.find(p => p.name === "gpt");
assert(provider?.connected, "Restore the existing GPT login in the application first");
report.model = provider.defaultModel; report.source = provider.source;
const context = { canvasId: "TEST-gpt-feedback", timeZone: "Asia/Shanghai", stage: "WORKSPACE", viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], cards: [] };
async function check(id, text, verify, attachments) {
  const row = { id, input: text, ok: false }, began = performance.now();
  try { row.result = await post("/api/intent", { text, canvasContext: context, ...(attachments ? { attachments } : {}) }); assert.equal(row.result.kind, "envelope", row.result.message); verify(row.result); row.ok = true; }
  catch (error) { row.error = String(error); }
  row.ms = Math.round(performance.now() - began); report.cases.push(row); await save(); console.log(JSON.stringify({ id, ok: row.ok, ms: row.ms, error: row.error }));
}
try {
  await post("/api/providers/select", { provider: "gpt" });
  await check("gpt-conversation", "你好，能帮我做些什么？", r => { assert.equal(r.usedProvider, "gpt"); assert(r.envelope.spokenText.length > 3); });
  await check("gpt-three-reminders", "请安排三个提醒：八分钟后喝水，十分钟后休息，十三分钟后开会。", r => { assert.equal(r.usedProvider, "gpt"); const cards = r.envelope.actions.filter(a => a.type === "card.create").map(a => a.card); assert.deepEqual(cards.map(c => c.sourceData.reminderText), ["喝水", "休息", "开会"]); assert.deepEqual(cards.map(c => (Date.parse(c.sourceData.targetAt) - Date.parse(c.sourceData.startedAt)) / 1000), [480,600,780]); });
  await check("gpt-search", "搜索 React Flow 官方文档", r => { assert.equal(r.usedProvider, "search"); assert(r.envelope.actions.some(a => a.type === "card.create" && a.card.sources.some(s => s.provider === "pi-web-access/gpt-oauth"))); });
  if (provider.capabilities.includes("vision")) {
    const bytes = await requireApi("sharp")(Buffer.from('<svg width="400" height="160" xmlns="http://www.w3.org/2000/svg"><rect width="400" height="160" fill="white"/><text x="20" y="40" font-family="Arial" font-size="24">TEST</text><text x="20" y="112" font-family="Arial" font-size="54">17 + 26</text></svg>')).png().toBuffer();
    await check("gpt-vision", "读取图片里的算式并算出结果，创建一张简短便笺。", r => { assert.equal(r.usedProvider, "gpt"); assert(r.envelope.actions.some(a => a.type === "card.create" && a.card.type === "NoteCard" && JSON.stringify(a.card.displayProps).includes("43"))); }, [{ type: "image", mime: "image/png", data: bytes.toString("base64") }]);
    await check("gpt-no-stale-image", "记一张便笺：图片测试结束。", r => { assert(!JSON.stringify(r.envelope).includes("43")); });
  }
} finally { await post("/api/providers/select", { provider: status.activeProvider ?? "stepfun" }); report.completedAt = new Date().toISOString(); report.ok = report.cases.every(c => c.ok); await save(); }
console.log(JSON.stringify({ ok: report.ok, total: report.cases.length, evidence: dir.pathname }));
process.exitCode = report.ok ? 0 : 1;
