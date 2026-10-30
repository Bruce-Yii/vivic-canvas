const LIMIT = 80_000;
const decode = (bytes: Uint8Array) => new TextDecoder(bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8", { fatal: true }).decode(bytes);
self.onmessage = (event: MessageEvent<{ bytes: ArrayBuffer; limit?: number }>) => {
  try {
    const bytes = new Uint8Array(event.data.bytes);
    const text = decode(bytes);
    if (/\0/.test(text)) throw new Error("binary");
    const limit = Math.min(10_000_000, Math.max(LIMIT, event.data.limit ?? LIMIT));
    self.postMessage({ text: text.slice(0, limit), partial: text.length > limit });
  } catch { self.postMessage({ error: true }); }
};
