import { expect, test, type Page } from "@playwright/test";
import http from "node:http";
import { activeCanvasId, gotoControl, gotoDisplay, sendCommand, showChat, showSettings } from "./helpers1";

// Isolated TEST contexts only. Real package/owner/persistence; model answers are explicit fixtures.
test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    if (["http:", "https:"].includes(location.protocol)) {
      localStorage.setItem("vivic.deviceLocation.v1", "off");
      localStorage.setItem("vivic.voice.providers.v1", JSON.stringify({ stt: "none", tts: "none", browserVoice: "" }));
    }
    HTMLMediaElement.prototype.play = async () => { throw new Error("TEST audio disabled"); };
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => { throw new Error("TEST microphone disabled"); };
  });
});
const entries = [{ kind: "tasks", name: "工作推进卡" }, { kind: "meeting", name: "会议行动卡" }, { kind: "week", name: "每周重点卡" }] as const;
async function openCardPackages(page: Page) {
  await showChat(page);
  const space = page.getByRole("dialog", { name: "Vivic Space", exact: true });
  if (!await space.isVisible()) await page.getByRole("button", { name: "管理 Vivic Space", exact: true }).click();
  await space.getByRole("navigation", { name: "Space 管理", exact: true }).getByRole("button", { name: "卡片", exact: true }).click();
  const packages = space.locator("details").filter({ has: page.locator(":scope > summary", { hasText: "添加和管理卡片包" }) });
  if (await packages.getAttribute("open") === null) await packages.locator(":scope > summary").click();
  await expect(space.locator("[data-extension-manager]")).toBeVisible();
}
async function closeSpace(page: Page) {
  const space = page.getByRole("dialog", { name: "Vivic Space", exact: true });
  await space.getByRole("button", { name: "关闭窗口", exact: true }).click();
  await expect(space).toBeHidden();
}
async function install(page: Page, kind: string) {
  await openCardPackages(page);
  await page.locator(`[data-office-builtin="${kind}"]`).click();
  const dialog = page.getByRole("dialog", { name: "Vivic Test Space" });
  await expect(dialog.locator(`[data-office-planner="${kind}"]`)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "安装卡片", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "试跑 DEMO", exact: true }).click();
  await dialog.getByRole("button", { name: "安装卡片", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(`[data-extension-installed="vivic.office-${kind}"]`)).toBeVisible();
}

test("office previews cover three kinds, empty/long data, all palettes and a narrow viewport without creating cards", async ({ context }, info) => {
  const page = await gotoControl(context);
  await openCardPackages(page);
  for (const entry of entries) {
    await page.locator(`[data-office-builtin="${entry.kind}"]`).click();
    const dialog = page.getByRole("dialog", { name: "Vivic Test Space" });
    const card = dialog.locator(`[data-office-planner="${entry.kind}"]`);
    await expect(card).toBeVisible(); await expect(dialog).toContainText("DEMO · 虚构样例");
    for (const theme of ["milk", "peach", "lilac", "mint", "dawn", "berry", "graphite", "midnight", "ocean", "velvet", "ember", "forest"]) {
      await dialog.getByLabel("预览主题配色").selectOption(theme); await expect(card).toBeVisible();
    }
    await dialog.getByLabel("预览样例").selectOption("1"); await expect(card).toContainText("还没有行动项");
    await dialog.getByLabel("预览样例").selectOption("2"); await dialog.getByLabel("预览模式").selectOption("display");
    await expect(card.getByRole("checkbox")).toHaveCount(0);
    await dialog.screenshot({ path: info.outputPath(`office-${entry.kind}-dark-long.png`) });
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog.getByLabel("预览主题配色").selectOption("milk");
    await expect(card).toBeVisible();
    expect(await card.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await dialog.screenshot({ path: info.outputPath(`office-${entry.kind}-light-narrow.png`) });
    await page.keyboard.press("Escape"); await page.setViewportSize({ width: 1440, height: 900 });
  }
  await expect(page.locator("[data-extension-installed]")).toHaveCount(0);
  await closeSpace(page);
  await showChat(page); await expect(page.locator("[data-vivic-user-card]")).toHaveCount(0);
});

test("office task edits, completion, undo, portal transfer and persistence share the normal owner path", async ({ context }, info) => {
  const page = await gotoControl(context); await install(page, "tasks");
  await page.locator('[data-extension-installed="vivic.office-tasks"]').getByRole("button", { name: "从 DEMO 创建卡片" }).click();
  await closeSpace(page);
  await showChat(page);
  const card = page.locator('[data-vivic-user-card]').filter({ has: page.locator('[data-office-planner="tasks"]') });
  await expect(card).toBeVisible();
  const first = card.getByRole("checkbox").first();
  await expect(first).toHaveAttribute("aria-checked", "false"); await first.click(); await expect(first).toHaveAttribute("aria-checked", "true");
  await card.getByRole("button", { name: "撤销上次编辑" }).click(); await expect(first).toHaveAttribute("aria-checked", "false");
  await card.getByRole("button", { name: "编辑：整理评审材料", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "编辑行动", exact: true });
  await editor.getByLabel("负责人", { exact: true }).fill("TEST 协作负责人");
  await editor.getByLabel("截止说明", { exact: true }).fill("评审通过后");
  await editor.getByRole("button", { name: "保存行动", exact: true }).click();
  await expect(card).toContainText("TEST 协作负责人");
  await card.getByRole("button", { name: "编辑参数", exact: true }).click();
  const parameters = page.getByRole("dialog", { name: "编辑卡片参数", exact: true });
  await parameters.getByLabel("卡片标题", { exact: true }).fill("TEST · 发布行动");
  await parameters.getByRole("button", { name: "保存参数", exact: true }).click();
  await expect(card).toContainText("TEST · 发布行动");
  await card.getByRole("button", { name: "添加行动", exact: true }).click();
  const add = page.getByRole("dialog", { name: "添加行动", exact: true });
  await add.getByLabel("行动内容", { exact: true }).fill("检查交付清单");
  await add.getByRole("button", { name: "保存行动", exact: true }).click(); await expect(card).toContainText("检查交付清单");
  await page.screenshot({ path: info.outputPath("office-task-edited.png") });
  const display = await gotoDisplay(context, await activeCanvasId(page));
  await page.getByRole("button", { name: "卡片传送门", exact: false }).click();
  const portal = page.getByRole("dialog", { name: "卡片传送门" });
  await portal.getByRole("button", { name: /传送到展示页：/ }).click();
  await portal.getByRole("button", { name: "关闭窗口" }).click();
  const displayed = display.locator('[data-office-planner="tasks"]');
  await expect(displayed).toContainText("TEST 协作负责人");
  await expect(displayed.getByRole("checkbox")).toHaveCount(0);
  await page.reload(); await display.reload();
  await expect(displayed).toContainText("检查交付清单");
  await expect(displayed).toContainText("评审通过后");
  await display.screenshot({ path: info.outputPath("office-task-display-restored.png") });
});

test("explicit office card names reach the real API pipeline using installed schemas and a fixture model", async ({ context }) => {
  const observedPrompts: string[] = [];
  const answers = entries.map(entry => ({ cards: [{ scene_id: `ext.vivic.office-${entry.kind}`, data: {
    config: { title: `TEST · ${entry.name}`, ...(entry.kind === "week" ? { period: "本周" } : {}) },
    data: { origin: "user" }, state: { items: [{ id: "review", title: "整理评审材料", owner: "我", due: "周五", status: "待办", ...(entry.kind === "week" ? { day: "周五" } : {}) }] },
  } }], spokenText: `已整理${entry.name}` }));
  const server = http.createServer((request, response) => {
    const send = (body: unknown) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
    if (request.url === "/v1/models") { send({ data: [{ id: "step-3" }] }); return; }
    const chunks: Buffer[] = []; request.on("data", chunk => chunks.push(chunk)); request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      const prompt = JSON.stringify(body.messages ?? []); observedPrompts.push(prompt);
      const answer = /utterance/.test(prompt) ? answers.shift() ?? { reply: "完成" } : { ok: true };
      send({ choices: [{ message: { content: JSON.stringify(answer) } }] });
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(Number(process.env.VIVIC_E2E_STUB_PORT ?? 45991), "127.0.0.1", resolve); });
  const page = await gotoControl(context);
  try {
    expect((await page.request.post("/api/credentials/stepfun/disconnect")).ok()).toBe(true);
    for (const entry of entries) await install(page, entry.kind);
    await closeSpace(page);
    await showSettings(page);
    await page.getByRole("navigation", { name: "设置分组", exact: true }).getByRole("button", { name: "连接", exact: true }).click();
    await page.locator("[data-vivic-ai-key-input]").fill("TEST-office-fixture-key");
    await page.locator("[data-vivic-ai-connect]").click();
    await expect(page.locator("[data-vivic-ai-badge]")).toContainText("已连接");
    const display = await gotoDisplay(context, await activeCanvasId(page));
    for (const entry of entries) {
      await sendCommand(page, `用${entry.name}整理：TEST · ${entry.name}，我在本周周五整理评审材料，待办。`);
      await expect(display.locator(`[data-office-planner="${entry.kind}"]`)).toContainText("整理评审材料");
      await expect(display.locator(`[data-scene-card="ExtensionCard"]`).filter({ has: display.locator(`[data-office-planner="${entry.kind}"]`) })).toContainText("用户输入");
      expect(observedPrompts.some(prompt => prompt.includes(`ext.vivic.office-${entry.kind}`) && prompt.includes("additionalProperties"))).toBe(true);
    }
    expect(answers).toHaveLength(0);
  } finally { await page.request.post("/api/credentials/stepfun/disconnect"); await new Promise<void>(resolve => server.close(() => resolve())); }
});
