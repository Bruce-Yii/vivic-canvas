import { expect, type Page, type Response } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { waitForDisplayRuntime } from "./helpers";

const here = fileURLToPath(new URL(".", import.meta.url));
export const EVIDENCE1 = path.resolve(here, "../../../../evidence/phase1");

fs.mkdirSync(EVIDENCE1, { recursive: true });

const fixedNow = "2026-10-15T08:00:00.000Z";

export const todoCardRecord = (id: string, texts: string[]) => ({
  id,
  type: "TodoCard",
  variant: "minimal",
  displayProps: {
    items: texts.map((text, i) => ({ id: `${id}-i${i + 1}`, text, done: false })),
  },
  sourceData: {},
  sources: [],
  layout: { x: 0, y: 0, width: 288, height: 160, pinned: false },
  metadata: { createdAt: fixedNow, updatedAt: fixedNow },
});

let seq = 0;
export const rid = (tag: string) => `e2e-p1-${tag}-${Date.now()}-${(seq += 1)}`;

/** Dispatch a validated envelope through the control owner (returns DispatchResult). */
export const controlDispatch = async (
  control: Page,
  tag: string,
  canvasId: string,
  actions: Array<Record<string, unknown>>,
) => {
  const envelope = {
    schemaVersion: "0.6",
    requestId: rid(tag),
    canvasId,
    actions,
  };
  const result = await control.evaluate(
    (raw) =>
      (window as unknown as { __vivic: { dispatch: (r: unknown) => unknown } })
        .__vivic.dispatch(raw),
    envelope,
  );
  expect(result).toEqual({ ok: true, deduplicated: false });
  return envelope;
};

export const activeCanvasId = async (control: Page): Promise<string> =>
  control.evaluate(
    () =>
      (
        window as unknown as {
          __vivicControl: { snapshot: () => { activeCanvasId: string } };
        }
      ).__vivicControl.snapshot().activeCanvasId,
  );

export const gotoControl = async (context: import("@playwright/test").BrowserContext) => {
  const page = await context.newPage();
  await page.goto("/control");
  await expect(page).toHaveTitle("Vivic");
  await expect(page.getByRole("heading", { name: "设置", exact: true })).toBeVisible();
  await page.waitForSelector('[data-vivic-control="ready"]');
  return page;
};

/** `/` (user page) and `/control` (settings) are one owner window; switch in place like a user. */
const showView = async (page: Page, view: "chat" | "settings") => {
  const space = page.locator("[data-vivic-space-management]");
  if (await space.isVisible()) await space.getByRole("button", { name: "关闭窗口", exact: true }).click();
  const root = page.locator("[data-vivic-control]");
  if (await root.getAttribute("data-vivic-view") !== view) {
    await page.locator(view === "chat" ? "[data-vivic-open-chat]" : "[data-vivic-open-settings]").click();
  }
  await expect(root).toHaveAttribute("data-vivic-view", view);
};
export const showChat = (page: Page) => showView(page, "chat");
export const showSettings = (page: Page) => showView(page, "settings");

/** Follow the actual compact UI: Space tools no longer live in Settings. */
export const openSpace = async (page: Page, tab: "空间" | "卡片" | "提醒" = "空间") => {
  const space = page.locator("[data-vivic-space-management]");
  if (!await space.isVisible()) {
    await showChat(page);
    await page.getByRole("button", { name: "管理 Vivic Space", exact: true }).click();
  }
  await space.getByRole("navigation", { name: "Space 管理", exact: true }).getByRole("button", { name: tab, exact: true }).click();
  return space;
};

export const openCardPackages = async (page: Page) => {
  const space = await openSpace(page, "卡片");
  const detail = space.locator("details").filter({ has: page.locator(":scope > summary", { hasText: "添加和管理卡片包" }) });
  if (await detail.getAttribute("open") === null) await detail.locator(":scope > summary").click();
  return space;
};

export const openData = async (page: Page) => {
  await showSettings(page);
  await page.locator('[data-settings-nav="data"]').click();
  return page.getByRole("region", { name: "数据设置", exact: true });
};

export const openVoice = async (page: Page, options = false) => {
  await openPreferences(page);
  const voice = page.getByRole("region", { name: "语音偏好", exact: true });
  if (options) {
    const detail = voice.locator("[data-vivic-voice-options]");
    if (await detail.getAttribute("open") === null) await detail.locator(":scope > summary").click();
  }
  return voice;
};

export const openNotifications = async (page: Page) => {
  const preferences = await openPreferences(page);
  const detail = preferences.locator("details").filter({ has: page.locator(":scope > summary", { hasText: "提醒通知" }) });
  if (await detail.getAttribute("open") === null) await detail.locator(":scope > summary").click();
  return detail;
};

export const openLocation = async (page: Page) => {
  const data = await openData(page);
  const detail = data.locator("details").filter({ has: page.locator(":scope > summary", { hasText: "位置权限" }) });
  if (await detail.getAttribute("open") === null) await detail.locator(":scope > summary").click();
  return detail;
};

/** Explicit small-panel navigation; gotoControl continues to open Connections. */
export const openPreferences = async (page: Page, displayOptions = false) => {
  await showSettings(page);
  await page.getByRole("navigation", { name: "设置分组", exact: true }).getByRole("button", { name: "偏好", exact: true }).click();
  const preferences = page.getByRole("region", { name: "偏好设置", exact: true });
  await expect(preferences).toBeVisible();
  if (displayOptions) {
    const disclosure = preferences.locator(".se-display-options");
    if (await disclosure.getAttribute("open") === null) await disclosure.locator(":scope > summary").click();
    await expect(preferences.getByRole("switch", { name: "减少动效", exact: true })).toBeVisible();
  }
  return preferences;
};

export const gotoDisplay = async (
  context: import("@playwright/test").BrowserContext,
  canvasId: string,
) => {
  const page = await context.newPage();
  await page.goto(`/display?canvasId=${encodeURIComponent(canvasId)}`);
  await waitForDisplayRuntime(page, canvasId);
  return page;
};

export const sendCommand = async (control: Page, text: string) => {
  await showChat(control);
  await control.locator('[data-vivic-command-input]').fill(text);
  await control.locator('[data-vivic-command-input]').press("Enter");
};

/** The same endpoint can negotiate SSE or JSON; observe its actual final result. */
export const readIntentResult = async (response: Response): Promise<{ usedProvider?: string }> => {
  const body = await response.text();
  if (!response.headers()["content-type"]?.includes("text/event-stream")) return JSON.parse(body);
  const final = body.split(/\r?\n\r?\n/).findLast(event => /^event: result$/m.test(event));
  expect(final, "intent SSE must deliver a final result").toBeDefined();
  const data = final!.split(/\r?\n/).filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("\n");
  return JSON.parse(data);
};
