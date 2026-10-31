import { expect, test } from "@playwright/test";
import { activeCanvasId, gotoControl, gotoDisplay, showChat, controlDispatch, openSpace, todoCardRecord } from "./helpers1";

function readingPdf() {
  const s1 = "BT /F1 26 Tf 60 740 Td (HANGZHOU / THREE DAYS) Tj /F1 13 Tf 0 -55 Td (Day 1 - West Lake and a slow afternoon) Tj 0 -30 Td (Day 2 - A museum, tea and a walk) Tj 0 -30 Td (Day 3 - Leave time for the unexpected) Tj ET";
  const s2 = "BT /F1 26 Tf 60 740 Td (BEFORE YOU GO) Tj /F1 13 Tf 0 -55 Td (Confirm your tickets and reservations.) Tj 0 -30 Td (Keep your documents available offline.) Tj ET";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${Buffer.byteLength(s1)} >>\nstream\n${s1}\nendstream`, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>", `<< /Length ${Buffer.byteLength(s2)} >>\nstream\n${s2}\nendstream`];
  let pdf = "%PDF-1.4\n"; const offsets = [0];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const start = Buffer.byteLength(pdf); pdf += `xref\n0 8\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(pdf);
}

test("direct document reader shows original files before AI; polished query and organization use real components", async ({ context }, info) => {
  test.setTimeout(150000);
  await context.addInitScript(() => {
    localStorage.setItem("vivic.voice.providers.v1", JSON.stringify({ stt: "none", tts: "none", browserVoice: "" }));
    localStorage.setItem("vivic.deviceLocation.v1", "off");
    HTMLMediaElement.prototype.play = async () => {};
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => { throw Error("no physical media"); };
  });
  const page = await gotoControl(context); await showChat(page); const id = await activeCanvasId(page), errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  const markdown = "# 杭州 · 三日轻旅行\n\n给行程留一点空白，把时间交给风景。\n\n## 第一天 · 湖边慢行\n\n抵达后放下行李，沿湖散步。傍晚找一家喜欢的小店吃饭。\n\n## 第二天 · 茶与城市\n\n- 上午参观博物馆\n- 下午喝茶，整理照片\n- 晚上留给临时发现\n\n## 出发前\n\n| 要准备的事 | 状态 |\n| --- | --- |\n| 核对车票与住宿 | 待确认 |\n| 保存离线资料 | 已安排 |\n\n> 这是一份界面演示行程，实际开放时间与预订信息以官方为准。";
  const longText = "阅读记录\n" + "沿湖慢行，留出休息的时间。\n".repeat(6500) + "终章：原文件末尾已经读到";
  await page.locator('[data-vivic-chat] input[aria-label="选择文件"]').setInputFiles([
    { name: "杭州三日行程.md", mimeType: "text/markdown", buffer: Buffer.from(markdown) },
    { name: "旅行手册.pdf", mimeType: "application/pdf", buffer: readingPdf() },
    { name: "长篇记录.md", mimeType: "text/markdown", buffer: Buffer.from(longText) },
  ]);
  await expect(page.getByText("已保存 3 张文件卡片到 Space", { exact: true })).toBeVisible({ timeout: 45000 });
  const display = await gotoDisplay(context, id); display.on("pageerror", e => errors.push(e.message));
  let aiCalls = 0; display.on("request", r => { if (r.url().endsWith("/api/files/read")) aiCalls++; });
  const openFile = async (name: string) => { await display.getByRole("button", { name: "打开文件：" + name, exact: true }).click(); const dialog = display.getByRole("dialog", { name, exact: true }); await expect(dialog).toHaveCSS("filter", /^(none|blur\(0px\))$/); return dialog; };
  const close = async () => { await display.getByRole("button", { name: "关闭窗口", exact: true }).click(); };
  const md = await openFile("杭州三日行程.md"); await expect(md.getByRole("heading", { name: "杭州 · 三日轻旅行" })).toBeVisible();
  await expect(md.getByRole("textbox", { name: "关于文件的问题" })).toHaveCount(0); expect(aiCalls).toBe(0);
  await display.screenshot({ path: info.outputPath("01-markdown-reading.png") });
  await display.setViewportSize({ width: 390, height: 844 }); await expect(md).toBeVisible();
  expect(await md.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await display.screenshot({ path: info.outputPath("02-narrow-reading.png") }); await close(); await display.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(async () => { const { getControlHost } = await import("/src/sync/browserRuntime.ts"); (await getControlHost()).setPreferences({ theme: "dark" }); });
  const dark = await openFile("杭州三日行程.md"); await expect(dark).toHaveAttribute("data-appearance", "dark"); await expect(dark.getByRole("heading", { name: "杭州 · 三日轻旅行" })).toBeVisible();
  await display.screenshot({ path: info.outputPath("08-dark-reading.png") }); await close();
  await page.evaluate(async () => { const { getControlHost } = await import("/src/sync/browserRuntime.ts"); (await getControlHost()).setPreferences({ theme: "light" }); });
  const pdf = await openFile("旅行手册.pdf"); await expect(pdf.locator('canvas[data-pdf-ready="true"]')).toBeVisible();
  await pdf.getByRole("button", { name: "下一页", exact: true }).click(); await expect(pdf.locator('canvas[data-pdf-ready="true"][aria-label="PDF 第 2 页"]')).toBeVisible();
  expect(await pdf.getByLabel("文件阅读区域").evaluate(el => el.scrollTop)).toBe(0);
  expect(await pdf.locator('canvas[data-pdf-ready="true"]').evaluate((node: HTMLCanvasElement) => {
    const data = node.getContext("2d")!.getImageData(0, 0, node.width, Math.min(300, node.height)).data;
    let ink = 0; for (let i = 0; i < data.length; i += 4) if (data[i + 3]! > 200 && data[i]! + data[i + 1]! + data[i + 2]! < 400) ink++;
    return ink;
  })).toBeGreaterThan(100);
  await display.screenshot({ path: info.outputPath("04-pdf-reading.png") }); await close();
  const long = await openFile("长篇记录.md"); await expect(long.getByLabel("文件只读预览")).toContainText("阅读记录");
  for (let i = 0; i < 4 && await long.getByRole("button", { name: "继续阅读", exact: true }).count(); i++) await long.getByRole("button", { name: "继续阅读", exact: true }).click();
  await expect(long.getByLabel("文件只读预览")).toContainText("终章：原文件末尾已经读到"); await close(); expect(aiCalls).toBe(0);
  await controlDispatch(page, "demo-todo", id, [{ type: "card.create", card: todoCardRecord("demo-trip-tasks", ["核对交通与住宿", "保存离线资料", "和同行的人确认安排"]) }]);
  const space = await openSpace(page, "卡片"); await space.locator('[data-space-organizer] > summary').click(); await space.getByLabel("分区方式", { exact: true }).selectOption("type");
  await space.getByRole("button", { name: "预览整理", exact: true }).click(); await expect(space.getByLabel("整理预览", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("05-organization-preview.png") }); await showChat(page);
  const result = { provider: "feishu", source: "飞书", tool: "search-doc", title: "杭州旅行计划", checkedAt: new Date().toISOString(), text: "## 已找到行程资料\n\n出发前需要核对交通与住宿，下载离线资料，并和同行的人确认安排。\n\n- 三日行程与每日重点\n- 待确认事项清单\n- 出发前的准备笔记", links: [{ title: "行程资料来源（界面示例）", url: "https://example.com/travel-demo" }], truncated: false };
  await page.route("**/api/connections/status", route => route.fulfill({ json: { ok: true, connections: [{ provider: "feishu", label: "飞书", configured: true, connected: true, transport: "mcp", tools: [{ name: "search-doc", title: "搜索文档", inputSchema: { type: "object", properties: { query: { type: "string" } } } }] }] } }));
  await page.route("**/api/connections/ask", route => route.fulfill({ json: { ok: true, result } }));
  await page.getByRole("button", { name: "添加内容", exact: true }).click();
  await page.getByRole("button", { name: "查询资料", exact: true }).click(); await page.getByLabel("资料查询问题", { exact: true }).fill("找一下杭州旅行计划"); await page.getByRole("button", { name: "查询", exact: true }).click();
  await expect(page.locator(".vc-result")).toContainText("已找到行程资料"); await page.screenshot({ path: info.outputPath("06-source-query.png") });
  await page.getByRole("button", { name: "保存为卡片", exact: true }).click(); await expect(page.getByRole("button", { name: "已加入 Space", exact: true })).toBeDisabled();
  await page.getByRole("dialog", { name: "查询资料", exact: true }).getByRole("button", { name: "关闭窗口", exact: true }).click();
  await expect(display.getByRole("button", { name: "打开查询结果：杭州旅行计划", exact: true })).toBeVisible();
  await display.getByRole("button", { name: "打开查询结果：杭州旅行计划", exact: true }).click(); await expect(display.getByRole("heading", { name: "已找到行程资料", exact: true })).toBeVisible();
  await display.screenshot({ path: info.outputPath("07-source-reading.png") }); await close();
  expect(errors).toEqual([]);
});
