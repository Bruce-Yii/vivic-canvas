// Explicit real-service UI acceptance in a disposable browser context.
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const requireWeb = createRequire(new URL("../apps/web/package.json", import.meta.url));
const { chromium, expect } = requireWeb("@playwright/test");
const base = process.env.VIVIC_VERIFY_URL ?? "http://localhost:5175";
const dir = new URL(`../evidence/user-feedback-browser-${new Date().toISOString().replace(/[:.]/g, "-")}/`, import.meta.url);
await mkdir(dir, { recursive: true });
const report = { startedAt: new Date().toISOString(), base, physicalAudio: false, physicalMicrophone: false, isolatedStorage: true, cases: [], pageErrors: [] };
const save = () => writeFile(new URL("browser.json", dir), JSON.stringify(report, null, 2));
const browser = await chromium.launch({ headless: true, args: ["--mute-audio"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: new URL("video/", dir).pathname, size: { width: 1440, height: 900 } } });
await context.addInitScript(() => {
  localStorage.setItem("vivic.voice.providers.v1", JSON.stringify({ stt: "none", tts: "none", browserVoice: "" }));
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => { throw new Error("Physical microphone forbidden"); };
});
const page = await context.newPage(), display = await context.newPage();
for (const tab of [page, display]) tab.on("pageerror", e => report.pageErrors.push(e.message));
const state = () => page.evaluate(() => window.__vivic.getState());
const records = async type => (await state()).cards.filter(c => !c.exitingRequestId && (!type || c.record.type === type)).map(c => c.record);
const feedback = page.locator("[data-vivic-command-feedback]");
async function expectCentered(id) {
  await expect.poll(async () => { const box = await display.locator(`[data-card-id="${id}"]`).boundingBox(); return box ? Math.max(Math.abs(box.x + box.width / 2 - 720), Math.abs(box.y + box.height / 2 - 450)) : 10000; }).toBeLessThan(35);
}
let latestResponse;
page.on("response", response => { if (response.url().endsWith("/api/intent")) latestResponse = response.json().catch(() => undefined); });
async function send(text) {
  latestResponse = undefined;
  await page.locator("[data-vivic-command-input]").fill(text);
  await page.locator("[data-vivic-command-input]").press("Enter");
  await expect(page.locator("[data-vivic-command-input]")).toHaveValue("");
  await expect(feedback).toHaveAttribute("aria-busy", "false", { timeout: 105000 });
  return { feedback: await feedback.textContent(), response: latestResponse ? await latestResponse : undefined };
}
async function check(id, input, verify) {
  const row = { id, input, ok: false }, began = performance.now();
  try { if (input) Object.assign(row, await send(input)); await verify(row); row.ok = true; }
  catch (error) { row.error = String(error); await display.screenshot({ path: new URL(`${id}-failure.png`, dir).pathname }).catch(() => {}); }
  row.ms = Math.round(performance.now() - began); report.cases.push(row); await save();
  console.log(JSON.stringify({ id, ok: row.ok, ms: row.ms, feedback: row.feedback, error: row.error }));
}
async function fresh(name) {
  const id = await page.evaluate(name => { const id = window.__vivicControl.createCanvas("TEST " + name); window.__vivicControl.switchCanvas(id); return id; }, name);
  await expect.poll(() => records().then(cards => cards.length)).toBe(0);
  await expect.poll(() => display.evaluate(() => window.__vivic?.getState().cards.length)).toBe(0);
  return id;
}
try {
  await page.goto(base + "/control"); await expect(page).toHaveTitle("Vivic");
  await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "owner");
  const connection = await (await context.request.get(base + "/api/providers/status")).json();
  report.provider = connection.activeProvider; report.model = connection.providers.find(p => p.name === connection.activeProvider)?.defaultModel;
  assert(connection.providers.find(p => p.name === connection.activeProvider)?.connected, "Connect a real model first");
  await display.goto(base + "/display");
  await expect(display.locator("[data-vivic-stage]")).toBeVisible();
  await fresh("A 基础");
  await check("A1", "十分钟倒计时", async () => { await expect(display.locator("[data-card-id]")).toHaveCount(1); assert.match(await display.locator("[data-card-id]").innerText(), /^\d{2}:\d{2}$/); await expectCentered((await records("CountdownCard"))[0].id); });
  await check("A2", "添加待办：买菜；回复邮件；完成测试", async () => { const todo = (await records("TodoCard"))[0]; assert.equal(todo.displayProps.items.length, 3); assert.equal((await state()).focus.cardId, todo.id); await expectCentered(todo.id); });
  await check("A3", "把待办第2项标记为完成", async () => assert.equal((await records("TodoCard"))[0].displayProps.items[1].done, true));
  await check("A4", "把待办第2项标记为未完成", async () => assert.equal((await records("TodoCard"))[0].displayProps.items[1].done, false));
  await check("A5", "高亮待办第二项", async () => assert.equal((await state()).highlight.itemId, (await records("TodoCard"))[0].displayProps.items[1].id));
  await check("A6", "聚焦待办", async () => assert.equal((await state()).focus.cardId, (await records("TodoCard"))[0].id));
  await check("A7", "恢复原视图", async () => assert.equal((await state()).focus, null));
  await check("A8", "展示所有卡片", async () => { assert.equal((await state()).focus, null); await expect(display.locator("[data-card-id]")).toHaveCount(2); });
  await check("A9", "重新排布居中", async row => assert.match(row.feedback, /已重新排布/));
  await check("connection-new-canvas", null, async () => { await fresh("新画布保留连接"); const status = await (await context.request.get(base + "/api/providers/status")).json(); assert(status.providers.find(p => p.name === report.provider).connected); });
  await check("conversation", "你好，能帮我做些什么？", async row => { assert.equal(row.response.kind, "envelope"); assert(row.feedback.length > 5); assert.doesNotMatch(row.feedback, /不支持|还不会/); assert.equal((await records()).length, 0); });
  await fresh("B 提醒");
  await check("B1", "八分钟后提醒我喝水，十分钟后提醒我休息，十三分钟后提醒我开会", async () => { await expect(display.locator("[data-vivic-reminder-row]")).toHaveCount(3); await expect(display.locator(".vivic-countdown")).toHaveCount(0); });
  await check("B2", "删除十三分钟倒计时", async () => assert.equal((await records("CountdownCard")).length, 2));
  await check("B3", "撤销", async () => assert.equal((await records("CountdownCard")).length, 3));
  await check("B4", "暂停喝水提醒", async () => assert((await records("CountdownCard")).find(c => c.sourceData.reminderText === "喝水").sourceData.pausedAt));
  await check("B5", "继续喝水提醒", async () => assert(!(await records("CountdownCard")).find(c => c.sourceData.reminderText === "喝水").sourceData.pausedAt));
  await check("B6", "高亮开会提醒", async () => assert.equal((await state()).highlight.cardId, (await records("CountdownCard")).find(c => c.sourceData.reminderText === "开会").id));
  await check("B7", "删除休息提醒", async () => assert.equal((await records("CountdownCard")).length, 2));
  await check("B8", "撤销", async () => assert.equal((await records("CountdownCard")).length, 3));
  await check("B9", "15秒后提醒我测试到时", async () => {
    await expect(display.locator("[data-vivic-reminder-alert]")).toContainText("测试到时", { timeout: 20000 });
    await expect(display.locator("[data-vivic-reminder-glow=true]")).toBeVisible();
    await expect.poll(() => display.locator("[data-vivic-reminder-glow=true]").evaluate(el => Number(getComputedStyle(el).opacity))).toBeGreaterThan(0.99);
    await expect(display.locator("[data-vivic-reminder-list]")).not.toContainText("测试到时");
    assert((await records("CountdownCard")).find(c => c.sourceData.reminderText === "测试到时").sourceData.notifiedAt);
    await display.screenshot({ path: new URL("due-reminder.png", dir).pathname });
  });
  await fresh("C 计划");
  await check("C1", "明天上午9点提醒我开会", async () => { assert((await records("CountdownCard"))[0].sourceData.timeZone); await expect(display.locator("[data-card-id]")).toHaveCount(0); });
  await check("C2", "每天09:00提醒我喝水", async () => assert.equal((await records("CountdownCard"))[1].sourceData.schedule.kind, "calendar"));
  await check("C3", "工作日09:00提醒我开始工作", async () => assert.deepEqual((await records("CountdownCard"))[2].sourceData.schedule.weekdays, [1,2,3,4,5]));
  await check("C4", "每周一、三、五下午3点提醒我休息", async () => assert.deepEqual((await records("CountdownCard"))[3].sourceData.schedule.weekdays, [1,3,5]));
  await check("C5", "纽约时间明天上午9点提醒我参加电话会议", async () => assert.equal((await records("CountdownCard"))[4].sourceData.timeZone, "America/New_York"));
  await check("C-long", "两小时后提醒我检查报告", async () => { const card = (await records("CountdownCard")).at(-1); await expect(display.locator(`[data-vivic-reminder-row="${card.id}"]`)).toHaveCount(0); assert.notEqual((await state()).focus?.cardId, card.id); });
  await check("C6", "每隔5秒提醒我活动一下", async () => { const card = (await records("CountdownCard")).at(-1); await expect.poll(async () => (await state()).cards.find(c => c.record.id === card.id).record.sourceData.lastFiredAt, { timeout: 9000 }).toBeTruthy(); const first = (await records("CountdownCard")).at(-1).sourceData.lastFiredAt; await expect.poll(async () => (await records("CountdownCard")).at(-1).sourceData.lastFiredAt, { timeout: 9000 }).not.toBe(first); });
  await check("C7", "暂停活动一下提醒", async () => assert((await records("CountdownCard")).at(-1).sourceData.pausedAt));
  await fresh("D 条件");
  await check("D1", "添加待办：完成条件测试", async () => assert.equal((await records("TodoCard")).length, 1));
  await check("D2", "当待办第1项完成后5秒提醒我休息", async () => { const card = (await records("CountdownCard"))[0]; assert.equal(card.sourceData.condition.kind, "todo.completed"); await expect(display.locator("[data-vivic-reminder-row]")).toHaveCount(0); });
  await check("D3", "把待办第1项标记为完成", async () => { await expect(display.locator("[data-vivic-reminder-alert]")).toContainText("休息", { timeout: 9000 }); assert((await records("CountdownCard"))[0].sourceData.notifiedAt); });
  await check("D4", "5秒倒计时", async () => assert.equal((await records("CountdownCard")).length, 2));
  await check("D5", "当倒计时结束后提醒我检查结果", async () => { await expect(display.locator("[data-vivic-reminder-alert]")).toContainText("检查结果", { timeout: 10000 }); });
  await fresh("E 数据");
  await check("E1", "给我创建一个表格", async () => assert.equal((await records("TableCard"))[0].displayProps.rows.length, 0));
  await check("E2", "周一3，周二5，周三4", async () => { const cards = await records("TableCard"); assert.equal(cards.length, 1); assert.deepEqual(cards[0].displayProps.rows.map(row => row[1]), [3,5,4]); });
  await check("E3", "把这张表格画成柱状图", async () => assert.deepEqual((await records("ChartCard"))[0].displayProps.points.map(p => p.y), [3,5,4]));
  await check("E4", "折线图：周一3，周二5，周三4", async () => assert.equal((await records("ChartCard")).at(-1).displayProps.chartKind, "line"));
  await check("E5", "饼图：苹果3，香蕉5，橙子4", async () => assert.equal((await records("ChartCard")).at(-1).displayProps.chartKind, "pie"));
  await check("E6", "饼图：苹果-3，香蕉5", async row => { assert.match(row.feedback, /非负/); assert.equal((await records("ChartCard")).length, 3); });
  await check("E7", "表格：甲-3，乙0，丙5.5", async () => assert.deepEqual((await records("TableCard")).at(-1).displayProps.rows.map(row => row[1]), [-3,0,5.5]));
  await fresh("F 联网");
  await check("F1", "上海天气", async row => { assert.equal(row.response.kind, "envelope"); const weather = (await records("WeatherCard"))[0]; assert(weather.sources.some(s => s.provider === "open-meteo/forecast")); await expect(display.locator("[data-card-id]")).toContainText("°C"); });
  await check("F1-natural", "上海现在多少度", async row => {
    assert.equal(row.response.kind, "envelope");
    const weather = await records("WeatherCard");
    if (weather.length === 2) assert(weather[1].sources.some(s => s.provider === "open-meteo/forecast"));
    else {
      assert.equal(weather.length, 1); assert(row.feedback.includes(String(weather[0].displayProps.tempC)));
      assert(Date.now() - Date.parse(weather[0].sources.find(s => s.provider === "open-meteo/forecast").fetchedAt) < 300000);
      row.validation = "Answer matches freshly verified weather already on this canvas; no duplicate card required";
    }
  });
  await check("F2", "搜索三个开源 React 画布库并比较", async () => { assert((await records("SearchResultCard")).length > 0); await expect(display.locator("[data-vivic-source-link]").first()).toBeVisible(); });
  await check("F2-natural", "帮我找几个开源的 React 画布库", async row => { assert.equal(row.response.kind, "envelope"); assert((await records("SearchResultCard")).length > 3); });
  await check("F3", "高亮第二个搜索卡片", async () => assert.equal((await state()).highlight.cardId, (await records("SearchResultCard"))[1].id));
  await check("F4", "阅读网页 https://example.com", async () => assert((await records("SearchResultCard")).at(-1).sources.some(s => s.readFullPage)));
  await check("F5", "阅读网页 http://127.0.0.1:8787/healthz", async row => assert.notEqual(row.response.kind, "envelope"));
  await fresh("G 阅读与找卡");
  await check("G0", "创建便笺：上海发布会。今天先核对场地和灯光，再确认主持词，最后检查现场的网络和备用设备。", async () => assert.equal((await records("NoteCard")).length, 1));
  await check("G1", "展开便笺", async () => assert.equal((await records("NoteCard"))[0].variant, "expanded"));
  await check("G2", "收起便笺", async () => assert.equal((await records("NoteCard"))[0].variant, "minimal"));
  await check("G3", "聚焦便笺", async () => assert.equal((await state()).focus.cardId, (await records("NoteCard"))[0].id));
  await check("G4", "恢复原视图", async () => assert.equal((await state()).focus, null));
  await check("quick-find", null, async () => { await page.locator("[data-vivic-find-cards]").click(); await page.getByRole("combobox").fill("shfbh"); await expect(page.locator("[data-vivic-find-result]")).toHaveCount(1); await page.locator("[data-vivic-find-result]").click(); await expect(page.locator("[data-vivic-quick-find]")).toHaveCount(0); assert.equal((await state()).focus.cardId, (await records("NoteCard"))[0].id); });
  await fresh("H 删除撤销");
  await send("添加待办：甲"); await send("添加待办：乙");
  await check("H1", "删除待办", async () => { await expect(page.locator("[data-vivic-clarify]")).toBeVisible(); assert.equal((await records("TodoCard")).length, 2); });
  await check("H2", "取消", async () => { await expect(page.locator("[data-vivic-clarify]")).toHaveCount(0); assert.equal((await records("TodoCard")).length, 2); });
  await send("删除待办");
  await check("H4", "2号", async () => assert.equal((await records("TodoCard")).length, 1));
  await check("H5", "撤销", async () => assert.equal((await records("TodoCard")).length, 2));
  await check("H6", "不要删除所有卡片", async () => assert.equal((await records("TodoCard")).length, 2));
  await check("H7", "删除所有卡片", async () => assert.equal((await records()).length, 0));
  await check("H8", "撤销", async () => assert.equal((await records("TodoCard")).length, 2));
  await check("refresh-control", null, async () => { const before = (await records()).map(c => c.id); await page.reload(); await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "owner"); assert.deepEqual((await records()).map(c => c.id), before); await expect(display.locator("[data-card-id]")).toHaveCount(2); });
  await page.screenshot({ path: new URL("control.png", dir).pathname, fullPage: true });
  await display.screenshot({ path: new URL("display.png", dir).pathname });
} catch (error) { report.fatalError = String(error); }
finally { await context.close(); await browser.close(); report.completedAt = new Date().toISOString(); report.ok = !report.fatalError && report.cases.every(c => c.ok) && !report.pageErrors.length; await save(); }
console.log(JSON.stringify({ ok: report.ok, total: report.cases.length, pageErrors: report.pageErrors, fatalError: report.fatalError, evidence: dir.pathname }));
process.exitCode = report.ok ? 0 : 1;
