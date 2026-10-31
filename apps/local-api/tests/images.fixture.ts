/** Self-generated TEST-only fixtures; no external/user images. */
import { deflateSync } from "node:zlib";

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function pngChunk(kind: string, data: Uint8Array): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length); chunk.write(kind, 4); chunk.set(data, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}
/** Real decodable RGBA PNG. Header overrides exercise decompression-bomb preflight without large allocations. */
export function testPng(width = 2, height = 1, metadata = false): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const row = Buffer.from([0, 40, 100, 180, 255, 200, 100, 40, 255]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header),
    ...(metadata ? [pngChunk("tEXt", Buffer.from("Comment\0TEST_PRIVATE_METADATA"))] : []),
    pngChunk("IDAT", deflateSync(row)), pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
/** Structural JPEG/WebP header fixtures, deliberately NOT claims of codec-decodable images. */
export function testJpegHeader(width = 2, height = 1): Buffer {
  const bytes = Buffer.from([255, 216, 255, 192, 0, 11, 8, 0, 1, 0, 2, 1, 1, 17, 0, 255, 218, 0, 8, 1, 1, 0, 0, 63, 0, 1, 255, 217]);
  bytes.writeUInt16BE(height, 7); bytes.writeUInt16BE(width, 9); return bytes;
}
export function webpChunk(kind: string, data: Uint8Array): Buffer {
  const chunk = Buffer.alloc(8 + data.length + data.length % 2);
  chunk.write(kind); chunk.writeUInt32LE(data.length, 4); chunk.set(data, 8); return chunk;
}
export function testWebpHeader(width = 2, height = 1, extended = false, animation = false): Buffer {
  const frame = Buffer.alloc(10); frame.set([0, 0, 0, 157, 1, 42]);
  frame.writeUInt16LE(width, 6); frame.writeUInt16LE(height, 8);
  const vp8x = Buffer.alloc(10); vp8x[0] = animation ? 2 : 0;
  vp8x.writeUIntLE(width - 1, 4, 3); vp8x.writeUIntLE(height - 1, 7, 3);
  const chunks = Buffer.concat([...(extended ? [webpChunk("VP8X", vp8x)] : []), webpChunk("VP8 ", frame)]);
  const header = Buffer.alloc(12); header.write("RIFF"); header.writeUInt32LE(chunks.length + 4, 4); header.write("WEBP", 8);
  return Buffer.concat([header, chunks]);
}
