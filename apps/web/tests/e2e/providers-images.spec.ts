import { expect, test, type Page } from "@playwright/test";
import { showChat, openVoice } from "./helpers1";

// Explicit TEST protocol fixtures. These tests do not log in, send images to a
// provider, record a physical microphone or play audio.
async function connectionFixture(page: Page, vision = false) {
  let active = "stepfun", gptConnected = false;
  const stepfun = { name: "stepfun", connected: true, capabilities: ["chat", "structured", ...(vision ? ["vision"] : [])],
    models: [vision ? "step-3.7-flash" : "step-3.5-flash"], defaultModel: vision ? "step-3.7-flash" : "step-3.5-flash" };
  await page.route("**/api/providers/status", route => route.fulfill({ json: { activeProvider: active,
    providers: [stepfun, { name: "gpt", connected: gptConnected, capabilities: ["chat", "structured"],
      ...(gptConnected ? { defaultModel: "gpt-6-luna", models: ["gpt-6-luna"] } : {}) }], degradations: [] } }));
  await page.route("**/api/providers/select", async route => { active = route.request().postDataJSON().provider; await route.fulfill({ json: { ok: true, activeProvider: active } }); });
  await page.route("**/api/gpt/connect", async route => { expect(route.request().postDataJSON()).toEqual({ source: "pi" }); gptConnected = true; await route.fulfill({ json: { ok: true } }); });
  await page.goto("/control"); await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "owner");
}

test("TEST GPT/Pi connection keeps StepFun voice independent; text mode sends no speech request", async ({ page }) => {
  await connectionFixture(page);
  const audioRequests: string[] = [];
  page.on("request", request => { if (/\/api\/(?:speech|transcribe)$/.test(request.url())) audioRequests.push(request.url()); });
  await page.locator("[data-vivic-connection-options] > summary").click(); await page.getByLabel("LLM 连接方式").click(); await page.getByRole("option", { name: "GPT · Pi 登录", exact: true }).click();
  await page.locator("[data-vivic-gpt-use-pi]").click();
  await expect(page.getByLabel("当前推理模型")).toContainText("gpt-6-luna");
  // The StepFun connection is retained for independently selected voice.
  await expect(page.locator("[data-vivic-ai-disconnect]")).toBeEnabled();
  await openVoice(page, true); await page.getByLabel("语音输入服务").click(); await page.getByRole("option", { name: "关闭", exact: true }).click();
  await page.getByLabel("语音输出服务").click(); await page.getByRole("option", { name: "关闭", exact: true }).click();
  await expect(page.getByRole("switch", { name: "语音回复", exact: true })).not.toBeChecked();
  await showChat(page); await expect(page.locator("[data-vivic-ptt]")).toBeDisabled();
  let submitted = false;
  await page.route("**/api/intent", async route => {
    const body = route.request().postDataJSON(); submitted = true; expect(body).not.toHaveProperty("attachments");
    await route.fulfill({ json: { kind: "clarify", usedProvider: "gpt", message: "TEST GPT 文字回复" } });
  });
  await showChat(page);
  await page.locator("[data-vivic-command-input]").fill("TEST GPT 文字指令"); await page.locator("[data-vivic-command-send]").click();
  await expect(page.locator("[data-vivic-command-feedback]")).toContainText("TEST GPT 文字回复");
  expect(submitted).toBe(true); expect(audioRequests).toEqual([]);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toMatch(/apiKey|refresh_token|access_token|authorization/i);
});

test("TEST image selection decodes locally and sends only after explicit Send", async ({ page, context }) => {
  await connectionFixture(page, true); await showChat(page);
  const canvasId = await page.evaluate(() => (window.__vivicControl!.snapshot() as { activeCanvasId: string }).activeCanvasId);
  const display = await context.newPage(); await display.goto(`/display?canvasId=${canvasId}`);
  let calls = 0, imageData = "";
  await page.route("**/api/intent", async route => {
    const body = route.request().postDataJSON(); calls++; expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0]).toMatchObject({ type: "image", mime: "image/png" });
    imageData = body.attachments[0].data; expect(imageData).not.toContain("data:");
    expect(body.canvasContext).not.toHaveProperty("attachments");
    const stamp = new Date().toISOString();
    await route.fulfill({ json: { kind: "envelope", usedProvider: "stepfun", envelope: { schemaVersion: "0.6", requestId: "TEST-image-response", canvasId,
      spokenText: "TEST 图片已分析", actions: [{ type: "stage.awaken" }, { type: "card.create", card: {
        id: "TEST-image-note", type: "NoteCard", variant: "minimal", displayProps: { text: "TEST 图片分析结果" }, sourceData: {}, sources: [],
        layout: { x: 0, y: 0, width: 288, height: 160, pinned: false }, metadata: { createdAt: stamp, updatedAt: stamp },
      } }, { type: "canvas.fit" }] } } });
  });
  const png = await page.screenshot({ clip: { x: 0, y: 0, width: 80, height: 80 } });
  await page.getByLabel("选择图片附件").setInputFiles({ name: "TEST-local.png", mimeType: "image/png", buffer: png });
  await expect(page.getByAltText("待发送图片预览")).toBeVisible(); expect(calls).toBe(0);
  await page.locator("[data-vivic-command-input]").fill("TEST 说明这张图片"); await page.locator("[data-vivic-command-send]").click();
  await expect(display.locator('[data-card-id="TEST-image-note"]')).toContainText("TEST 图片分析结果"); expect(calls).toBe(1);
  await expect(page.getByAltText("待发送图片预览")).toHaveCount(0);
  const state = await display.evaluate(() => JSON.stringify(window.__vivic!.getState()));
  expect(state).not.toContain(imageData); expect(state).not.toContain("TEST-local.png");
  await display.close();
});

test("TEST image cannot be sent without vision and is cleared when the canvas changes", async ({ page }) => {
  await connectionFixture(page, false); await showChat(page);
  let calls = 0; await page.route("**/api/intent", () => { calls++; });
  const png = await page.screenshot({ clip: { x: 0, y: 0, width: 80, height: 80 } });
  await page.getByLabel("选择图片附件").setInputFiles({ name: "TEST-local.png", mimeType: "image/png", buffer: png });
  await expect(page.getByAltText("待发送图片预览")).toBeVisible();
  await page.locator("[data-vivic-command-input]").fill("TEST 分析图片");
  await expect(page.locator("[data-vivic-command-send]")).toBeDisabled();
  await page.evaluate(() => { const id = window.__vivicControl!.createCanvas("TEST new canvas"); window.__vivicControl!.switchCanvas(id); });
  await expect(page.getByAltText("待发送图片预览")).toHaveCount(0); expect(calls).toBe(0);
});

test("TEST invalid image never becomes an attachment or a model request", async ({ page }) => {
  await connectionFixture(page, true); await showChat(page);
  let calls = 0; await page.route("**/api/intent", () => { calls++; });
  await page.getByLabel("选择图片附件").setInputFiles({ name: "TEST-invalid.svg", mimeType: "image/svg+xml", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') });
  await expect(page.getByRole("alert")).toContainText("PNG"); await expect(page.getByAltText("待发送图片预览")).toHaveCount(0); expect(calls).toBe(0);
});

test("TEST Continue with ChatGPT opens the authorization page in a popup without a second click", async ({ page, context }) => {
  await connectionFixture(page);
  const authUrl = "https://auth.openai.com/oauth/authorize?client_id=TEST";
  await context.route("https://auth.openai.com/**", route => route.fulfill({ contentType: "text/html", body: "<title>TEST OpenAI</title>TEST" }));
  await page.route("**/api/gpt/login/start", route => route.fulfill({ json: { ok: true, login: { phase: "waiting" } } }));
  await page.route("**/api/gpt/login/status", route => route.fulfill({ json: { login: { phase: "waiting", authUrl, needsInput: true } } }));
  await page.locator("[data-vivic-connection-options] > summary").click(); await page.getByLabel("LLM 连接方式").click(); await page.getByRole("option", { name: "GPT · Pi 登录", exact: true }).click();
  const popupPromise = page.waitForEvent("popup");
  await page.locator("[data-vivic-gpt-login]").click();
  const popup = await popupPromise;
  await expect.poll(() => popup.url()).toBe(authUrl);
  // The fallback link stays for blocked popups.
  await expect(page.locator("[data-vivic-gpt-auth-link]")).toHaveAttribute("href", authUrl);
});
