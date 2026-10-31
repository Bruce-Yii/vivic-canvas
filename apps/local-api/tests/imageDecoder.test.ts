import { Buffer } from "node:buffer";
import sharp from "sharp";
import type { Metadata, OutputInfo } from "sharp";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  decodeImage, IMAGE_DECODE_TIMEOUT_SECONDS, IMAGE_DECODE_WALL_TIMEOUT_MS, MAX_CONCURRENT_IMAGE_DECODES,
} from "../src/imageDecoder.js";
import type { ImageDecoder } from "../src/imageDecoder.js";
import {
  ImageAttachmentSchema, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, inspectImageBytes, validateImageAttachment,
} from "../src/images.js";
import type { ImageMime } from "../src/images.js";
import { pngChunk, testPng } from "./images.fixture.js";

const fixtures = new Map<ImageMime, Buffer>();
beforeAll(async () => {
  const pixel = Buffer.from([40, 100, 180]);
  for (const [mime, format] of [["image/png", "png"], ["image/jpeg", "jpeg"], ["image/webp", "webp"]] as const) {
    fixtures.set(mime, await sharp(pixel, { raw: { width: 1, height: 1, channels: 3 } }).toFormat(format).toBuffer());
  }
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function pngPart(bytes: Buffer, kind: string): { offset: number; length: number } {
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (bytes.toString("ascii", offset + 4, offset + 8) === kind) return { offset, length };
    offset += length + 12;
  }
  throw new Error("TEST chunk not found");
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function ticks() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
const png = () => fixtures.get("image/png")!;

describe("real Sharp 0.35.5 image decoder (generated TEST pixels only)", () => {
  it.each(["image/png", "image/jpeg", "image/webp"] as const)("fully decodes real 1x1 %s and integrates with the attachment gate", async mime => {
    const decode: ImageDecoder = decodeImage;
    const bytes = fixtures.get(mime)!, original = Buffer.from(bytes);
    expect(inspectImageBytes(bytes)).toEqual({ mime, width: 1, height: 1 });
    expect(await decode(bytes, mime)).toEqual({ width: 1, height: 1 });
    const result = await validateImageAttachment({ type: "image", mime, data: bytes.toString("base64") }, decode);
    expect([result.width, result.height]).toEqual([1, 1]);
    expect(Object.keys(await decode(bytes, mime)).sort()).toEqual(["height", "width"]);
    expect(bytes).toEqual(original); // Never wipes caller-owned bytes.
  });
  it("keeps JPEG dimensions in raw header orientation", async () => {
    const bytes = await sharp(Buffer.from([40, 100, 180, 70, 120, 200]), { raw: { width: 2, height: 1, channels: 3 } })
      .withMetadata({ orientation: 6 }).jpeg().toBuffer();
    expect((await sharp(bytes).metadata()).orientation).toBe(6);
    expect(await decodeImage(bytes, "image/jpeg")).toEqual({ width: 2, height: 1 });
  });
  it.each(["IHDR", "IDAT", "IEND"])("rejects corrupt PNG %s CRC with otherwise intact structure", async kind => {
    const bytes = Buffer.from(png()), { offset, length } = pngPart(bytes, kind);
    bytes[offset + 8 + length] ^= 1;
    expect(inspectImageBytes(bytes)).toEqual({ mime: "image/png", width: 1, height: 1 });
    await expect(decodeImage(bytes, "image/png")).rejects.toThrow();
  });
  it("checks ancillary PNG CRCs too, rather than trusting a decoder to read every chunk", async () => {
    const bytes = testPng(2, 1, true), { offset, length } = pngPart(bytes, "tEXt");
    bytes[offset + 8 + length] ^= 1;
    await expect(decodeImage(bytes, "image/png")).rejects.toThrow("CRC");
  });
  it("does not accept metadata-only success for corrupt PNG compressed pixels", async () => {
    const original = png(), { offset, length } = pngPart(original, "IDAT");
    const bytes = Buffer.concat([original.subarray(0, offset), pngChunk("IDAT", Buffer.alloc(length, 255)), original.subarray(offset + length + 12)]);
    expect(ImageAttachmentSchema.safeParse({ type: "image", mime: "image/png", data: bytes.toString("base64") }).success).toBe(true);
    expect((await sharp(bytes, { failOn: "warning" }).metadata()).width).toBe(1);
    await expect(decodeImage(bytes, "image/png")).rejects.toThrow("无法完整解码");
  });
  it("rejects JPEG scan corruption despite valid header dimensions and an EOI", async () => {
    const bytes = Buffer.from(fixtures.get("image/jpeg")!);
    const sos = bytes.indexOf(Buffer.from([255, 218]));
    const scanStart = sos + 2 + bytes.readUInt16BE(sos + 2);
    const corrupt = Buffer.concat([bytes.subarray(0, scanStart), Buffer.from([255, 0]), Buffer.from([255, 217])]);
    expect(inspectImageBytes(corrupt)).toEqual({ mime: "image/jpeg", width: 1, height: 1 });
    await expect(decodeImage(corrupt, "image/jpeg")).rejects.toThrow("无法完整解码");
  });
  it("rejects invalid WebP compressed data even when RIFF/VP8 size headers are intact", async () => {
    const bytes = Buffer.from(fixtures.get("image/webp")!);
    const p = bytes.indexOf(Buffer.from("VP8 "));
    expect(p).toBeGreaterThan(0);
    // Keep the frame signature + width/height; break the actual compressed stream only.
    bytes.fill(255, p + 8 + 10);
    expect(inspectImageBytes(bytes)).toEqual({ mime: "image/webp", width: 1, height: 1 });
    await expect(decodeImage(bytes, "image/webp")).rejects.toThrow("无法完整解码");
  });
  it.each([[8193, 1], [4001, 4000], [0, 1]])("rejects large/invalid header %sx%s before handing input to Sharp", async (width, height) => {
    const metadata = vi.spyOn(sharp.prototype, "metadata");
    await expect(decodeImage(testPng(width, height), "image/png")).rejects.toThrow();
    expect(metadata).not.toHaveBeenCalled();
  });
  it("checks byte limits, runtime type, genuine magic and MIME itself without invoking Sharp", async () => {
    const metadata = vi.spyOn(sharp.prototype, "metadata");
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(MAX_IMAGE_BYTES + 1), Buffer.from("<svg/>"), Buffer.from("https://example.test/TEST.png")]) {
      await expect(decodeImage(bytes, "image/png")).rejects.toThrow();
    }
    await expect(decodeImage("/tmp/TEST_PRIVATE_PATH.png" as unknown as Uint8Array, "image/png")).rejects.toThrow("路径或 URL");
    await expect(decodeImage(png(), "image/jpeg")).rejects.toThrow("类型与实际文件格式不一致");
    expect(metadata).not.toHaveBeenCalled();
  });
  it("checks a recomputed-CRC forged PNG header against real pixel decoding", async () => {
    const original = png(), { offset, length } = pngPart(original, "IHDR");
    const header = Buffer.from(original.subarray(offset + 8, offset + 8 + length)); header.writeUInt32BE(2);
    const forged = Buffer.concat([original.subarray(0, offset), pngChunk("IHDR", header), original.subarray(offset + length + 12)]);
    expect(inspectImageBytes(forged).width).toBe(2);
    expect((await sharp(forged, { failOn: "warning" }).metadata()).width).toBe(2);
    await expect(decodeImage(forged, "image/png")).rejects.toThrow("无法完整解码");
  });
  it("passes strict native options, disables cache and enforces a real processing timeout option", async () => {
    const timeout = vi.spyOn(sharp.prototype, "timeout"), raw = vi.spyOn(sharp.prototype, "raw");
    await decodeImage(png(), "image/png");
    expect(timeout).toHaveBeenCalledWith({ seconds: IMAGE_DECODE_TIMEOUT_SECONDS });
    expect(raw).toHaveBeenCalledWith({ depth: "uchar" });
    const options = (timeout.mock.instances[0] as unknown as { options: { input: Record<string, unknown> } }).options.input;
    expect(options).toMatchObject({ failOn: "warning", limitInputPixels: MAX_IMAGE_PIXELS, limitInputChannels: 4, sequentialRead: true });
    expect(sharp.cache().items.max).toBe(0); expect(sharp.cache().memory.max).toBe(0);
  });

  // Only scheduling/error-path tests below mock a promise; valid/corrupt format cases above use real codecs.
  it("admits exactly two jobs, rejects a third without queuing, and recovers after both finish", async () => {
    const gates = [deferred<Metadata>(), deferred<Metadata>()];
    const actualMetadata = await sharp(png()).metadata();
    const metadata = vi.spyOn(sharp.prototype, "metadata");
    metadata.mockImplementationOnce(() => gates[0].promise as never).mockImplementationOnce(() => gates[1].promise as never);
    const first = decodeImage(png(), "image/png"), second = decodeImage(png(), "image/png");
    try {
      expect(MAX_CONCURRENT_IMAGE_DECODES).toBe(2);
      await expect(decodeImage(png(), "image/png")).rejects.toThrow("最多同时处理 2 张");
      expect(metadata).toHaveBeenCalledTimes(2);
    } finally { for (const gate of gates) gate.resolve(actualMetadata); await Promise.all([first, second]); }
    expect(await decodeImage(png(), "image/png")).toEqual({ width: 1, height: 1 });
  });
  it("rejects on wall deadline without releasing either slot until pending native work settles", async () => {
    const actualMetadata = await sharp(png()).metadata(), gates = [deferred<Metadata>(), deferred<Metadata>()];
    const metadata = vi.spyOn(sharp.prototype, "metadata");
    metadata.mockImplementationOnce(() => gates[0].promise as never).mockImplementationOnce(() => gates[1].promise as never);
    const raw = vi.spyOn(sharp.prototype, "raw");
    vi.useFakeTimers();
    const first = decodeImage(png(), "image/png"), second = decodeImage(png(), "image/png");
    const checks = [expect(first).rejects.toThrow("超时"), expect(second).rejects.toThrow("超时")];
    try {
      await vi.advanceTimersByTimeAsync(IMAGE_DECODE_WALL_TIMEOUT_MS + 1); await Promise.all(checks);
      await expect(decodeImage(png(), "image/png")).rejects.toThrow("繁忙");
    } finally {
      for (const gate of gates) gate.resolve(actualMetadata); await ticks(); vi.useRealTimers();
    }
    expect(raw).not.toHaveBeenCalled();
    expect(await decodeImage(png(), "image/png")).toEqual({ width: 1, height: 1 });
  });
  it("wipes late raw pixels after a wall deadline and keeps both native slots reserved", async () => {
    const actualMetadata = await sharp(png()).metadata();
    vi.spyOn(sharp.prototype, "metadata").mockResolvedValue(actualMetadata);
    const gates = [deferred<{ data: Buffer; info: OutputInfo }>(), deferred<{ data: Buffer; info: OutputInfo }>()];
    const toBuffer = vi.spyOn(sharp.prototype, "toBuffer");
    toBuffer.mockImplementationOnce(() => gates[0].promise as never).mockImplementationOnce(() => gates[1].promise as never);
    const pixels = [Buffer.alloc(3, 123), Buffer.alloc(3, 124)];
    vi.useFakeTimers();
    const first = decodeImage(png(), "image/png"), second = decodeImage(png(), "image/png");
    const checks = [expect(first).rejects.toThrow("超时"), expect(second).rejects.toThrow("超时")];
    try {
      await ticks(); expect(toBuffer).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(IMAGE_DECODE_WALL_TIMEOUT_MS + 1); await Promise.all(checks);
      await expect(decodeImage(png(), "image/png")).rejects.toThrow("繁忙");
    } finally {
      for (const [index, gate] of gates.entries()) gate.resolve({ data: pixels[index], info: { width: 1, height: 1, channels: 3, format: "raw" } as OutputInfo });
      await ticks(); vi.useRealTimers();
    }
    expect(pixels.every(buffer => buffer.every(byte => byte === 0))).toBe(true);
    expect(await decodeImage(png(), "image/png")).toEqual({ width: 1, height: 1 });
  });
  it("checks metadata dimensions, channels and frames before raw pixels", async () => {
    const actual = await sharp(png()).metadata(), raw = vi.spyOn(sharp.prototype, "raw");
    const metadata = vi.spyOn(sharp.prototype, "metadata");
    for (const override of [{ width: 2 }, { pages: 2 }, { channels: 5 }, { format: "svg" }]) {
      metadata.mockResolvedValueOnce({ ...actual, ...override } as Metadata);
      await expect(decodeImage(png(), "image/png")).rejects.toThrow();
    }
    expect(raw).not.toHaveBeenCalled();
  });
  it("checks raw dimensions and output length and wipes pixels even after a decode-result failure", async () => {
    const buffer = vi.spyOn(sharp.prototype, "toBuffer");
    const info = { width: 1, height: 1, channels: 3, format: "raw" } as OutputInfo;
    for (const [length, override] of [[3, { width: 2 }], [2, {}], [3, { channels: 5 }], [3, { format: "png" }]] as const) {
      const pixels = Buffer.alloc(length, 123);
      buffer.mockResolvedValueOnce({ data: pixels, info: { ...info, ...override } } as never);
      await expect(decodeImage(png(), "image/png")).rejects.toThrow("完整解码结果");
      expect(pixels.every(byte => byte === 0)).toBe(true);
    }
  });
  it("does not retain returned pixels or use a caller-mutated buffer during an await", async () => {
    const input = Buffer.from(png()), gate = deferred<Metadata>();
    const actual = await sharp(input).metadata();
    vi.spyOn(sharp.prototype, "metadata").mockImplementationOnce(() => gate.promise as never);
    const toBuffer = vi.spyOn(sharp.prototype, "toBuffer");
    const pending = decodeImage(input, "image/png"); input.fill(0); gate.resolve(actual);
    expect(await pending).toEqual({ width: 1, height: 1 });
    const result = await toBuffer.mock.results[0].value as { data: Buffer; info: OutputInfo };
    expect(result.data.every(byte => byte === 0)).toBe(true);
  });
  it("sanitizes native errors and frees a slot after rejection", async () => {
    vi.spyOn(sharp.prototype, "metadata").mockRejectedValueOnce(new Error("TEST_PRIVATE_PATH /tmp/TEST_IMAGE"));
    await expect(decodeImage(png(), "image/png")).rejects.toThrow("图片无法完整解码或文件已损坏。");
    expect(await decodeImage(png(), "image/png")).toEqual({ width: 1, height: 1 });
  });
  it("maps a native timeout to a fixed user error and frees its slot", async () => {
    vi.spyOn(sharp.prototype, "toBuffer").mockRejectedValueOnce(new Error("TEST_PRIVATE_IMAGE timeout after 3 seconds"));
    await expect(decodeImage(png(), "image/png")).rejects.toThrow("图片解码超时，请尝试更小的图片。");
    expect(await decodeImage(png(), "image/png")).toEqual({ width: 1, height: 1 });
  });
});
