import { test, expect, type BrowserContext, type Page } from "@playwright/test";

const origin = "http://localhost:18794";
async function quiet(context: BrowserContext) {
  await context.addInitScript(() => {
    (window as unknown as { microphoneCalls: number }).microphoneCalls = 0;
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => {
      (window as unknown as { microphoneCalls: number }).microphoneCalls++;
      throw new Error("No physical input in automated verification");
    };
  });
}
async function openOwner(page: Page) {
  await page.addInitScript(() => localStorage.setItem("vivic.online.welcome.v1", "done"));
  await page.goto("/");
  await expect(page.getByLabel("指令输入")).toBeVisible();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.locator('[data-settings-extra="mobile"] > summary').click();
  const response = page.waitForResponse(item => item.url().endsWith("/api/online/mobile/owner/connect"));
  await page.getByRole("button", { name: "生成连接二维码" }).click();
  const connection = await (await response).json() as { connectionId: string; frames: { type: string; sessionId: string; epoch: string; deviceId: string }[] };
  await expect(page.locator("[data-vivic-mobile-pair-code]")).toHaveText(/^[A-F0-9]{16}$/);
  const code = (await page.locator("[data-vivic-mobile-pair-code]").textContent())!;
  return { url: `${origin}/remote/#pair=${code}&online=1`, connection };
}

test("real online owner and separate phone execute, pin, persist and revoke without a launcher or provider", async ({ page, context, browser }, info) => {
  await quiet(context);
  const { url } = await openOwner(page);
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await quiet(phoneContext);
  const phone = await phoneContext.newPage();
  let phoneBootstraps = 0;
  phone.on("request", request => { if (request.url().endsWith("/api/online/session")) phoneBootstraps++; });
  try {
    await phone.goto(url);
    await expect(phone.getByLabel("发送给电脑的文字指令")).toBeEnabled();
    expect(phone.url()).toBe(`${origin}/remote/`);
    expect((await phoneContext.cookies()).some(cookie => cookie.name === "__Host-vivic_online")).toBe(false);
    expect(phoneBootstraps).toBe(0);
    expect(await phone.evaluate(async () => (await indexedDB.databases()).map(db => db.name))).toEqual([]);
    expect(await phone.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
    await expect(page.locator("[data-vivic-mobile-pair-code]")).toHaveCount(0);
    // Keep the connector mounted while the settings modal is closed.
    await page.getByRole("button", { name: "关闭设置" }).click();
    const text = "线上手机真实保存验收";
    await phone.getByLabel("发送给电脑的文字指令").fill(`新建便笺：${text}`);
    await phone.locator("form.mobile-composer").evaluate((form: HTMLFormElement) => form.requestSubmit());
    try { await expect(phone.locator(".mobile-request-succeeded")).toHaveCount(1); }
    catch (error) {
      await info.attach("phone-request-state", { body: await phone.locator("body").innerText(), contentType: "text/plain" });
      await phone.screenshot({ path: info.outputPath("phone-request-failure.png") });
      throw error;
    }
    await phone.getByRole("tab", { name: "Space", exact: true }).click();
    const card = phone.locator(".mobile-space-card").filter({ hasText: text });
    await expect(card).toBeVisible();
    const pin = card.getByRole("button", { name: /^固定 / });
    await pin.click();
    await expect(card.getByRole("button", { name: /^取消固定 / })).toHaveAttribute("aria-pressed", "true");
    await expect(phone.getByRole("tab", { name: "Space", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(phone.getByRole("tab", { name: "聊天", exact: true })).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await phone.screenshot({ path: info.outputPath("01-phone-space.png"), fullPage: true });
    const popup = page.waitForEvent("popup");
    await page.getByRole("button", { name: "展示窗口", exact: true }).click();
    const display = await popup;
    await expect(display.getByText(text, { exact: true })).toBeVisible();
    await display.screenshot({ path: info.outputPath("02-real-desktop-space.png"), fullPage: true });
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(page.locator("[data-vivic-online-mobile-control]")).toContainText("已连接 1 部手机");
    await page.locator("[data-vivic-online-mobile-control]").getByRole("button", { name: "撤销授权", exact: true }).click();
    await expect(phone.getByRole("alert")).toContainText("撤销");
    await expect(phone.getByLabel("发送给电脑的文字指令")).toHaveCount(0);
    await page.getByRole("button", { name: "停止手机控制", exact: true }).click();
    await page.getByRole("button", { name: "关闭设置" }).click();
    await page.reload();
    await expect(page.getByLabel("指令输入")).toBeVisible();
    await display.reload();
    await expect(display.getByText(text, { exact: true })).toBeVisible();
    expect(await phone.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
    expect(await phone.evaluate(() => (window as unknown as { microphoneCalls: number }).microphoneCalls)).toBe(0);
    await display.close();
  } finally { await phoneContext.close(); }
});

test("online pairing is single-use, another cookie cannot take over, owner session deletion ends phone", async ({ page, context, browser }) => {
  await quiet(context);
  const { url, connection } = await openOwner(page);
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const otherContext = await browser.newContext();
  await quiet(phoneContext); await quiet(otherContext);
  try {
    const phone = await phoneContext.newPage(); await phone.goto(url);
    await expect(phone.getByLabel("发送给电脑的文字指令")).toBeEnabled();
    const reused = await phoneContext.newPage(); await reused.goto(url);
    await expect(reused.getByRole("alert")).toContainText("配对码已使用或过期");
    await expect(reused.getByLabel("发送给电脑的文字指令")).toHaveCount(0);
    const other = await otherContext.newPage();
    await other.addInitScript(() => localStorage.setItem("vivic.online.welcome.v1", "done"));
    await other.goto(`${origin}/`);
    await expect(other.getByLabel("指令输入")).toBeVisible();
    const welcome = connection.frames.find(frame => frame.type === "welcome")!;
    const stolen = await otherContext.request.post(`${origin}/api/online/mobile/owner/send`, { headers: { Origin: origin }, data: {
      connectionId: connection.connectionId, frame: { v: 1, sessionId: welcome.sessionId, epoch: welcome.epoch, deviceId: welcome.deviceId, type: "pair.rotate" },
    } });
    expect(stolen.status()).toBe(401);
    expect((await context.request.delete(`${origin}/api/online/session`, { headers: { Origin: origin } })).ok()).toBe(true);
    await expect(phone.getByLabel("发送给电脑的文字指令")).toHaveCount(0);
    await expect(phone.getByRole("alert")).toContainText("会话已结束");
    await expect(other.getByLabel("指令输入")).toBeVisible();
  } finally { await phoneContext.close(); await otherContext.close(); }
});
