import { describe, expect, it, vi } from "vitest";
import {
  ImageAttachmentSchema, ImageAttachmentsSchema, MAX_IMAGE_BYTES, assertImageAnalysisAvailable,
  imageInputErrorMessage, inspectImageBytes, validateImageAttachment,
} from "../src/images.js";
import { pngChunk, testJpegHeader, testPng, testWebpHeader } from "./images.fixture.js";

const attachment = (bytes = testPng(), mime = "image/png") => ({ type: "image", mime, data: bytes.toString("base64") });

describe("image request validation (generated TEST fixtures)", () => {
  it("accepts bounded canonical PNG bytes and exactly zero/one request attachments", () => {
    expect(ImageAttachmentSchema.parse(attachment())).toEqual(attachment());
    expect(ImageAttachmentsSchema.parse([])).toEqual([]);
    expect(ImageAttachmentsSchema.parse([attachment()])).toHaveLength(1);
    expect(ImageAttachmentsSchema.safeParse([attachment(), attachment()]).success).toBe(false);
  });
  it.each([
    "https://example.test/a.png", "file:///tmp/a.png", "/tmp/a.png", "data:image/png;base64,aGVsbG8=",
    "<svg/>", "<html>TEST</html>", "", "aGVsbG8=\n", "Zg===", "Zh==", "Zm9=", "SGVsbG8_", "====",
  ])("rejects paths, URLs, markup or noncanonical base64: %s", data => {
    expect(ImageAttachmentSchema.safeParse({ ...attachment(), data }).success).toBe(false);
  });
  it("rejects unknown fields and MIME spoofing despite valid image bytes", () => {
    for (const fields of [{ url: "https://example.test" }, { path: "/tmp/test" }, { filename: "TEST.png" }, { dataUrl: "TEST" }]) {
      expect(ImageAttachmentSchema.safeParse({ ...attachment(), ...fields }).success).toBe(false);
    }
    for (const mime of ["image/svg+xml", "text/html", "image/gif", "image/jpeg"]) {
      expect(ImageAttachmentSchema.safeParse(attachment(testPng(), mime)).success).toBe(false);
    }
    for (const bytes of [Buffer.from("<svg/>") , Buffer.from("<html>TEST</html>"), Buffer.from("https://example.test")]) {
      expect(ImageAttachmentSchema.safeParse(attachment(bytes)).success).toBe(false);
    }
  });
  it("enforces actual decoded byte length, including base64 padding near the 4 MiB boundary", () => {
    // 4 MiB + 1 has the same base64 character count as 4 MiB; length alone is insufficient.
    const png = testPng();
    const atSize = (size: number) => {
      const text = Buffer.alloc(size - png.length - 12, 65); text[1] = 0;
      return Buffer.concat([png.subarray(0, -12), pngChunk("tEXt", text), png.subarray(-12)]);
    };
    const exact = atSize(MAX_IMAGE_BYTES), tooLarge = atSize(MAX_IMAGE_BYTES + 1);
    expect(exact.toString("base64").length).toBe(tooLarge.toString("base64").length);
    expect(ImageAttachmentSchema.safeParse(attachment(exact)).success).toBe(true);
    expect(ImageAttachmentSchema.safeParse(attachment(tooLarge)).success).toBe(false);
    expect(ImageAttachmentSchema.safeParse({ ...attachment(), data: "A".repeat(4 * Math.ceil(MAX_IMAGE_BYTES / 3) + 4) }).success).toBe(false);
    expect(() => inspectImageBytes(new Uint8Array(0))).toThrow("4 MiB");
  });
  it.each([[0, 1], [1, 0], [8193, 1], [4001, 4000], [0xffffffff, 1]])("rejects PNG dimensions %s x %s", (w, h) => {
    expect(ImageAttachmentSchema.safeParse(attachment(testPng(w, h))).success).toBe(false);
  });
  it("rejects truncated, header-only, trailing, duplicate-header and animated PNGs", () => {
    const png = testPng();
    const variants = [png.subarray(0, 33), png.subarray(0, -1), Buffer.concat([png, Buffer.from("TEST")]),
      Buffer.concat([png.subarray(0, 33), png.subarray(8)]),
      Buffer.concat([png.subarray(0, 33), pngChunk("acTL", Buffer.alloc(8)), png.subarray(33)])];
    for (const bytes of variants) expect(ImageAttachmentSchema.safeParse(attachment(bytes)).success).toBe(false);
  });
  it("reads JPEG dimensions and requires a bounded SOF and scan/end markers", () => {
    const jpeg = testJpegHeader();
    expect(inspectImageBytes(jpeg)).toEqual({ mime: "image/jpeg", width: 2, height: 1 });
    expect(ImageAttachmentSchema.safeParse(attachment(jpeg, "image/jpeg")).success).toBe(true);
    for (const bytes of [jpeg.subarray(0, -2), testJpegHeader(8193, 1), Buffer.from([255, 216, 255, 217])]) {
      expect(() => inspectImageBytes(bytes)).toThrow();
    }
    const truncated = Buffer.from(jpeg); truncated.writeUInt16BE(65535, 4);
    expect(() => inspectImageBytes(truncated)).toThrow();
  });
  it("reads lossy/lossless/extended WebP dimensions and rejects animation and wrong RIFF length", () => {
    for (const extended of [false, true]) expect(inspectImageBytes(testWebpHeader(2, 1, extended))).toEqual({ mime: "image/webp", width: 2, height: 1 });
    const lossless = Buffer.alloc(26); lossless.write("RIFF"); lossless.writeUInt32LE(18, 4); lossless.write("WEBPVP8L", 8); lossless.writeUInt32LE(5, 16); lossless[20] = 47; lossless[21] = 1;
    expect(inspectImageBytes(lossless)).toEqual({ mime: "image/webp", width: 2, height: 1 });
    const wrongLength = testWebpHeader(); wrongLength.writeUInt32LE(0, 4);
    const mismatched = testWebpHeader(2, 1, true); mismatched[24] = 2;
    for (const bytes of [wrongLength, mismatched, testWebpHeader(2, 1, true, true), testWebpHeader().subarray(0, -1)]) {
      expect(() => inspectImageBytes(bytes)).toThrow();
    }
  });
  it("fails closed without a decoder and rejects corrupt pixels, oversized or mismatched decoded dimensions", async () => {
    await expect(validateImageAttachment(attachment())).rejects.toThrow("解码器");
    await expect(validateImageAttachment(attachment(), async () => { throw new Error("TEST_PRIVATE_SECRET"); })).rejects.toThrow("无法解码");
    await expect(validateImageAttachment(attachment(), async () => ({ width: 3, height: 1 }))).rejects.toThrow("不一致");
    await expect(validateImageAttachment(attachment(), async () => ({ width: 8193, height: 1 }))).rejects.toThrow("尺寸过大");
    const decoder = vi.fn(async () => ({ width: 2, height: 1 }));
    const result = await validateImageAttachment(attachment(), decoder);
    expect(decoder).toHaveBeenCalledWith(testPng(), "image/png");
    expect(result.width).toBe(2); expect(result.bytes).toEqual(testPng());
    decoder.mockClear();
    await expect(validateImageAttachment(attachment(Buffer.from("TEST")), decoder)).rejects.toThrow("格式不支持或文件已损坏");
    expect(decoder).not.toHaveBeenCalled();
  });
  it("does not surface arbitrary decoder errors or invent unavailable vision capability", () => {
    expect(imageInputErrorMessage(new Error("TEST_PRIVATE_SECRET"))).not.toContain("TEST_PRIVATE_SECRET");
    expect(() => assertImageAnalysisAvailable(false)).toThrow("没有可用的视觉模型");
    expect(() => assertImageAnalysisAvailable(true)).not.toThrow();
  });
  it("does not expose attacker-controlled unknown field names from Zod failures", async () => {
    await expect(validateImageAttachment({ ...attachment(), TEST_PRIVATE_SECRET: "TEST" })).rejects.not.toThrow("TEST_PRIVATE_SECRET");
  });
  it("bounds malformed input parsing without throwing raw DataView errors", () => {
    let seed = 12;
    for (let size = 1; size < 200; size++) {
      const bytes = Buffer.alloc(size);
      for (let i = 0; i < size; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; bytes[i] = seed & 255; }
      expect(() => ImageAttachmentSchema.safeParse(attachment(bytes))).not.toThrow();
    }
  });
});
