import { expect, test } from "@playwright/test";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendCommand, openVoice } from "./helpers1";

/**
 * Phase 2a: AI 连接 + backend-first intent routing.
 * The Playwright webServer starts the local API on 127.0.0.1:8788 with
 * STEPFUN_BASE_URL pointed at an in-process stub (no real network).
 *
 * NOTE: the API process is shared across tests in this file; each test
 * starts from a disconnected credential store via direct API call.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const ENV_FILE = path.resolve(here, "../../../local-api/.env.local");
const API = process.env.VIVIC_E2E_API ?? `http://127.0.0.1:${process.env.VIVIC_E2E_API_PORT ?? 8788}`;
const STUB_PORT = Number(process.env.VIVIC_E2E_STUB_PORT ?? 45991);
const SECRET_KEY = "[redacted]";

const readToken = (): string =>
  fs
    .readFileSync(ENV_FILE, "utf8")
    .split("\n")
    .find((l) => l.startsWith("VIVIC_LOCAL_TOKEN="))!
    .split("=")[1]!
    .trim();

const api = async (p: string, init?: RequestInit) =>
  fetch(`${API}${p}`, {
    ...init,
    headers: { authorization: `Bearer ${readToken()}`, ...(init?.headers ?? {}) },
  });

interface Stub {
  close: () => Promise<void>;
  planner: { payload: unknown; status?: number };
}

const startStepfunStub = async (): Promise<Stub> => {
  const planner: Stub["planner"] = { payload: null };
  const server = http.createServer((req, res) => {
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/v1/models") {
      json(200, { data: [{ id: "step-3" }, { id: "step-1-8k" }] });
      return;
    }
    if (req.url === "/v1/chat/completions") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        if (planner.status && planner.status !== 200) {
          json(planner.status, planner.payload);
          return;
        }
        json(200, {
          choices: [
            {
              message: {
                content: JSON.stringify(
                  planner.payload ?? { actions: [], spokenText: "不知道如何回答" },
                ),
              },
            },
          ],
        });
      });
      return;
    }
    json(404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(STUB_PORT, "127.0.0.1", resolve));
  return {
    planner,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

test.beforeEach(async () => {
  await api("/api/credentials/stepfun/disconnect", { method: "POST" });
});

test("AI section shows honest 未连接 when the backend has no key", async ({
  page,
}) => {
  await page.goto("/control");
  await page.waitForSelector('[data-vivic-control="ready"]');
  await expect(page.locator("[data-vivic-ai-badge]")).toHaveText("未连接");
  await expect(page.locator("[data-vivic-intent-mode]")).toHaveText("模型未连接 · 请在设置中连接");

  // Commands still route through the backend's local rules (usedProvider=rules).
  await sendCommand(page, "十分钟倒计时");
  await expect(page.locator("[data-vivic-command-feedback]")).toContainText("倒计时");
});

test("stubbed-healthy backend: connect shows connected badge; disconnect clears", async ({
  page,
}) => {
  const stub = await startStepfunStub();
  try {
    await page.goto("/control");
    await page.waitForSelector('[data-vivic-control="ready"]');
    await expect(page.locator("[data-vivic-ai-badge]")).toHaveText("未连接");
    await page.locator("[data-vivic-ai-key-input]").fill(SECRET_KEY);
    await page.locator("[data-vivic-ai-connect]").click();
    await expect(page.locator("[data-vivic-ai-badge]")).toContainText("已连接", {
      timeout: 8000,
    });
    await page.locator("[data-vivic-connection-options] > summary").click();
    await expect(page.getByLabel("当前推理模型", { exact: true })).toContainText("step-3");
    await expect(page.locator("[data-vivic-ai-key-input]")).toHaveCount(0);
    await expect(page.locator("[data-vivic-ai-note]")).toContainText("Key 仅保留在本机服务内存中");

    await page.locator("[data-vivic-ai-disconnect]").click();
    await expect(page.locator("[data-vivic-ai-badge]")).toHaveText("未连接");
  } finally {
    await stub.close();
  }
});

test("model catalog success with Plan 403 shows the reason instead of a connected badge", async ({ page }) => {
  const stub = await startStepfunStub();
  stub.planner.status = 403;
  stub.planner.payload = { error: { code: "permission_denied", message: "No active Plan subscription" } };
  try {
    await page.goto("/control");
    await page.waitForSelector('[data-vivic-control="ready"]');
    await expect(page.locator("[data-vivic-ai-badge]")).toHaveText("未连接");
    await page.locator("[data-vivic-ai-key-input]").fill(SECRET_KEY);
    await page.locator("[data-vivic-ai-connect]").click();
    await expect(page.locator("[data-vivic-ai-note]")).toContainText("No active Plan subscription");
    await expect(page.locator("[data-vivic-ai-note]")).toContainText("HTTP 403");
    await expect(page.locator("[data-vivic-ai-badge]")).toHaveText("未连接");
    await openVoice(page);
    await expect(page.getByRole("switch", { name: "语音回复", exact: true })).not.toBeChecked();
    await expect(page.locator("[data-vivic-tts-preview]")).toHaveCount(0);
    await expect(page.locator("[data-vivic-ai-key-input]")).toHaveValue("");
    expect(await page.content()).not.toContain(SECRET_KEY);
  } finally {
    await stub.close();
  }
});

test("backend-first planning: rules miss -> stubbed LLM envelope reaches the canvas", async ({
  page,
}) => {
  const stub = await startStepfunStub();
  try {
    await page.goto("/control");
    await page.waitForSelector('[data-vivic-control="ready"]');
    await page.locator("[data-vivic-ai-key-input]").fill(SECRET_KEY);
    await page.locator("[data-vivic-ai-connect]").click();
    await expect(page.locator("[data-vivic-ai-badge]")).toContainText("已连接", {
      timeout: 8000,
    });

    await sendCommand(page, "加待办:模型路由验证");
    await expect.poll(() => page.evaluate(() => window.__vivic?.getState())
      .then(state => (state as { cards?: unknown[] } | undefined)?.cards?.length ?? 0)).toBe(1);
    const cardId = await page.evaluate(
      () =>
        (
          window as unknown as {
            __vivic: { getState: () => { cards: Array<{ record: { id: string } }> } };
          }
        ).__vivic.getState().cards[0]?.record.id,
    );
    expect(cardId).toBeTruthy();

    stub.planner.payload = {
      actions: [{ type: "card.focus", targetId: cardId }],
      spokenText: "已聚焦它",
    };
    await sendCommand(page, "我想仔细研究这项任务的细节，请将它居中显示");
    await expect(page.locator("[data-vivic-command-feedback]")).toContainText("已聚焦它");
    const focus = await page.evaluate(
      () =>
        (
          window as unknown as {
            __vivic: { getState: () => { focus: { cardId: string } | null } };
          }
        ).__vivic.getState().focus?.cardId,
    );
    expect(focus).toBe(cardId);
    await expect(page.locator("[data-vivic-command-feedback]")).toContainText("已聚焦它");
  } finally {
    await stub.close();
  }
});

test("offline mode: aborted /api falls back to in-browser rules with honest badge", async ({
  page,
}) => {
  await page.goto("/control");
  await page.waitForSelector('[data-vivic-control="ready"]');
  await page.route("**/api/**", (route) => route.abort());
  await sendCommand(page, "五分钟倒计时");
  await expect(page.locator("[data-vivic-intent-mode]")).toContainText("服务暂不可用 · 可用内置指令");
  await expect.poll(() => page.evaluate(() => window.__vivic?.getState())
    .then(state => (state as { cards?: unknown[] } | undefined)?.cards?.length ?? 0)).toBe(1);
  const cards = await page.evaluate(
    () =>
      (
        window as unknown as {
          __vivic: { getState: () => { cards: unknown[] } };
        }
      ).__vivic.getState().cards.length,
  );
  expect(cards).toBe(1);
});

test("C10: StepFun key never lands in browser storage, DOM or display payload", async ({
  page,
}) => {
  const stub = await startStepfunStub();
  try {
    await page.goto("/control");
    await page.waitForSelector('[data-vivic-control="ready"]');
    await page.locator("[data-vivic-ai-key-input]").fill(SECRET_KEY);
    await page.locator("[data-vivic-ai-connect]").click();
    await expect(page.locator("[data-vivic-ai-badge]")).toContainText("已连接", {
      timeout: 8000,
    });
    await sendCommand(page, "加待办:密钥泄漏检查");

    const leaksOnControl = await page.evaluate(async (needle: string) => {
      const hits: string[] = [];
      const ls = JSON.stringify({
        localStorage: { ...window.localStorage },
        sessionStorage: { ...window.sessionStorage },
      });
      if (ls.includes(needle)) hits.push("webstorage");
      if (document.documentElement.outerHTML.includes(needle)) hits.push("dom");
      const dbs = await indexedDB.databases();
      for (const dbInfo of dbs) {
        if (!dbInfo.name) continue;
        const dump = await new Promise<string>((resolve) => {
          const req = indexedDB.open(dbInfo.name!);
          req.onsuccess = () => {
            const db = req.result;
            const out: string[] = [];
            for (const name of db.objectStoreNames) {
              const tx = db.transaction(name, "readonly");
              const getAll = tx.objectStore(name).getAll();
              getAll.onsuccess = () => out.push(JSON.stringify(getAll.result));
            }
            setTimeout(() => resolve(out.join("")), 300);
          };
          req.onerror = () => resolve("");
        });
        if (dump.includes(needle)) hits.push(`indexeddb:${dbInfo.name}`);
      }
      return hits;
    }, SECRET_KEY);
    expect(leaksOnControl).toEqual([]);

    // The display frame must never see key material either.
    const ctx = page.context();
    const display = await ctx.newPage();
    await display.goto("/display");
    await display.waitForTimeout(600);
    const displayHtml = await display.evaluate(
      () => document.documentElement.outerHTML,
    );
    expect(displayHtml).not.toContain(SECRET_KEY);
    await display.close();
  } finally {
    await stub.close();
  }
});
