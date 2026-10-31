// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { imageFilesFromTransfer, inspectImageBytes, MAX_IMAGE_BYTES, prepareImageAttachment } from "../attachments";
import { inspectImageBytes as serverInspect } from "../../../../local-api/src/images";
import { testJpegHeader, testPng, testWebpHeader } from "../../../../local-api/tests/images.fixture";
import { installImageBrowserMocks, testImageFile } from "./attachments.harness";

let browser: ReturnType<typeof installImageBrowserMocks>;
beforeEach(() => { browser = installImageBrowserMocks(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("explicit control-tab image preparation", () => {
  it("decodes and canvas-reencodes, excluding original metadata and filename; releases both URLs", async () => {
    const original = testPng(2, 1, true);
    const result = await prepareImageAttachment([testImageFile(original)]);
    expect(browser.drawImage).toHaveBeenCalledOnce();
    expect(browser.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/png");
    expect(Buffer.from(result.attachment.data, "base64")).toEqual(testPng());
    expect(Buffer.from(result.attachment.data, "base64").toString()).not.toContain("TEST_PRIVATE_METADATA");
    expect(Object.keys(result.attachment).sort()).toEqual(["data", "mime", "type"]);
    expect(JSON.stringify(result.attachment)).not.toContain("TEST_PRIVATE_FILENAME");
    expect(result.attachment.mime).toBe("image/png");
    expect(browser.revokeObjectURL.mock.calls).toEqual([["blob:TEST-1"]]);
    result.dispose(); result.dispose();
    expect(browser.revokeObjectURL.mock.calls).toEqual([["blob:TEST-1"], ["blob:TEST-2"]]);
  });
  it("uses byte signatures with empty MIME and accepts JPEG/WebP input for PNG re-encoding", async () => {
    for (const [bytes, mime] of [[testPng(), ""], [testJpegHeader(), "image/jpeg"], [testWebpHeader(), "image/webp"]] as const) {
      const result = await prepareImageAttachment([testImageFile(bytes, mime)]);
      expect(result.attachment.mime).toBe("image/png"); result.dispose();
    }
  });
  it("rejects SVG, HTML, mismatched MIME, multiple or oversized files before decode", async () => {
    for (const files of [[], [testImageFile(), testImageFile()], [testImageFile(testPng(), "image/jpeg")],
      [testImageFile(Buffer.from("<svg/>"), "image/png")], [testImageFile(Buffer.from("<html>TEST</html>"), "text/html")],
      [testImageFile(new Uint8Array(MAX_IMAGE_BYTES + 1))]]) {
      await expect(prepareImageAttachment(files)).rejects.toThrow();
    }
    expect(browser.createObjectURL).not.toHaveBeenCalled();
  });
  it("checks original dimensions before decode and decoded dimensions before allocating a canvas", async () => {
    await expect(prepareImageAttachment([testImageFile(testPng(4001, 4000))])).rejects.toThrow("尺寸过大");
    expect(browser.createObjectURL).not.toHaveBeenCalled();
    browser.state.width = 8193;
    await expect(prepareImageAttachment([testImageFile()])).rejects.toThrow("尺寸过大");
    expect(browser.drawImage).not.toHaveBeenCalled();
    expect(browser.revokeObjectURL).toHaveBeenCalledWith("blob:TEST-1");
  });
  it("scales to a maximum edge of 1600 and checks encoded dimensions", async () => {
    browser.state.width = 3200; browser.state.height = 1600; browser.state.output = testPng(1600, 800);
    const result = await prepareImageAttachment([testImageFile(testPng(3200, 1600))]);
    expect(browser.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1600, 800);
    expect([result.width, result.height]).toEqual([1600, 800]); result.dispose();
  });
  it("permits EXIF orientation axis swaps only for JPEG", async () => {
    browser.state.width = 1; browser.state.height = 2; browser.state.output = testPng(1, 2);
    const result = await prepareImageAttachment([testImageFile(testJpegHeader(), "image/jpeg")]); result.dispose();
    await expect(prepareImageAttachment([testImageFile()])).rejects.toThrow("不一致");
  });
  it("rejects failed decodes and encoder failure while releasing the source URL", async () => {
    browser.state.mode = "error";
    await expect(prepareImageAttachment([testImageFile()])).rejects.toThrow("无法解码");
    expect(browser.revokeObjectURL).toHaveBeenCalledWith("blob:TEST-1");
    browser.state.mode = "load";
    browser.toBlob.mockImplementation(callback => callback(null));
    await expect(prepareImageAttachment([testImageFile()])).rejects.toThrow("缩略图");
    expect(browser.revokeObjectURL).toHaveBeenCalledWith("blob:TEST-2");
  });
  it("rejects encoded oversize or wrong byte formats and does not fall back to the original", async () => {
    browser.state.output = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    await expect(prepareImageAttachment([testImageFile()])).rejects.toThrow("重编码后的图片");
    browser.state.output = testJpegHeader();
    await expect(prepareImageAttachment([testImageFile()])).rejects.toThrow("格式或尺寸无效");
    expect(browser.createObjectURL).toHaveBeenCalledTimes(2);
  });
  it("aborts before any work and during decode without leaking object URLs", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(prepareImageAttachment([testImageFile()], { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(browser.createObjectURL).not.toHaveBeenCalled();
    const pending = new AbortController(); browser.state.mode = "pending";
    const promise = prepareImageAttachment([testImageFile()], { signal: pending.signal });
    const check = expect(promise).rejects.toMatchObject({ name: "AbortError" });
    await new Promise(resolve => setTimeout(resolve, 0)); pending.abort(); await check;
    expect(browser.revokeObjectURL).toHaveBeenCalledOnce();
    expect(browser.state.images[0].onload).toBeNull();
  });
  it("aborts encoding and times out a stuck decoder", async () => {
    const controller = new AbortController(); browser.state.encodePending = true;
    const promise = prepareImageAttachment([testImageFile()], { signal: controller.signal });
    const check = expect(promise).rejects.toMatchObject({ name: "AbortError" });
    await new Promise(resolve => setTimeout(resolve, 0)); controller.abort(); await check;
    expect(browser.revokeObjectURL).toHaveBeenCalledOnce();
    vi.useFakeTimers(); browser.state.mode = "pending";
    const stuck = prepareImageAttachment([testImageFile()]);
    const timeout = expect(stuck).rejects.toThrow("解码超时");
    await vi.advanceTimersByTimeAsync(15001); await timeout;
    expect(browser.revokeObjectURL).toHaveBeenCalledTimes(2);
  });
  it("extracts only explicitly supplied files; ignores clipboard HTML and URL strings", () => {
    const file = testImageFile(), getAsFile = vi.fn(() => file);
    const transfer = { files: [], items: [{ kind: "string", getAsFile }, { kind: "file", getAsFile }] } as unknown as DataTransfer;
    expect(imageFilesFromTransfer(transfer)).toEqual([file]); expect(getAsFile).toHaveBeenCalledOnce();
    expect(imageFilesFromTransfer({ files: [] as unknown as FileList, items: [] as unknown as DataTransferItemList })).toEqual([]);
  });
  it("keeps browser/server structural limits consistent for generated format fixtures", () => {
    for (const bytes of [testPng(), testJpegHeader(), testWebpHeader(), testWebpHeader(2, 1, true)]) {
      expect(inspectImageBytes(bytes)).toEqual(serverInspect(bytes));
    }
  });
});
