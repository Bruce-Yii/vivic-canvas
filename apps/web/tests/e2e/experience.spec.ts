import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import path from "node:path";
import { activeCanvasId, controlDispatch, todoCardRecord, openSpace, showChat } from "./helpers1";
import { testCards } from "../../src/cards/__tests__/fixtures";

const evidence = path.resolve(process.cwd(), "../../evidence/experience-20261016/final");
const note = (id = "TEST-note") => ({ ...testCards.NoteCard, id, metadata: { ...testCards.NoteCard.metadata, aliases: ["TEST 上海发布会阅读记录"] }, variant: "minimal", displayProps: { text: "TEST **阅读原文**\n\n中文段落应保持原样，可以选择和复制。\n\n第二段记录来源与结论。", bullets: ["下午核对资料", "最后记录进度"] }, layout: { x: 87, y: 64, width: 320, height: 160, pinned: true } });
const boot = async (page: Page) => {
  await page.goto("/control"); await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "owner");
  return activeCanvasId(page);
};
const read = (page: Page, id = "TEST-note") => page.locator(`[data-vivic-read-details="${id}"]`);
const details = (page: Page) => page.locator("[data-vivic-card-details]");
const finder = (page: Page) => page.locator("[data-vivic-quick-find]");
const input = (page: Page) => finder(page).getByRole("combobox");
const openFind = async (page: Page) => { await showChat(page); await page.locator("[data-vivic-find-cards]").click(); await expect(input(page)).toBeFocused(); };
const records = (page: Page) => page.evaluate(() => window.__vivic!.getState().cards.map(entry => entry.record));
const errors = new WeakMap<BrowserContext, string[]>();
test.beforeEach(async ({ context }) => {
  const list: string[] = []; errors.set(context, list);
  const watch = (page: Page) => page.on("pageerror", error => list.push(error.message));
  context.pages().forEach(watch); context.on("page", watch);
  await context.addInitScript(() => {
    HTMLMediaElement.prototype.play = async () => { throw new Error("TEST no audio"); };
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => { throw new Error("TEST no microphone"); };
  });
});
test.afterEach(async ({ context }, info) => {
  if (info.status !== info.expectedStatus) for (const [i, page] of context.pages().entries()) await page.screenshot({ path: info.outputPath(`TEST-failure-${i}.png`) }).catch(() => undefined);
  expect(errors.get(context)).toEqual([]);
});

test("details share current data, preserve layout/variant, support keyboard, selection, scroll and focus restoration", async ({ page, context }, info) => {
  const id = await boot(page);
  const article = { ...testCards.SearchResultCard, id: "TEST-article", sourceData: { articleText: Array.from({ length: 24 }, (_, i) => `## 第 ${i + 1} 段\n\nTEST 已读取的真实正文内容。段落较长时需要滚动阅读，保留来源和原始文字。`).join("\n\n"), truncated: true } };
  await controlDispatch(page, "seed", id, [{ type: "stage.awaken" }, ...[note(), article].map(card => ({ type: "card.create", card }))]);
  const display = await context.newPage(); await display.goto(`/display?canvasId=${id}`);
  await expect(display.locator(".vivic-card")).toHaveCount(2);
  const before = await records(page);
  await openSpace(page, "卡片"); await read(page).focus(); await read(page).press("Enter"); await expect(details(page)).toBeVisible();
  await expect(details(page).getByRole("button", { name: "关闭窗口" })).toBeFocused();
  await page.keyboard.press("Tab"); await expect(page.locator("[data-vivic-details-scroll]")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  // Native reverse tab order differs with macOS/WebKit full keyboard access;
  // Radix must keep focus inside the dialog in either configuration.
  await expect.poll(() => details(page).evaluate(el => el.contains(document.activeElement))).toBe(true);
  await expect(details(page).locator("strong")).toHaveText("阅读原文");
  await details(page).locator("article").evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); getSelection()!.removeAllRanges(); getSelection()!.addRange(range); });
  expect(await page.evaluate(() => getSelection()!.toString())).toContain("第二段");
  await page.keyboard.press("Escape"); await expect(read(page)).toBeFocused(); expect(await records(page)).toEqual(before);
  await openSpace(page, "卡片"); await read(page).click();
  await controlDispatch(page, "update-note", id, [{ type: "card.update", targetId: "TEST-note", displayProps: { text: "TEST **同步更新**：详情立即读取同一份内容" } }]);
  await expect(details(page).locator("strong")).toHaveText("同步更新");
  expect((await records(page))[0]!.variant).toBe("minimal"); expect((await records(page))[0]!.layout).toEqual(before[0]!.layout);
  await page.keyboard.press("Escape");
  await openSpace(page, "卡片"); await read(page, "TEST-article").click(); await expect(details(page)).toContainText("网页正文 · 已截取");
  const scroll = page.locator("[data-vivic-details-scroll]"); await scroll.focus(); await scroll.press("PageDown");
  await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBeGreaterThan(100);
  const down = await scroll.evaluate(el => el.scrollTop);
  await scroll.press("PageUp"); await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBeLessThan(down);
  await scroll.evaluate(el => el.scrollTo(0, 0));
  await page.screenshot({ path: path.join(evidence, info.project.use.browserName ?? "chromium", "TEST-detail-article.png") });
  await page.setViewportSize({ width: 390, height: 760 });
  await page.screenshot({ path: path.join(evidence, info.project.use.browserName ?? "chromium", "TEST-detail-narrow.png") });
  expect(await details(page).evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.keyboard.press("Escape"); await openSpace(page, "卡片"); await read(page).click();
  await controlDispatch(page, "delete-open", id, [{ type: "card.delete", targetId: "TEST-note" }]);
  await expect(details(page)).toHaveCount(0);
  await expect(page.locator("[data-vivic-find-cards]")).toBeFocused();
  await page.evaluate(() => window.__vivicControl!.undo()); await expect(read(page)).toBeVisible();
  await openSpace(page, "卡片"); await read(page).click();
  await page.evaluate(() => { const id = window.__vivicControl!.createCanvas("TEST 新画布"); window.__vivicControl!.switchCanvas(id); });
  await expect(details(page)).toHaveCount(0);
  const newId = await activeCanvasId(page);
  await controlDispatch(page, "same-id-new-board", newId, [{ type: "card.create", card: { ...note(), displayProps: { text: "TEST 新画布里的同 ID 内容" } } }]);
  await expect(details(page)).toHaveCount(0); await openSpace(page, "卡片"); await read(page).click();
  await expect(details(page)).toContainText("新画布里的同 ID 内容");
});

test("quick find searches Chinese/pinyin/initials with stable duplicate IDs and focuses without changing cards", async ({ page, context }, info) => {
  const requests: string[] = []; context.on("request", request => requests.push(request.url()));
  const id = await boot(page);
  await controlDispatch(page, "seed", id, [{ type: "stage.awaken" }, ...[note(), note("TEST-note-duplicate"), todoCardRecord("TEST-todo", ["买菜", "整理资料"]), { ...testCards.CountdownCard, id: "TEST-done", sourceData: { targetAt: "2020-01-01T00:00:00Z", notifiedAt: "2020-01-01T00:00:01Z", reminderText: "TEST已到时" } }].map(card => ({ type: "card.create", card }))]);
  const display = await context.newPage(); await display.goto(`/display?canvasId=${id}`);
  // Shared target resolution may load pinyin; the find dialog remains lazy.
  expect(requests.filter(url => /QuickFindContent|\/cmdk/.test(url))).toEqual([]);
  const before = await records(page);
  await showChat(page); await page.bringToFront(); await page.keyboard.press("Control+k"); await expect(input(page)).toBeFocused();
  await expect(page.locator("[data-vivic-find-result]")).toHaveCount(3);
  await input(page).fill("shanghai"); await expect(page.locator("[data-vivic-find-result]")).toHaveCount(2);
  await expect(finder(page)).toContainText("TEST-note-duplicate");
  await input(page).fill("shfbh"); await expect(page.locator("[data-vivic-find-result]")).toHaveCount(2);
  await input(page).fill("不存在的事项xyz"); await expect(finder(page)).toContainText("没有匹配");
  await input(page).fill("发布会"); await expect(page.locator("[data-vivic-find-result]")).toHaveCount(2);
  await page.screenshot({ path: path.join(evidence, info.project.use.browserName ?? "chromium", "TEST-find-duplicates.png") });
  await input(page).press("ArrowDown"); await input(page).press("Enter");
  await expect(finder(page)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__vivic!.getState().focus?.cardId)).toBe("TEST-note-duplicate");
  expect(await records(page)).toEqual(before);
  await openFind(page);
  // Firefox implements fill() through IME composition; real Latin keystrokes
  // exercise quick Enter separately from the intentional IME confirm guard.
  await input(page).pressSequentially("zlzl"); await expect(page.locator("[data-vivic-find-result]")).toHaveCount(1);
  await input(page).press("Enter");
  await expect.poll(() => display.evaluate(() => window.__vivic!.getState().focus?.cardId)).toBe("TEST-todo");
  await openFind(page); await input(page).press("Escape"); await expect(page.locator("[data-vivic-find-cards]")).toBeFocused();
  await showChat(page); await page.keyboard.press("Meta+k"); await expect(input(page)).toBeFocused(); await input(page).press("Escape");
  await page.reload(); await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "owner");
  await expect(finder(page)).toHaveCount(0); await expect(details(page)).toHaveCount(0); expect(await records(page)).toEqual(before);
});

test("IME confirmation and Escape do not select or dismiss; deleted targets and canvas switching stay current", async ({ page }) => {
  const id = await boot(page);
  await controlDispatch(page, "seed", id, [note(), todoCardRecord("TEST-todo", ["喝水"])].map(card => ({ type: "card.create", card })));
  await openFind(page); await input(page).fill("喝水");
  await input(page).dispatchEvent("compositionstart", { data: "喝水" });
  await input(page).dispatchEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229, isComposing: true });
  await input(page).dispatchEvent("keydown", { key: "Escape", code: "Escape", keyCode: 229, isComposing: true });
  await expect(finder(page)).toBeVisible(); expect(await page.evaluate(() => window.__vivic!.getState().focus)).toBeNull();
  await input(page).dispatchEvent("compositionend", { data: "喝水" });
  await input(page).dispatchEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13 });
  await expect(finder(page)).toBeVisible(); expect(await page.evaluate(() => window.__vivic!.getState().focus)).toBeNull();
  await input(page).press("Escape"); await expect(finder(page)).toHaveCount(0);
  await openFind(page); await input(page).fill("喝水");
  await controlDispatch(page, "delete-result", id, [{ type: "card.delete", targetId: "TEST-todo" }]);
  await expect(page.locator("[data-vivic-find-result]")).toHaveCount(0); await input(page).press("Enter");
  expect(await page.evaluate(() => window.__vivic!.getState().focus)).toBeNull();
  await page.evaluate(() => { const id = window.__vivicControl!.createCanvas("TEST 空画布"); window.__vivicControl!.switchCanvas(id); });
  await expect(finder(page)).toHaveCount(0); await openFind(page); await expect(page.locator("[data-vivic-find-result]")).toHaveCount(0);
});

test("owner changes close both surfaces; readonly search never takes ownership and details stay readable", async ({ page, context }) => {
  const id = await boot(page); await controlDispatch(page, "seed", id, [{ type: "card.create", card: note() }]);
  const other = await context.newPage(); await other.goto("/control");
  await expect(other.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "readonly");
  await openSpace(page, "卡片"); await read(page).click(); await other.locator("[data-vivic-takeover]").click();
  await expect(details(page)).toHaveCount(0); await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "readonly");
  await openFind(page); await input(page).fill("发布会");
  await expect(page.locator("[data-vivic-find-result]")).toHaveAttribute("aria-disabled", "true"); await input(page).press("Enter");
  await expect(finder(page)).toBeVisible(); await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "readonly");
  await input(page).press("Escape"); await openSpace(page, "卡片"); await read(page).click(); await expect(details(page)).toContainText("阅读原文"); await page.keyboard.press("Escape");
  await openFind(other); await page.locator("[data-vivic-takeover]").click(); await expect(finder(other)).toHaveCount(0);
  // A third reader stays readonly while the identity of the owner changes.
  const reader = await context.newPage(); await reader.goto("/control");
  await expect(reader.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "readonly");
  await expect.poll(() => reader.evaluate(() => (window.__vivicControl!.snapshot() as { ownerId: string | null }).ownerId)).not.toBeNull();
  await openSpace(reader, "卡片"); await read(reader).click(); await other.locator("[data-vivic-takeover]").click();
  await expect(details(reader)).toHaveCount(0);
  await openFind(reader); await page.locator("[data-vivic-takeover]").click(); await expect(finder(reader)).toHaveCount(0);
});

test("reduced motion reading and search are usable on a narrow screen", async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" }); await page.setViewportSize({ width: 390, height: 760 });
  const id = await boot(page); await controlDispatch(page, "seed", id, [{ type: "card.create", card: note() }]);
  await openSpace(page, "卡片"); await read(page).click(); await expect(details(page)).toHaveAttribute("data-reduced-motion", "true");
  await expect(details(page)).toHaveCSS("opacity", "1");
  await page.screenshot({ path: path.join(evidence, info.project.use.browserName ?? "chromium", "TEST-detail-reduced-motion.png") });
  await page.keyboard.press("Escape"); await openFind(page); await input(page).fill("shanghai");
  await expect(page.locator("[data-vivic-find-result]")).toHaveCount(1);
  await page.screenshot({ path: path.join(evidence, info.project.use.browserName ?? "chromium", "TEST-find-narrow.png") });
  expect(await page.evaluate(() => [...document.querySelectorAll("body *")].filter(el => {
    const r = el.getBoundingClientRect(); return r.width > 0 && r.right > innerWidth + 1;
  }).slice(0, 12).map(el => ({ tag: el.tagName, cls: el.className, width: el.getBoundingClientRect().width })))).toEqual([]);
});
