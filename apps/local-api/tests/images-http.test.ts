import { Buffer } from "node:buffer";
import sharp from "sharp";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ActionEnvelopeSchema } from "@vivic/contracts";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { CredentialStore } from "../src/credentials.js";
import { GptProvider } from "../src/gpt/provider.js";
import { decodeImage } from "../src/imageDecoder.js";
import type { ImageDecoder } from "../src/imageDecoder.js";
import { ImageAttachmentSchema, MAX_IMAGE_BYTES } from "../src/images.js";
import type { Attachment } from "../src/images.js";
import { IntentResponseSchema } from "../src/schemas.js";
import { authed, chatOk, emptyContext, modelsOk, testConfig } from "./helpers.js";
import { pngChunk, testPng } from "./images.fixture.js";

// Hono app.request runs the actual middleware/routes/pipeline in memory. No listening socket,
// browser, auth file, user image or live StepFun/search request is used by this suite.
vi.mock("../src/search/transport.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/search/transport.js")>(),
  requestPublicHttps: vi.fn(() => { throw new Error("TEST forbids external image/search transport"); }),
}));
import { requestPublicHttps } from "../src/search/transport.js";

const KEY = "TEST-image-http-private-stepfun-key";
const NEW_KEY = "TEST-image-http-replacement-stepfun-key";
const VISION_MODEL = "step-3.7-flash";
const TEXT_MODEL = "step-3.5-flash";
const OTHER_VISION_MODEL = "step-5-preview";
const MODELS = [TEXT_MODEL, VISION_MODEL, OTHER_VISION_MODEL];
const INVALID_AUTH_HEADERS: Record<string, string>[] = [{}, { authorization: "Bearer TEST-wrong-token" }];
const CHAT_URL = "https://unit.test/v1/chat/completions";
const MODEL_URL = "https://unit.test/v1/models";
const PLAN = { actions: [{ type: "canvas.fit" }], spokenText: "TEST 图片请求完成" };
type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
interface ChatRequest { model: string; messages: Array<{ role: string; content: string | Part[] }>; max_tokens?: number }
let png: Buffer, attachment: Attachment;

beforeAll(async () => {
  png = await sharp(Buffer.from([40, 100, 180]), { raw: { width: 1, height: 1, channels: 3 } }).png().toBuffer();
  attachment = { type: "image", mime: "image/png", data: png.toString("base64") };
});
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("TEST forbids ambient network"); }));
  vi.mocked(requestPublicHttps).mockClear();
});
afterEach(() => {
  const ambientCalls = vi.mocked(fetch).mock.calls.length;
  const externalCalls = vi.mocked(requestPublicHttps).mock.calls.length;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  expect(ambientCalls, "No image may reach ambient fetch").toBe(0);
  expect(externalCalls, "No external image URL/search may be fetched").toBe(0);
});

function imageUrls(body: ChatRequest): string[] {
  return body.messages.flatMap(message => typeof message.content === "string" ? [] :
    message.content.flatMap(part => part.type === "image_url" ? [part.image_url.url] : []));
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(options: { model?: string; connected?: boolean; decoder?: ImageDecoder; defaultDecoder?: boolean } = {}) {
  const credentials = new CredentialStore();
  if (options.connected !== false) credentials.set({ apiKey: KEY, models: [...MODELS], defaultModel: options.model ?? VISION_MODEL, checkedAt: "TEST" });
  const calls: Array<{ url: string; body?: ChatRequest }> = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as ChatRequest : undefined;
    calls.push({ url, body });
    if (url === MODEL_URL) return modelsOk([VISION_MODEL, OTHER_VISION_MODEL]);
    if (url === CHAT_URL && body) return chatOk(body.max_tokens === 256 ? { ok: true } : PLAN);
    throw new Error("TEST forbids all unlisted endpoints");
  });
  // Supplying both stores ensures no provider-switch test can read host OAuth credentials.
  const gpt = new GptProvider({ fetchImpl, ownStorage: new InMemoryCredentialStore(), piStorage: new InMemoryCredentialStore() });
  const decoder = vi.fn<ImageDecoder>(options.decoder ?? decodeImage);
  const app = createApp({ config: testConfig({ requestTimeoutMs: 2000, connectionTimeoutMs: 2000 }), credentials, gpt, fetchImpl,
    ...(options.defaultDecoder ? {} : { imageDecoder: decoder }),
  });
  const post = (path: string, body: unknown, headers: Record<string, string> = authed, signal?: AbortSignal) =>
    app.request(path, { method: "POST", headers, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
  const context = emptyContext([{ id: "TEST-existing-note", type: "NoteCard", displayProps: { text: "TEST existing text" },
    sourceDataSummary: {}, layout: { x: 0, y: 0 } }]);
  const intent = (images: unknown = [attachment], text = "请根据这张图片梳理内容", signal?: AbortSignal) =>
    post("/api/intent", { text, canvasContext: context, attachments: images }, authed, signal);
  const imageCalls = () => calls.filter(call => call.body && imageUrls(call.body).length);
  return { app, credentials, decoder, fetchImpl, calls, post, context, intent, imageCalls };
}
function expectPrivate(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(attachment.data);
  expect(serialized).not.toContain("data:image/");
  expect(serialized).not.toContain(KEY); expect(serialized).not.toContain(NEW_KEY);
}

describe("image HTTP security through createApp + real Sharp + mocked StepFun", () => {
  it.each(INVALID_AUTH_HEADERS)("requires local authentication before decode or outbound image use (%j)", async headers => {
    const f = fixture();
    const response = await f.post("/api/intent", { text: "分析这张图片", canvasContext: f.context, attachments: [attachment] },
      { "content-type": "application/json", ...headers });
    expect(response.status).toBe(401); expectPrivate(await response.json());
    expect(f.decoder).not.toHaveBeenCalled(); expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects a foreign origin even with a valid local bearer", async () => {
    const f = fixture();
    const response = await f.post("/api/intent", { text: "分析这张图片", canvasContext: f.context, attachments: [attachment] },
      { ...authed, origin: "https://TEST-untrusted.example" });
    expect(response.status).toBe(403); expect(f.decoder).not.toHaveBeenCalled(); expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it.each([{ connected: false }, { model: TEXT_MODEL }])("does not decode/send images or fall back to text/rules without vision (%j)", async options => {
    const f = fixture(options);
    // An image must not be silently dropped to execute this otherwise-valid local rule.
    const response = await f.intent([attachment], "十分钟倒计时");
    expect(response.status).toBe(200);
    const body = IntentResponseSchema.parse(await response.json());
    expect(body.kind).toBe("error"); expect(body.message).toContain("视觉"); expect(body.envelope).toBeUndefined(); expectPrivate(body);
    expect(f.decoder).not.toHaveBeenCalled(); expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it("does not fall back to connected StepFun when disconnected GPT is the selected provider", async () => {
    const f = fixture();
    expect(await (await f.post("/api/providers/select", { provider: "gpt" })).json()).toMatchObject({ ok: true });
    const body = IntentResponseSchema.parse(await (await f.intent()).json());
    expect(body.kind).toBe("error"); expect(body.message).toContain("视觉");
    expect(f.decoder).not.toHaveBeenCalled(); expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it("decodes a genuine PNG with the app's default Sharp and sends one image_url only in the current user message", async () => {
    const f = fixture({ defaultDecoder: true });
    const before = structuredClone(f.context), response = await f.intent();
    expect(response.status).toBe(200);
    const body = IntentResponseSchema.parse(await response.json());
    expect(body).toMatchObject({ kind: "envelope", usedProvider: "stepfun" });
    expect(ActionEnvelopeSchema.safeParse(body.envelope).success).toBe(true); expectPrivate(body);
    expect(f.calls).toHaveLength(1); expect(f.calls[0].url).toBe(CHAT_URL);
    const request = f.calls[0].body!;
    expect(request.model).toBe(VISION_MODEL); expect(request.messages).toHaveLength(2);
    expect(request.messages[0].role).toBe("system"); expectPrivate(request.messages[0]);
    const user = request.messages[1];
    expect(user.role).toBe("user"); expect(Array.isArray(user.content)).toBe(true);
    if (typeof user.content === "string") throw new Error("TEST requires structured multimodal content");
    expect(user.content).toEqual([{ type: "text", text: expect.any(String) },
      { type: "image_url", image_url: { url: `data:image/png;base64,${attachment.data}` } }]);
    const part = user.content[0];
    if (part.type !== "text") throw new Error("TEST requires a separate text prompt");
    const prompt = JSON.parse(part.text) as { utterance: string; canvas: { canvasId: string }; attachments?: unknown };
    expect(prompt.canvas.canvasId).toBe(f.context.canvasId); expect(prompt).not.toHaveProperty("attachments"); expectPrivate(prompt);
    expect(imageUrls(request)).toEqual([`data:image/png;base64,${attachment.data}`]);
    expect(f.context).toEqual(before); expectPrivate(f.context);

    const followUp = await f.post("/api/intent", { text: "请梳理本次思路", canvasContext: f.context });
    expect(IntentResponseSchema.parse(await followUp.json()).kind).toBe("envelope");
    expect(f.calls).toHaveLength(2); expectPrivate(f.calls[1].body); expect(imageUrls(f.calls[1].body!)).toEqual([]);
    const status = await f.app.request("/api/providers/status", { headers: authed });
    expectPrivate(await status.json()); expectPrivate(f.credentials.status());
  });
  it("rejects corrupt compressed pixels that pass the request schema and metadata", async () => {
    let offset = 8;
    while (png.toString("ascii", offset + 4, offset + 8) !== "IDAT") offset += png.readUInt32BE(offset) + 12;
    const length = png.readUInt32BE(offset);
    const corrupt = Buffer.concat([png.subarray(0, offset), pngChunk("IDAT", Buffer.alloc(length, 255)), png.subarray(offset + length + 12)]);
    const input = { ...attachment, data: corrupt.toString("base64") };
    expect(ImageAttachmentSchema.safeParse(input).success).toBe(true);
    expect((await sharp(corrupt, { failOn: "warning" }).metadata()).width).toBe(1);
    const f = fixture(), response = await f.intent([input]);
    expect(response.status).toBe(200);
    const body = IntentResponseSchema.parse(await response.json());
    expect(body.kind).toBe("error"); expect(body.message).toMatch(/解码|损坏/); expectPrivate(body);
    expect(f.decoder).toHaveBeenCalledOnce(); expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it.each([
    ["encoded image exceeds 4 MiB", () => [{ ...attachment, data: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString("base64") }]],
    ["header exceeds max pixels", () => [{ ...attachment, data: testPng(4001, 4000).toString("base64") }]],
    ["header exceeds max edge", () => [{ ...attachment, data: testPng(8193, 1).toString("base64") }]],
    ["remote URL as data", () => [{ ...attachment, data: "https://example.test/TEST-image.png" }]],
    ["local path as data", () => [{ ...attachment, data: "/tmp/TEST-private-image.png" }]],
    ["data URL as data", () => [{ ...attachment, data: `data:image/png;base64,${attachment.data}` }]],
    ["remote url field", () => [{ type: "image", mime: "image/png", url: "https://example.test/TEST-image.png" }]],
    ["spoofed MIME", () => [{ ...attachment, mime: "image/jpeg" }]],
    ["SVG disguised as PNG", () => [{ ...attachment, data: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>").toString("base64") }]],
    ["multiple attachments", () => [attachment, attachment]],
  ] as const)("rejects %s before native decode or upstream access", async (_label, input) => {
    const f = fixture(), response = await f.intent(input());
    expect(response.status).toBe(400); expectPrivate(await response.json());
    expect(f.decoder).not.toHaveBeenCalled(); expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it("enforces the actual 6 MiB body cap without trusting a Content-Length header", async () => {
    const f = fixture();
    const response = await f.intent([{ ...attachment, data: "A".repeat(6 * 1024 * 1024) }]);
    expect(response.status).toBe(413); expectPrivate(await response.json());
    expect(f.decoder).not.toHaveBeenCalled(); expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  const changes = ["disconnect key", "replace key", "switch to text model", "switch to another vision model", "provider round trip"] as const;
  it.each(changes)("never sends the old attachment when %s happens while real decode is returning", async change => {
    const decoded = deferred<void>(), release = deferred<void>();
    const f = fixture({ decoder: async (bytes, mime) => {
      const result = await decodeImage(bytes, mime); // Actual full decode succeeds before the session changes.
      decoded.resolve(); await release.promise; return result;
    } });
    const pending = Promise.resolve(f.intent());
    let changeFailure: unknown;
    try {
      await decoded.promise; expect(f.fetchImpl).not.toHaveBeenCalled();
      if (change === "disconnect key") {
        expect(await (await f.post("/api/credentials/stepfun/disconnect", {})).json()).toMatchObject({ ok: true, connected: false });
      } else if (change === "replace key") {
        expect(await (await f.post("/api/credentials/stepfun/validate", { apiKey: NEW_KEY })).json()).toMatchObject({ ok: true, defaultModel: VISION_MODEL });
      } else if (change === "provider round trip") {
        expect(await (await f.post("/api/providers/select", { provider: "gpt" })).json()).toMatchObject({ ok: true, activeProvider: "gpt" });
        expect(await (await f.post("/api/providers/select", { provider: "stepfun" })).json()).toMatchObject({ ok: true, activeProvider: "stepfun" });
      } else {
        const model = change === "switch to text model" ? TEXT_MODEL : OTHER_VISION_MODEL;
        expect(await (await f.post("/api/providers/model", { provider: "stepfun", model })).json()).toMatchObject({ ok: true, defaultModel: model });
      }
    } catch (error) { changeFailure = error; }
    finally { release.resolve(); }
    const response = await pending;
    if (changeFailure) throw changeFailure;
    const body = IntentResponseSchema.parse(await response.json());
    expect(f.decoder).toHaveBeenCalledOnce();
    // Connection/model selection probes may occur, but they must never contain an old image.
    expect(f.imageCalls()).toEqual([]);
    expect(body.kind).toBe("error"); expect(body.envelope).toBeUndefined(); expect(body.message).toMatch(/变更|取消|连接|视觉/); expectPrivate(body);
    for (const call of f.calls) if (call.body) expectPrivate(call.body);
  });
  it("does not send an attachment when the HTTP request is cancelled during decoder return", async () => {
    const decoded = deferred<void>(), release = deferred<void>(), controller = new AbortController();
    const f = fixture({ decoder: async (bytes, mime) => {
      const result = await decodeImage(bytes, mime); decoded.resolve(); await release.promise; return result;
    } });
    const pending = Promise.resolve(f.intent([attachment], "分析这张图片", controller.signal));
    try { await decoded.promise; controller.abort(new Error("TEST_PRIVATE_ABORT_REASON")); }
    finally { release.resolve(); }
    const body = IntentResponseSchema.parse(await (await pending).json());
    expect(body.kind).toBe("error"); expect(body.message).toContain("取消"); expect(JSON.stringify(body)).not.toContain("TEST_PRIVATE_ABORT_REASON");
    expectPrivate(body); expect(f.fetchImpl).not.toHaveBeenCalled();
  });
});
