import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { activeCanvasId, controlDispatch, gotoControl, gotoDisplay, sendCommand, showChat, showSettings } from "./helpers1";

/**
 * Scene cards end to end, in an isolated TEST browser context:
 * chat → (stubbed) model scene payload → server-built card → Display;
 * all 21 card types on the stage and after reload; Display ⇄ user page by
 * native drag-and-drop between two windows; user-page edits synced back.
 * No real model, microphone, speaker or user canvas is involved.
 */
const here = fileURLToPath(new URL(".", import.meta.url));
const EVIDENCE = path.resolve(here, "../../../../evidence/scene-cards");
fs.mkdirSync(EVIDENCE, { recursive: true });
const ENV_FILE = path.resolve(here, "../../../local-api/.env.local");
const API = `http://127.0.0.1:${process.env.VIVIC_E2E_API_PORT ?? 8788}`;
const STUB_PORT = Number(process.env.VIVIC_E2E_STUB_PORT ?? 45991);
const ZONE = "Asia/Shanghai";
test.use({ timezoneId: ZONE });

const token = () => fs.readFileSync(ENV_FILE, "utf8").split("\n").find(line => line.startsWith("VIVIC_LOCAL_TOKEN="))!.split("=")[1]!.trim();
const api = (p: string, init?: RequestInit) => fetch(`${API}${p}`, { ...init, headers: { authorization: `Bearer ${token()}`, ...(init?.headers ?? {}) } });
const todayPlus = (days: number) => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

/** Minimal StepFun stand-in: model list + one planner answer per request, in order. */
const startStub = async (answers: unknown[]) => {
  const prompts: string[] = [];
  const server = http.createServer((req, res) => {
    const json = (body: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url === "/v1/models") return json({ data: [{ id: "step-3" }] });
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      const user = body.messages?.[1]?.content ?? "";
      prompts.push(typeof user === "string" ? user : JSON.stringify(user));
      // The connection probe asks for JSON too; answer it with a harmless reply.
      const answer = /utterance/.test(prompts.at(-1)!) ? answers.shift() ?? { reply: "好的" } : { ok: true };
      json({ choices: [{ message: { content: JSON.stringify(answer) } }] });
    });
  });
  await new Promise<void>(resolve => server.listen(STUB_PORT, "127.0.0.1", resolve));
  return { prompts, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
};

const connectStubModel = async (control: Page) => {
  await showSettings(control);
  await control.getByRole("navigation", { name: "设置分组", exact: true }).getByRole("button", { name: "连接", exact: true }).click();
  await control.locator("[data-vivic-ai-key-input]").fill("TEST-scene-cards-key");
  await control.locator("[data-vivic-ai-connect]").click();
  await expect(control.locator("[data-vivic-ai-badge]")).toContainText("已连接", { timeout: 10_000 });
};

const loadFixtures = (page: Page) => page.evaluate(async () => {
  const module = await import("/src/cards/scene/fixtures.ts");
  return Object.values(module.buildSceneFixtures()) as Array<Record<string, unknown> & { id: string; type: string }>;
});

/** Native HTML5 drag data, carried from one window to another exactly as the browser would. */
const dragFrom = (page: Page, selector: string) => page.evaluate(sel => {
  const handle = document.querySelector(sel)!;
  const data = new DataTransfer();
  const box = handle.getBoundingClientRect();
  handle.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: data, clientX: box.x + 4, clientY: box.y + 4 }));
  return data.types.map(type => [type, data.getData(type)] as [string, string]);
}, selector);
const dropOn = (page: Page, selector: string, entries: Array<[string, string]>, point?: { x: number; y: number }) => page.evaluate(({ sel, entries, point }) => {
  const target = document.querySelector(sel)!;
  const data = new DataTransfer();
  for (const [type, value] of entries) data.setData(type, value);
  const box = target.getBoundingClientRect();
  const clientX = point?.x ?? box.x + box.width / 2, clientY = point?.y ?? box.y + box.height / 2;
  for (const type of ["dragenter", "dragover", "drop"]) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data, clientX, clientY }));
}, { sel: selector, entries, point });

const displayCard = (display: Page, id: string) => display.locator(`.react-flow__node .vivic-card[data-card-id="${id}"]`);
const storedLayout = (display: Page, id: string) => display.evaluate(cardId =>
  (window as unknown as { __vivic: { getState: () => { cards: Array<{ record: { id: string; layout: Record<string, unknown> } }> } } })
    .__vivic.getState().cards.find(entry => entry.record.id === cardId)?.record.layout, id);
const persistedCard = (page: Page, canvasId: string, cardId: string) => page.evaluate(async ({ canvasId, cardId }) => {
  const modulePath = "/src/persistence/db.ts";
  const { openVivicDB } = await import(/* @vite-ignore */ modulePath);
  const db = await openVivicDB();
  try { return (await db.getCanvas(canvasId))?.cardsById[cardId]; } finally { db.close(); }
}, { canvasId, cardId });

test.beforeEach(async () => { await api("/api/credentials/stepfun/disconnect", { method: "POST" }).catch(() => undefined); });

test("chat → AI scene payload → validated card on the Display (countdown + weekly plan)", async ({ context }) => {
  const birthday = todayPlus(25);
  const stub = await startStub([
    { cards: [{ scene_id: "countdown", card_type: "CountdownCard", data: { title: "我的生日", targetDate: birthday } }], spokenText: "已生成生日倒计时" },
    { cards: [{ scene_id: "weekly_schedule", data: { title: "下周安排", events: [{ day: 1, start: "09:00", title: "开会" }, { day: 3, start: "15:00", title: "去健身房" }] } }], spokenText: "已排好下周安排" },
  ]);
  try {
    const control = await gotoControl(context);
    await connectStubModel(control);
    const canvasId = await activeCanvasId(control);
    const display = await gotoDisplay(context, canvasId);
    await sendCommand(control, "距离我的生日还有 25 天，帮我做个倒计时");
    await expect(control.locator("[data-vivic-command-feedback]")).toContainText("已生成生日倒计时", { timeout: 15_000 });
    const countdown = display.locator('.vivic-card[data-scene-type="CountdownCard"]');
    await expect(countdown).toBeVisible({ timeout: 10_000 });
    await expect(countdown.locator("[data-countdown-value]")).toHaveText("25");
    await expect(countdown).toContainText("我的生日");
    // The planner saw the scene table and the user's local date.
    expect(stub.prompts.at(-1)).toContain('"timeZone":"Asia/Shanghai"');

    await sendCommand(control, "帮我规划下周安排：周一上午9点开会，周三下午3点去健身房");
    const week = display.locator('.vivic-card[data-scene-type="WeeklyScheduleCard"]');
    await expect(week).toBeVisible({ timeout: 15_000 });
    await expect(week).toContainText("去健身房");
    await display.screenshot({ path: path.join(EVIDENCE, "chat-to-display.png") });
  } finally { await stub.close(); }
});

test("a model guess without user evidence never becomes a card", async ({ context }) => {
  const guess = { cards: [{ scene_id: "countdown", data: { title: "生日", targetDate: todayPlus(40) } }] };
  const stub = await startStub([guess, guess]);
  try {
    const control = await gotoControl(context);
    await connectStubModel(control);
    await sendCommand(control, "帮我做个生日倒计时");
    await expect(control.locator("[data-vivic-command-feedback]")).toContainText("请告诉我具体日期", { timeout: 15_000 });
    const cards = await control.evaluate(() => (window as unknown as { __vivic: { getState: () => { cards: unknown[] } } }).__vivic.getState().cards.length);
    expect(cards).toBe(0);
  } finally { await stub.close(); }
});

test("all 21 scene cards render on the Display and survive reloads of both windows", async ({ context }) => {
  const control = await gotoControl(context);
  const canvasId = await activeCanvasId(control);
  const fixtures = await loadFixtures(control);
  expect(fixtures).toHaveLength(21);
  await controlDispatch(control, "scene-all", canvasId, [{ type: "stage.awaken" }, ...fixtures.slice(0, 11).map(card => ({ type: "card.create", card }))]);
  await controlDispatch(control, "scene-all-2", canvasId, [...fixtures.slice(11).map(card => ({ type: "card.create", card })), { type: "canvas.fit" }]);
  const display = await gotoDisplay(context, canvasId);
  for (const card of fixtures) await expect(displayCard(display, card.id)).toBeVisible({ timeout: 10_000 });
  await expect(display.locator("[data-card-render-error]")).toHaveCount(0);
  await display.waitForTimeout(1500);
  await display.screenshot({ path: path.join(EVIDENCE, "display-all-21.png") });
  await display.reload();
  for (const card of fixtures) await expect(displayCard(display, card.id)).toBeVisible({ timeout: 10_000 });
  await control.reload();
  await control.waitForSelector('[data-vivic-control="ready"]');
  const restored = await control.evaluate(() => (window as unknown as { __vivic: { getState: () => { cards: Array<{ record: { type: string } }> } } }).__vivic.getState().cards.map(entry => entry.record.type));
  expect(new Set(restored).size).toBe(21);
});

test("drag Display → user page drop point, move it there, edit, drag back to the stage drop point; state persists", async ({ context }) => {
  const control = await gotoControl(context);
  await showChat(control);
  const canvasId = await activeCanvasId(control);
  const fixtures = await loadFixtures(control);
  const todo = fixtures.find(card => card.type === "TodoCard")!;
  const ring = fixtures.find(card => card.type === "ProgressRingCard")!;
  await controlDispatch(control, "scene-drag", canvasId, [{ type: "stage.awaken" }, { type: "card.create", card: todo }, { type: "card.create", card: ring }]);
  const display = await gotoDisplay(context, canvasId);
  await expect(displayCard(display, todo.id)).toBeVisible({ timeout: 10_000 });

  // Display → user page, landing where it was dropped (the page is otherwise empty).
  await expect(control.locator("[data-vivic-user-card]")).toHaveCount(0);
  const data = await dragFrom(display, `[data-vivic-move-handle="${todo.id}"]`);
  expect(data.map(([type]) => type)).toContain("application/x-vivic-card-from-display");
  await dropOn(control, "[data-vivic-chat]", data, { x: 520, y: 240 });
  const docked = control.locator(`[data-vivic-user-card="${todo.id}"]`);
  await expect(docked).toBeVisible();
  // The point where the card was grabbed on the Display sits under the drop point.
  const grab = JSON.parse(data.find(([type]) => type.endsWith("from-display"))![1]) as { grabX: number; grabY: number };
  const landed = (await docked.boundingBox())!;
  expect(Math.abs(landed.x - (520 - grab.grabX))).toBeLessThanOrEqual(2);
  expect(Math.abs(landed.y - (240 - grab.grabY))).toBeLessThanOrEqual(2);
  // Drag it to another spot on the same page.
  await dropOn(control, "[data-vivic-chat]", await dragFrom(control, `[data-vivic-user-handle="${todo.id}"]`), { x: 160, y: 140 });
  await expect.poll(async () => Math.round((await docked.boundingBox())!.x)).toBeLessThan(300);
  await expect(displayCard(display, todo.id)).toHaveCount(0);
  await expect(displayCard(display, ring.id)).toBeVisible();

  // Real control-mode edit on the user page.
  await docked.locator('[data-vivic-todo-toggle="item-3"]').click();
  await expect(docked.locator("[data-vivic-todo-progress]")).toHaveText("3/4");
  await docked.locator('input[aria-label="添加待办"]').fill("整理照片");
  await docked.locator('input[aria-label="添加待办"]').press("Enter");
  await expect(docked.locator("[data-vivic-todo-progress]")).toHaveText("3/5");
  await control.screenshot({ path: path.join(EVIDENCE, "user-page-cards.png") });

  // User page → Display, dropped at a chosen point on the stage.
  const back = await dragFrom(control, `[data-vivic-user-handle="${todo.id}"]`);
  expect(back.map(([type]) => type)).toContain("application/x-vivic-card-from-user");
  const before = await storedLayout(display, todo.id);
  await dropOn(display, "[data-vivic-canvas]", back, { x: 300, y: 260 });
  await expect(displayCard(display, todo.id)).toBeVisible({ timeout: 10_000 });
  await expect(docked).toHaveCount(0);
  const after = await storedLayout(display, todo.id);
  expect(after?.surface).toBeUndefined();
  expect(after?.x).not.toBe(before?.x);
  await expect(displayCard(display, todo.id).locator("[data-vivic-todo-progress]")).toHaveText("3/5");

  // Button path and persistence after a reload of both windows.
  await dropOn(control, "[data-vivic-chat]", await dragFrom(display, `[data-vivic-move-handle="${ring.id}"]`), { x: 700, y: 180 });
  await expect(control.locator(`[data-vivic-user-card="${ring.id}"]`)).toBeVisible();
  await expect.poll(() => persistedCard(control, canvasId, ring.id)).toMatchObject({ layout: { surface: "user" } });
  await control.reload();
  await control.waitForSelector('[data-vivic-control="ready"]');
  await showChat(control);
  await expect(control.locator(`[data-vivic-user-card="${ring.id}"]`)).toBeVisible();
  await control.locator(`[data-vivic-user-card="${ring.id}"]`).hover();
  await control.locator(`[data-vivic-user-card="${ring.id}"] button[aria-label^="增加"]`).click();
  await expect(control.locator(`[data-vivic-user-card="${ring.id}"] [data-progress-values]`)).toContainText("19 / 50");
  await control.locator(`[data-vivic-user-card="${ring.id}"]`).hover();
  await control.locator(`[data-vivic-send-display="${ring.id}"]`).click();
  await expect.poll(async () => {
    const saved = await persistedCard(control, canvasId, ring.id);
    return saved?.layout.surface !== "user" && saved?.displayProps.current === 19;
  }).toBe(true);
  await display.reload();
  await expect(displayCard(display, ring.id)).toBeVisible({ timeout: 10_000 });
  await expect(displayCard(display, ring.id).locator("[data-progress-values]")).toContainText("19 / 50");
  await display.screenshot({ path: path.join(EVIDENCE, "display-after-return.png") });
});

test("cards placed on the user page stay reachable on a phone-width screen", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, timezoneId: ZONE });
  const control = await gotoControl(context);
  await showChat(control);
  const canvasId = await activeCanvasId(control);
  const fixtures = await loadFixtures(control);
  const picks = ["WeeklyScheduleCard", "ComparisonCard", "GalleryCard"].map(type => fixtures.find(card => card.type === type)!);
  // Positions saved on a wide screen are clamped into a narrow one.
  await controlDispatch(control, "scene-mobile", canvasId, picks.map((card, index) => ({ type: "card.create", card: { ...card,
    layout: { ...(card.layout as object), surface: "user", userPos: { x: 900 + index * 40, y: 200 + index * 120 } } } })));
  for (const card of picks) {
    const box = (await control.locator(`[data-vivic-user-card="${card.id}"]`).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(376);
  }
  const overflow = await control.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(control.locator("[data-vivic-command-input]")).toBeVisible();
  await control.screenshot({ path: path.join(EVIDENCE, "user-page-mobile.png") });
  await context.close();
});
