import { expect, test } from "@playwright/test";
import { createRequire } from "node:module";
import { gotoControl, showChat, activeCanvasId, gotoDisplay } from "./helpers1";
const sharp = createRequire(new URL("../../../local-api/package.json", import.meta.url))("sharp") as typeof import("sharp");

test("PDF reader paints a normal 300dpi scanned A4 page without OCR or a model", async ({ context }) => {
  const jpeg = await sharp({ create: { width: 2480, height: 3508, channels: 3, background: "white" } }).composite([{ input: Buffer.from('<svg width="2480" height="3508"><rect x="220" y="260" width="1500" height="100" fill="black"/><rect x="220" y="480" width="1800" height="50" fill="black"/></svg>') }]).jpeg().toBuffer();
  const stream = "q 595 0 0 842 0 0 cm /Scan Do Q";
  const bodies = [Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"), Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Scan 5 0 R >> >> /Contents 4 0 R >>"),
    Buffer.from(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`),
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 2480 /Height 3508 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, Buffer.from("\nendstream")])];
  const parts = [Buffer.from("%PDF-1.4\n")], offsets = [0]; let length = parts[0]!.length;
  bodies.forEach((body, i) => { offsets.push(length); const part = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from("\nendobj\n")]); parts.push(part); length += part.length; });
  parts.push(Buffer.from(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${length}\n%%EOF`));
  const owner = await gotoControl(context); await showChat(owner);
  await owner.locator('[data-vivic-chat] input[aria-label="选择文件"]').setInputFiles({ name: "扫描页.pdf", mimeType: "application/pdf", buffer: Buffer.concat(parts) });
  await expect(owner.getByText("已保存 1 张文件卡片到 Space", { exact: true })).toBeVisible();
  const display = await gotoDisplay(context, await activeCanvasId(owner));
  await display.getByRole("button", { name: "打开文件：扫描页.pdf", exact: true }).click();
  const canvas = display.locator('canvas[data-pdf-ready="true"]'); await expect(canvas).toBeVisible();
  expect(await canvas.evaluate((node: HTMLCanvasElement) => {
    const data = node.getContext("2d")!.getImageData(0, 0, node.width, Math.min(300, node.height)).data; let ink = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i + 3]! > 200 && data[i]! + data[i + 1]! + data[i + 2]! < 400) ink++;
    return ink;
  })).toBeGreaterThan(1000);
});
