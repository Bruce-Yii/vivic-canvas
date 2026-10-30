import { SpaceError } from "../space/errors.js";

export function hostedJson(value: unknown, status = 200, extra?: HeadersInit) {
  const headers = new Headers(extra);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(value), { status, headers });
}
export function hostedFailure(error: unknown): Response {
  if (error instanceof SpaceError) return hostedJson({ ok: false, code: error.code, message: error.message,
    ...(error.version === undefined ? {} : { version: error.version }) }, error.status);
  return hostedJson({ ok: false, code: "storage-unavailable", message: "本次处理或保存尚未确认，请查询原请求状态。" }, 503);
}
export async function boundedBytes(request: Request, maximum: number): Promise<Uint8Array<ArrayBuffer>> {
  if (Number(request.headers.get("content-length")) > maximum) throw new SpaceError(413, "body-limit", "上传内容超过大小限制。");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      request.signal.throwIfAborted();
      const part = await reader.read();
      request.signal.throwIfAborted(); if (part.done) break;
      length += part.value.byteLength;
      if (length > maximum) throw new SpaceError(413, "body-limit", "上传内容超过大小限制。");
      chunks.push(part.value);
    }
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { request.signal.removeEventListener("abort", abort); reader.releaseLock(); }
  return new Uint8Array(Buffer.concat(chunks, length));
}
export async function hostedBody(request: Request, maximum = 64 * 1024): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") throw new SpaceError(415, "json-required", "请求需要JSON格式。");
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await boundedBytes(request, maximum))); }
  catch (error) { if (error instanceof SpaceError) throw error; throw new SpaceError(400, "invalid-json", "请求内容无效。"); }
}
export async function hostedForm(request: Request, maximum: number): Promise<FormData> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("multipart/form-data;")) throw new SpaceError(415, "form-required", "请选择文件后上传。");
  try { return await new Response(await boundedBytes(request, maximum), { headers: { "content-type": type } }).formData(); }
  catch (error) { if (error instanceof SpaceError) throw error; throw new SpaceError(400, "invalid-upload", "上传格式不完整，请重试。"); }
}
