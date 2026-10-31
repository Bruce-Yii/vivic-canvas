import { expect, type Browser, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
export const EVIDENCE = path.resolve(here, "../../../../evidence/phase0");

fs.mkdirSync(EVIDENCE, { recursive: true });

let seq = 0;
const rid = (tag: string) => `e2e-${tag}-${Date.now()}-${(seq += 1)}`;

/** Navigation completes before a lazy route has mounted its async runtime. */
export const waitForDisplayRuntime = async (page: Page, canvasId?: string) => {
  await page.waitForFunction(expectedId => {
    const runtime = window.__vivic;
    const status = runtime?.status?.();
    if (!runtime?.getState || !status || typeof status !== "object") return false;
    return expectedId === undefined || "canvasId" in status && status.canvasId === expectedId
      && "hydrated" in status && status.hydrated === true;
  }, canvasId);
};

export const fire = async (
  page: Page,
  tag: string,
  actions: Array<Record<string, unknown>>,
) => {
  await waitForDisplayRuntime(page);
  const envelope = {
    schemaVersion: "0.6",
    requestId: rid(tag),
    canvasId: "e2e",
    actions,
  };
  const result = await page.evaluate(
    (raw) =>
      (window as unknown as { __vivic: { dispatch: (r: unknown) => unknown } })
        .__vivic.dispatch(raw),
    envelope,
  );
  expect(result).toEqual({ ok: true, deduplicated: false });
};

export const internal = async (page: Page, action: Record<string, unknown>) =>
  page.evaluate(
    (raw) =>
      (window as unknown as { __vivic: { internal: (a: unknown) => unknown } })
        .__vivic.internal(raw),
    action,
  );

const fixedNow = "2026-10-14T10:00:00.000Z";

export const countdownCard = () => ({
  id: "e2e-countdown",
  type: "CountdownCard",
  variant: "minimal",
  displayProps: {},
  sourceData: {
    targetAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    startedAt: fixedNow,
  },
  sources: [],
  layout: { x: 0, y: 0, width: 264, height: 96, pinned: false },
  metadata: { createdAt: fixedNow, updatedAt: fixedNow },
});

export const todoCard = () => ({
  id: "e2e-todo",
  type: "TodoCard",
  variant: "minimal",
  displayProps: {
    items: [
      { id: "e2e-t1", text: "Review wake transition frames", done: true },
      { id: "e2e-t2", text: "Capture light + dark screenshots", done: false },
      { id: "e2e-t3", text: "Run the FPS sampler", done: false },
    ],
  },
  sourceData: {},
  sources: [],
  layout: { x: 0, y: 0, width: 288, height: 160, pinned: false },
  metadata: { createdAt: fixedNow, updatedAt: fixedNow },
});

export const searchCard = () => ({
  id: "e2e-search",
  type: "SearchResultCard",
  variant: "minimal",
  displayProps: {
    title: "Motion — animation library for JS",
    summary: "Production-ready declarative animations for the web used by Vivic.",
    sourceLabel: "DEMO · motion.dev",
  },
  sourceData: {},
  sources: [
    {
      title: "Motion",
      url: "https://motion.dev/",
      fetchedAt: fixedNow,
      provider: "demo-static",
      readFullPage: false,
    },
  ],
  layout: { x: 0, y: 0, width: 296, height: 148, pinned: false },
  metadata: { createdAt: fixedNow, updatedAt: fixedNow },
});

export const createDemoCards = (page: Page) =>
  fire(page, "cards", [
    { type: "card.create", card: countdownCard() },
    { type: "card.create", card: todoCard() },
    { type: "card.create", card: searchCard() },
  ]);

export const awaken = async (page: Page) => {
  await fire(page, "awaken", [{ type: "stage.awaken" }]);
  await page.waitForSelector('[data-vivic-stage="WORKSPACE"]', {
    timeout: 6000,
  });
};

export const setTheme = (page: Page, theme: "auto" | "light" | "dark") =>
  fire(page, `theme-${theme}`, [
    { type: "ambient.setPreset", preset: "grainient", theme },
  ]);

export const newEvidencePage = async (
  browser: Browser,
  videoName?: string,
): Promise<{ page: Page; finish: () => Promise<void> }> => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    recordVideo: videoName
      ? { dir: EVIDENCE, size: { width: 1440, height: 900 } }
      : undefined,
  });
  const page = await context.newPage();
  const video = page.video();
  return {
    page,
    finish: async () => {
      await context.close();
      if (video && videoName) {
        await video.saveAs(path.join(EVIDENCE, videoName));
        const original = await video.path();
        if (fs.existsSync(original)) fs.rmSync(original, { force: true });
      }
    },
  };
};
