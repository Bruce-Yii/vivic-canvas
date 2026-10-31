import { expect, test } from "@playwright/test";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import { openCardPackages, showChat } from "./helpers1";

async function externalPackage() {
  const source = path.resolve(process.cwd(), "../../examples/card-packages/goal-progress"), files: Record<string, Uint8Array> = {};
  for (const name of ["manifest.json", "config.schema.json", "data.schema.json", "state.schema.json", "ui.json"]) files[name] = await readFile(path.join(source, name));
  for (const name of await readdir(path.join(source, "examples"))) files[`examples/${name}`] = await readFile(path.join(source, "examples", name));
  const directory = await mkdtemp(path.join(tmpdir(), "vivic-external-card-")), file = path.join(directory, "goal.vivicard");
  await writeFile(file, zipSync(files)); return file;
}
test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    HTMLMediaElement.prototype.play = async () => { throw new Error("TEST audio disabled"); };
    navigator.mediaDevices.getUserMedia = async () => { throw new Error("TEST microphone disabled"); };
  });
});
test("external declarative package validates, stays isolated, installs, restores and survives disabled/missing definition", async ({ page }, info) => {
  const file = await externalPackage();
  await page.goto("/control");
  await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "owner");
  await openCardPackages(page);
  await page.locator("[data-extension-file]").setInputFiles(file);
  const dialog = page.getByRole("dialog", { name: "Vivic Test Space" });
  await expect(dialog).toBeVisible(); await expect(dialog.getByRole("button", { name: "安装卡片", exact: true })).toBeDisabled();
  await expect(page.locator("[data-extension-installed]")).toHaveCount(0);
  await expect(page.locator("[data-vivic-user-card]")).toHaveCount(0);
  await expect(dialog.locator("[data-extension-rendered]")).toHaveCount(1);
  for (const theme of ["milk", "peach", "lilac", "mint", "dawn", "berry", "graphite", "midnight", "ocean", "velvet", "ember", "forest"]) {
    await dialog.getByLabel("预览主题配色").selectOption(theme);
    await expect(dialog.locator("[data-extension-rendered]")).toBeVisible();
  }
  await dialog.getByLabel("预览模式").selectOption("display");
  await expect(dialog.locator("[data-scene-card='ExtensionCard']")).toHaveAttribute("data-mode", "display");
  await dialog.getByLabel("预览样例").selectOption("2");
  await dialog.screenshot({ path: info.outputPath("test-space-dark-display.png") });
  await dialog.getByLabel("预览主题配色").selectOption("milk"); await dialog.getByLabel("预览模式").selectOption("control");
  await dialog.screenshot({ path: info.outputPath("test-space-light-user.png") });
  await dialog.getByRole("button", { name: "试跑 DEMO", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "安装卡片", exact: true })).toBeEnabled();
  const title = dialog.getByLabel("目标名称", { exact: true }); await title.fill(""); await title.blur();
  await expect(dialog.getByRole("button", { name: "安装卡片", exact: true })).toBeDisabled();
  await expect(dialog.getByText("参数有错误，请修正后试跑")).toBeVisible();
  await title.fill("外部导入目标"); await title.blur();
  await expect(dialog.getByRole("button", { name: "安装卡片", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "试跑 DEMO", exact: true }).click();
  await dialog.getByRole("button", { name: "安装卡片", exact: true }).click(); await expect(dialog).toBeHidden();
  const installed = page.locator("[data-extension-installed='vivic.goal-progress']"); await expect(installed).toBeVisible();
  await expect(page.locator("[data-vivic-user-card]")).toHaveCount(0);
  // Installation publishes only a definition. Creating an instance is a separate owner action.
  await installed.getByRole("button", { name: "从 DEMO 创建卡片" }).click();
  await showChat(page); await expect(page.locator("[data-extension-rendered='vivic.goal-progress']")).toBeVisible();
  await page.reload(); await expect(page.locator("[data-extension-rendered='vivic.goal-progress']")).toBeVisible();
  await openCardPackages(page);
  await installed.getByRole("button", { name: "禁用", exact: true }).click();
  await showChat(page); await expect(page.getByText("原始卡片数据已保留", { exact: false })).toBeVisible();
  await openCardPackages(page); await installed.getByRole("button", { name: "启用", exact: true }).click();
  await showChat(page); await expect(page.locator("[data-extension-rendered='vivic.goal-progress']")).toBeVisible();
  await openCardPackages(page); await installed.getByRole("button", { name: "卸载", exact: true }).click();
  await expect(installed).toHaveCount(0);
  await page.reload(); await showChat(page); await expect(page.getByText("原始卡片数据已保留", { exact: false })).toBeVisible();
  await openCardPackages(page); await page.locator("[data-extension-file]").setInputFiles(file);
  await dialog.getByRole("button", { name: "试跑 DEMO", exact: true }).click(); await dialog.getByRole("button", { name: "安装卡片", exact: true }).click(); await expect(dialog).toBeHidden();
  await showChat(page); await expect(page.locator("[data-extension-rendered='vivic.goal-progress']")).toHaveCount(1);
});
test("closing or replacing a preview never installs it and malformed packages give a file error", async ({ page }) => {
  const file = await externalPackage(); await page.goto("/control"); await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "owner");
  await openCardPackages(page);
  await page.locator("[data-extension-file]").setInputFiles(file);
  await expect(page.getByRole("dialog", { name: "Vivic Test Space" })).toBeVisible();
  await page.keyboard.press("Escape"); await expect(page.getByRole("dialog", { name: "Vivic Test Space" })).toBeHidden();
  await expect(page.locator("[data-extension-installed]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "导入卡片包" })).toBeFocused();
  await page.locator("[data-extension-file]").setInputFiles({ name: "invalid.vivicard", mimeType: "application/zip", buffer: Buffer.from("bad") });
  await expect(page.locator("[data-extension-manager]")).toContainText("需要至多 1 MiB");
  await expect(page.getByRole("dialog", { name: "Vivic Test Space" })).toBeHidden();
});
