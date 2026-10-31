import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { createRelayServer } from "../../../../contrib/mobile-console/relay";
import { activeCanvasId, gotoControl, showChat } from "./helpers1";

function samplePdf() {
  const stream = "BT /F1 18 Tf 50 150 Td (TEST PDF document) Tj ET";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = "%PDF-1.4\n"; const offsets = [0];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(pdf);
}

test("real owner files, workers, scoped read-only preview and durable phone portal", async ({ browser }, info) => {
  test.setTimeout(150_000);
  const origin = `http://localhost:${process.env.VIVIC_E2E_WEB_PORT ?? 5174}`;
  const moduleBase = `/@fs/${path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..").replaceAll("\\", "/")}/contrib/mobile-console/`;
  const admissionSecret = randomBytes(32).toString("base64url"), relay = createRelayServer({ admissionSecret, allowedOrigins: [origin] });
  const address = await relay.listen(0), relayUrl = `ws://127.0.0.1:${address.port}/relay`;
  const desktop = await browser.newContext(), mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true });
  for (const context of [desktop, mobile]) await context.addInitScript(() => { localStorage.setItem("vivic.deviceLocation.v1", "off"); HTMLMediaElement.prototype.play = async () => {}; if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => { throw new Error("test capture blocked"); }; });
  try {
    const owner = await gotoControl(desktop); await showChat(owner); const canvasId = await activeCanvasId(owner);
    const contents = "TEST 文件说明\n本周提交旅行演示。\n<script>window.FILE_EXECUTED=true</script>";
    const upload = owner.locator('[data-vivic-chat] input[aria-label="选择文件"]');
    await upload.setInputFiles([{ name: "plan.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from("TEST unsupported original") }]);
    await expect(owner.getByText("只支持 PDF 和 Markdown（.md）文件", { exact: true })).toBeVisible();
    await upload.setInputFiles([{ name: "travel.md", mimeType: "text/markdown", buffer: Buffer.from(contents) }, { name: "sample.pdf", mimeType: "application/pdf", buffer: samplePdf() }]);
    await expect(owner.getByText("已保存 2 张文件卡片到 Space", { exact: true })).toBeVisible({ timeout: 45_000 });
    const records = await owner.evaluate(() => window.__vivic!.getState().cards.map((card: { record: unknown }) => card.record)) as Array<{ id: string; type: string; displayProps: { fileId: string; name: string; parseStatus: string; previewText: string }; metadata: object }>;
    expect(records).toHaveLength(2);
    expect(records.every(card => card.type === "FileCard" && card.displayProps.parseStatus === "ready")).toBe(true);
    expect(records.find(card => card.displayProps.name === "sample.pdf")!.displayProps.previewText).toContain("TEST PDF document");
    const md = records.find(card => card.displayProps.name === "travel.md")!;
    await owner.evaluate(async ({ canvasId, cardId }) => { const { getControlHost } = await import("/src/sync/browserRuntime.ts"); const host = await getControlHost(); host.setCardPinned(cardId, true); host.dispatch({ schemaVersion: "0.6", requestId: "file-subcard", canvasId, actions: [{ type: "card.subcard.set", targetId: cardId, subcard: { id: "file-note", text: "TEST 文件补充说明" } }] }); host.setCardSurface(cardId, "user"); }, { canvasId, cardId: md.id });
    const userCard = owner.locator(`[data-vivic-user-card="${md.id}"]`);
    await userCard.getByRole("button", { name: "打开文件：travel.md" }).click();
    await expect(owner.getByLabel("文件只读预览")).toContainText("本周提交旅行演示。");
    await expect(owner.getByRole("textbox", { name: "关于文件的问题" })).toHaveCount(0);
    expect(await owner.evaluate(() => (window as Window & { FILE_EXECUTED?: boolean }).FILE_EXECUTED)).toBeUndefined();
    const download = owner.waitForEvent("download"); await owner.getByRole("button", { name: "下载原文件", exact: true }).click();
    const path = await (await download).path(); expect(await fs.readFile(path!, "utf8")).toBe(contents);
    await owner.route("**/api/files/read", async route => {
      const body = route.request().postDataJSON(); expect(body.text).toBe(contents); expect(body.name).toBe("travel.md");
      await route.fulfill({ json: { ok: true, answer: "TEST 本周提交旅行演示。", citations: [{ label: "第 2 行", quote: "本周提交旅行演示。" }] } });
    });
    await owner.getByRole("button", { name: "问 Vivic", exact: true }).click();
    await owner.getByRole("button", { name: "阅读并回答" }).click(); await expect(owner.getByLabel("文件阅读结果")).toContainText("第 2 行");
    await owner.screenshot({ path: info.outputPath("desktop-file-read.png") });
    await owner.getByRole("button", { name: "关闭窗口", exact: true }).click();
    await owner.evaluate(async id => { const { getControlHost } = await import("/src/sync/browserRuntime.ts"); (await getControlHost()).setCardSurface(id, "display"); }, md.id);
    const display = await desktop.newPage(); await display.goto("/display"); await expect(display.locator(`[data-card-id="${md.id}"]`)).toBeVisible();
    const code = await owner.evaluate(async ({ relayUrl, admissionSecret, moduleBase }) => {
      const [{ getControlHost }, { canvasStore }, { createComputerConnector }, { createWebSocketTransport }, { createVivicHostAdapter }, { projectMobileSubcards }, { createRemoteFileReader }] = await Promise.all([
        import("/src/sync/browserRuntime.ts"), import("/src/state/canvasStore.ts"), import(`${moduleBase}connector.ts`), import(`${moduleBase}transport.ts`), import(`${moduleBase}vivicHostAdapter.ts`), import("/src/control/mobile/projectSubcards.ts"), import("/src/files/remoteFiles.ts")]);
      const host = await getControlHost();
      const adapter = createVivicHostAdapter({ host, computerName: "TEST real owner", shareCardPreviews: true, projectSubcards: projectMobileSubcards, readFileChunk: createRemoteFileReader(), readCards: () => canvasStore.getState().cards, subscribeCards: canvasStore.subscribe, submitText: async () => ({ ok: false, message: "TEST no text provider" }) });
      const connector = createComputerConnector({ host: adapter, deviceId: "test-file-owner", deviceName: "TEST", transport: createWebSocketTransport(relayUrl), accessKey: admissionSecret }); connector.start();
      (window as Window & { testFileConnector?: unknown }).testFileConnector = connector;
      for (let i = 0; i < 100; i++) { if (connector.getSnapshot().pairCode) return connector.getSnapshot().pairCode; await new Promise(resolve => setTimeout(resolve, 50)); }
      throw new Error("test pairing failed");
    }, { relayUrl, admissionSecret, moduleBase });
    const phone = await mobile.newPage(); await phone.goto(`${origin}/src/control/mobile/index.html`);
    await phone.locator(".mobile-relay-details summary").click(); await phone.locator("#mobile-relay-url").fill(relayUrl); await phone.locator("#mobile-pair-code").fill(code!); await phone.getByRole("button", { name: "连接我的电脑" }).click();
    await phone.getByRole("tab", { name: "Space", exact: true }).click();
    const phoneCard = phone.locator(`[data-mobile-card-id="${md.id}"]`);
    await phoneCard.getByRole("button", { name: "查看子卡片：travel.md", exact: true }).click(); await expect(phone.locator(".mobile-subcards-sheet")).toContainText("TEST 文件补充说明"); await phone.getByRole("button", { name: "关闭子卡片" }).click();
    await phoneCard.getByRole("button", { name: "打开文件", exact: true }).click();
    await expect(phone.getByLabel("文件只读预览")).toContainText("本周提交旅行演示。");
    const phoneDownload = phone.waitForEvent("download"); await phone.getByRole("button", { name: "下载原文件", exact: true }).click();
    const phonePath = await (await phoneDownload).path(); expect(createHash("sha256").update(await fs.readFile(phonePath!)).digest("hex")).toBe(createHash("sha256").update(contents).digest("hex"));
    await phone.getByRole("button", { name: "关闭文件" }).click();
    await phoneCard.getByRole("button", { name: "移到聊天：travel.md", exact: true }).click();
    await expect(phone.locator("#mobile-chat")).toBeVisible(); await expect(phone.locator(`#mobile-chat [data-mobile-card-id="${md.id}"]`)).toHaveCount(1); await expect(phone.locator(`#mobile-space [data-mobile-card-id="${md.id}"]`)).toHaveCount(0);
    await expect(display.locator(`[data-card-id="${md.id}"]`)).toHaveCount(0); await expect(owner.locator(`[data-vivic-user-card="${md.id}"]`)).toBeVisible();
    await expect(phone.getByRole("textbox", { name: "发送给电脑的文字指令" })).toBeEnabled();
    await expect(phoneCard.getByRole("button", { name: "移回 Space：travel.md", exact: true })).toBeEnabled();
    await phone.waitForTimeout(800);
    await phone.screenshot({ path: info.outputPath("phone-portal-chat.png") });
    await phoneCard.getByRole("button", { name: "移回 Space：travel.md", exact: true }).click(); await expect(phone.locator("#mobile-space")).toBeVisible();
    await expect(display.locator(`[data-card-id="${md.id}"]`)).toBeVisible();
    await display.reload(); await expect(display.locator(`[data-card-id="${md.id}"]`)).toBeVisible();
    expect(await phone.evaluate(async () => (await indexedDB.databases()).map(db => db.name))).not.toContain("vivic-files");
    expect(await phone.evaluate(async () => (await indexedDB.databases()).map(db => db.name))).not.toContain("vivic");
    await phone.screenshot({ path: info.outputPath("phone-file-space.png") });
  } finally { await mobile.close(); await desktop.close(); await relay.close(); }
});
