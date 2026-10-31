import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewsCardSchema, type ActionEnvelope, type NewsCard } from "@vivic/contracts";
import { createHostedService } from "../src/hosted/service.js";
import type { HostedAsset } from "../src/hosted/assets.js";
import type { OwnerCanvas } from "../src/hosted/owner.js";
import type { IntentRouter } from "../src/decision/router.js";
import { STEPFUN_PLAN_BASE_URL } from "../src/config.js";
import type { Attachment } from "../src/images.js";
import { IntentResponseSchema, type CanvasContext } from "../src/schemas.js";
import { pngChunk, testPng } from "./images.fixture.js";

// Exercise the real hosted proxy, app, decoder, slot planner, owner and asset HTTP routes.
// Only the decision router and external model transport are replaced; no browser/OAuth files.
vi.mock("../src/search/transport.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/search/transport.js")>(),
  requestPublicHttps: vi.fn(() => { throw new Error("TEST forbids external image/search transport"); }),
}));
import { requestPublicHttps } from "../src/search/transport.js";

const ORIGIN = "https://unit.test";
const VISION_MODEL = "step-3.7-flash";
const TEST_MODEL_KEY = "TEST-hosted-image-model-key";
const analysisSlots = { headline: "画面由蓝色和橙色组成", summary: "图片呈现并排的两块色彩。", keyPoints: ["左侧为蓝色", "右侧为橙色"] };
const MODEL_OUTPUT = { slots: analysisSlots, say: "已整理图片内容。", text: "图片分析已保存为卡片。" };
const modelReply = (payload: unknown) => Response.json({ choices: [{ message: { content: JSON.stringify(payload) } }] });
type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
interface ModelRequest { model: string; max_tokens?: number; messages: Array<{ role: string; content: string | Part[] }> }
interface OwnerResponse { serverVersion: number; record: OwnerCanvas }
type RequestOptions = { method?: string; body?: unknown; headers?: Record<string, string> };
type Service = ReturnType<typeof createHostedService>;
const services: Service[] = [], folders: string[] = [];
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("TEST forbids ambient network"); }));
  vi.mocked(requestPublicHttps).mockClear();
  vi.stubEnv("VIVIC_DECISION_V2_URL", "");
});
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
  for (const folder of folders.splice(0)) {
    const absolute = realpathSync(folder);
    expect(path.dirname(absolute)).toBe(realpathSync(tmpdir()));
    expect(path.basename(absolute)).toMatch(/^vivic-hosted-intent-image-/);
    rmSync(absolute, { recursive: true, force: true });
  }
  const ambientCalls = vi.mocked(fetch).mock.calls.length;
  const externalCalls = vi.mocked(requestPublicHttps).mock.calls.length;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  expect(ambientCalls, "No real model/image request may use ambient fetch").toBe(0);
  expect(externalCalls, "No gallery URL, history image or search may be fetched").toBe(0);
});

const imageUrls = (body: ModelRequest) => body.messages.flatMap(message => typeof message.content === "string" ? []
  : message.content.flatMap(part => part.type === "image_url" ? [part.image_url.url] : []));
const attachment = (): Attachment => ({ type: "image", mime: "image/png", data: testPng(2, 1, true).toString("base64") });
const canvasContext = (canvasId: string, cards: CanvasContext["cards"] = []): CanvasContext => ({
  canvasId, stage: "WORKSPACE", viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], cards,
});
const privateResult = (value: unknown) => {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(attachment().data);
  expect(serialized).not.toContain("data:image/");
  expect(serialized).not.toContain("TEST_PRIVATE_METADATA");
  expect(serialized).not.toContain(TEST_MODEL_KEY);
};

async function fixture(options: { twoAccounts?: boolean; connect?: boolean } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "vivic-hosted-intent-image-")); folders.push(dir);
  const plannerCalls: ModelRequest[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://api.stepfun.com/v1/models") return Response.json({ data: [{ id: VISION_MODEL }] });
    if (url === `${STEPFUN_PLAN_BASE_URL}/chat/completions` && init?.body) {
      const body = JSON.parse(String(init.body)) as ModelRequest;
      if (body.max_tokens === 256) return modelReply({ ok: true });
      plannerCalls.push(body); return modelReply(MODEL_OUTPUT);
    }
    throw new Error("TEST forbids unlisted upstream endpoints");
  });
  const router: IntentRouter = { mode: "shadow",
    routeUtterance: vi.fn(async () => ({ route: "answer" as const, probability: .99, probabilities: { answer: .99, chat: .01 }, none: false, latencyMs: 1 })),
    chooseTarget: vi.fn(async () => null),
  };
  const open = (inviteCode: string) => {
    const next = createHostedService({ origin: ORIGIN, dataDir: dir, inviteCode, fetchImpl, router, autoStartReminders: false });
    services.push(next); return next;
  };
  let service = open("TEST-image-first-invite");
  const request = (cookie: string | undefined, route: string, opts: RequestOptions = {}) => service.fetch(new Request(ORIGIN + route, {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}), ...(opts.body === undefined ? {} : { "content-type": "application/json" }), ...opts.headers },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  }));
  const register = async (invite: string, username: string) => {
    const response = await request(undefined, "/api/space/register", { body: { invite, username, password: "TEST-image-registration-password", deviceName: "TEST isolated browser" } });
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("TEST registration did not issue a session");
    const listed = await request(cookie, "/api/space/spaces"); expect(listed.status).toBe(200);
    const body = await listed.json() as { spaces: Array<{ id: string }> };
    return { cookie, spaceId: body.spaces[0]!.id };
  };
  const first = await register("TEST-image-first-invite", "test_image_first");
  let second: typeof first | undefined;
  if (options.twoAccounts) {
    // Add a fresh invitation by restarting the isolated service; both registrations use HTTP.
    await service.dispose(); service = open("TEST-image-second-invite");
    second = await register("TEST-image-second-invite", "test_image_second");
  }
  if (options.connect !== false) {
    const connected = await request(first.cookie, "/api/credentials/stepfun/validate", { body: { apiKey: TEST_MODEL_KEY } });
    expect(connected.status).toBe(200);
    expect(await connected.json()).toMatchObject({ ok: true, connected: true, defaultModel: VISION_MODEL, capabilities: expect.arrayContaining(["vision"]) });
  }
  const assets = async (cookie = first.cookie, spaceId = first.spaceId) => {
    const response = await request(cookie, `/api/space/spaces/${spaceId}/assets`); expect(response.status).toBe(200);
    return (await response.json() as { assets: HostedAsset[] }).assets;
  };
  const owner = async (cookie = first.cookie, spaceId = first.spaceId): Promise<OwnerResponse> => {
    const response = await request(cookie, `/api/space/owner/canvases/${spaceId}`); expect(response.status).toBe(200);
    return response.json() as Promise<OwnerResponse>;
  };
  const analyze = async (headers: Record<string, string> = {}, extraBody: Record<string, unknown> = {}) => {
    const response = await request(first.cookie, "/api/intent", { body: { text: "请分析这张图片并保存结果", canvasContext: canvasContext(first.spaceId), attachments: [attachment()], ...extraBody }, headers });
    expect(response.status).toBe(200);
    const result = IntentResponseSchema.parse(await response.json()); privateResult(result);
    expect(result.kind, result.message).toBe("envelope");
    const envelope = result.envelope!;
    const created = envelope.actions.find(action => action.type === "card.create");
    if (!created || created.type !== "card.create") throw new Error("TEST expected an image analysis card");
    const card = NewsCardSchema.parse(created.card);
    expect(card.displayProps.image).toMatch(/^media:image_[a-f0-9]{64}$/);
    return { envelope, card, assetId: card.displayProps.image!.slice(6) };
  };
  const commit = async (envelope: ActionEnvelope, card: NewsCard, cookie = first.cookie, spaceId = first.spaceId) => {
    const previous = await owner(cookie, spaceId);
    const record: OwnerCanvas = { ...previous.record, version: previous.record.version + 1,
      updatedAt: card.metadata.updatedAt, cardsById: { ...previous.record.cardsById, [card.id]: card },
      cardOrder: [...previous.record.cardOrder, card.id], processedRequestIds: [...previous.record.processedRequestIds ?? [], envelope.requestId] };
    return request(cookie, `/api/space/owner/canvases/${spaceId}`, { method: "PUT", body: { record, expectedVersion: previous.serverVersion, requestId: envelope.requestId } });
  };
  return { request, first, second, assets, owner, analyze, commit, plannerCalls, router, fetchImpl };
}

describe("hosted image intent HTTP integration with a mocked vision model", () => {
  it("retains the current attachment, builds a NewsCard, commits via owner and reads back the verified original image", async () => {
    const f = await fixture(), before = await f.owner(), { card, envelope, assetId } = await f.analyze();
    expect(card.displayProps).toEqual({ ...analysisSlots, image: `media:${assetId}`, summaryBy: "ai" });
    expect(card.sources).toEqual([]); expect(card.sourceData).toEqual({});
    expect((await f.owner()).record.cardOrder).toEqual(before.record.cardOrder);
    expect(envelope.canvasId).toBe(f.first.spaceId);
    expect(envelope.spokenText).toBe(MODEL_OUTPUT.say);
    expect(envelope.actions.filter(action => action.type === "subtitle.show")).toHaveLength(1);
    expect(f.router.routeUtterance).toHaveBeenCalled();
    expect(f.plannerCalls).toHaveLength(1);
    expect(f.plannerCalls[0].model).toBe(VISION_MODEL);
    expect(imageUrls(f.plannerCalls[0])).toEqual([`data:image/png;base64,${attachment().data}`]);
    const imageMessage = f.plannerCalls[0].messages.find(message => typeof message.content !== "string");
    expect(imageMessage?.role).toBe("user");
    expect(JSON.stringify(f.plannerCalls[0].messages[0])).toContain("image_analysis");
    expect(JSON.stringify(f.plannerCalls[0].messages[0])).not.toContain(attachment().data);
    const saved = await f.commit(envelope, card); expect(saved.status).toBe(200);
    const savedOwner = await saved.json() as OwnerResponse; privateResult(savedOwner);
    expect(savedOwner.serverVersion).toBe(before.serverVersion + 1);
    expect(savedOwner.record.cardsById[card.id]).toEqual(card);
    expect((await f.owner()).record.cardsById[card.id]).toEqual(card);
    const retained = await f.assets(); expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({ id: assetId, kind: "image", mediaType: "image/webp", width: 2, height: 1 });
    const contentPath = `/api/space/spaces/${f.first.spaceId}/assets/${assetId}/content`;
    const content = await f.request(f.first.cookie, contentPath); expect(content.status).toBe(200);
    expect(content.headers.get("content-type")).toBe("image/webp");
    expect(content.headers.get("cache-control")).toBe("no-store");
    expect(content.headers.get("x-content-type-options")).toBe("nosniff");
    const bytes = new Uint8Array(await content.arrayBuffer()), sha256 = createHash("sha256").update(bytes).digest("hex");
    expect(assetId).toBe(`image_${sha256}`); expect(bytes.byteLength).toBe(retained[0].sizeBytes);
    expect(await sharp(bytes).metadata()).toMatchObject({ format: "webp", width: 2, height: 1 });
    expect(Buffer.from(bytes).includes(Buffer.from("TEST_PRIVATE_METADATA"))).toBe(false);
    const head = await f.request(f.first.cookie, contentPath, { method: "HEAD" });
    expect(head.status).toBe(200); expect((await head.arrayBuffer()).byteLength).toBe(0);
    expect(head.headers.get("x-content-sha256")).toBe(sha256);
  });

  it("rejects image reads, intent retention and owner card references across accounts and spaces", async () => {
    const f = await fixture({ twoAccounts: true }), { card, envelope, assetId } = await f.analyze();
    expect((await f.commit(envelope, card)).status).toBe(200);
    const created = await f.request(f.first.cookie, "/api/space/spaces", { body: { title: "TEST separate space", requestId: randomUUID() } });
    expect(created.status).toBe(200);
    const otherSpace = (await created.json() as { space: { id: string } }).space.id;
    for (const [cookie, spaceId] of [[f.second!.cookie, f.first.spaceId], [f.second!.cookie, f.second!.spaceId], [f.first.cookie, otherSpace]]) {
      for (const suffix of ["", "/content"]) expect((await f.request(cookie, `/api/space/spaces/${spaceId}/assets/${assetId}${suffix}`)).status).toBe(404);
      expect((await f.request(cookie, `/api/space/spaces/${spaceId}/assets/${assetId}/content`, { method: "HEAD" })).status).toBe(404);
    }
    expect((await f.request(undefined, `/api/space/spaces/${f.first.spaceId}/assets/${assetId}/content`)).status).toBe(401);
    for (const [cookie, spaceId] of [[f.second!.cookie, f.second!.spaceId], [f.first.cookie, otherSpace]]) {
      const copied = await f.commit(envelope, card, cookie, spaceId);
      expect(copied.status).toBe(404); expect((await f.owner(cookie, spaceId)).record.cardOrder).toEqual([]);
    }
    const planned = f.plannerCalls.length;
    const foreignIntent = await f.request(f.second!.cookie, "/api/intent", { body: { text: "分析这张图", canvasContext: canvasContext(f.first.spaceId), attachments: [attachment()] } });
    expect(foreignIntent.status).toBe(404); expect(f.plannerCalls).toHaveLength(planned);
    expect(await f.assets(f.second!.cookie, f.second!.spaceId)).toEqual([]);
  });

  it("still retains the image and supplies trusted media when the client catalog is malformed or exceeds eight definitions", async () => {
    const f = await fixture(), marker = "TEST_CLIENT_IMAGE_CATALOG_MUST_BE_IGNORED";
    const catalogs: unknown[] = [{ invalid: marker }, Array.from({ length: 9 }, () => null)];
    const refs: string[] = [];
    for (const extensionDefinitions of catalogs) {
      const { card, assetId } = await f.analyze({}, { extensionDefinitions });
      expect(card.displayProps.image).toBe(`media:${assetId}`); refs.push(card.displayProps.image!);
      const content = await f.request(f.first.cookie, `/api/space/spaces/${f.first.spaceId}/assets/${assetId}/content`);
      expect(content.status).toBe(200);
      const bytes = new Uint8Array(await content.arrayBuffer());
      expect(assetId).toBe(`image_${createHash("sha256").update(bytes).digest("hex")}`);
    }
    expect(new Set(refs).size).toBe(1); expect(await f.assets()).toHaveLength(1);
    expect(f.plannerCalls).toHaveLength(catalogs.length);
    for (const request of f.plannerCalls) {
      expect(imageUrls(request)).toEqual([`data:image/png;base64,${attachment().data}`]);
      expect(JSON.stringify(request.messages)).not.toContain(marker);
    }
  });

  it("ignores a browser supplied internal reference and never reuses historical images for a later text request", async () => {
    const f = await fixture(), spoof = `media:image_${"b".repeat(64)}`;
    const { card, envelope } = await f.analyze({ "x-vivic-intent-image-ref": spoof });
    expect(card.displayProps.image).not.toBe(spoof);
    expect((await f.commit(envelope, card)).status).toBe(200);
    const history: CanvasContext["cards"] = [{ id: card.id, type: card.type, displayProps: card.displayProps, sourceDataSummary: {}, layout: card.layout }];
    const followup = await f.request(f.first.cookie, "/api/intent", { headers: { "x-vivic-intent-image-ref": card.displayProps.image! },
      body: { text: "请解释一下色彩搭配", canvasContext: canvasContext(f.first.spaceId, history) } });
    expect(followup.status).toBe(200);
    const result = IntentResponseSchema.parse(await followup.json()); expect(result.kind).toBe("envelope"); privateResult(result);
    expect(f.plannerCalls).toHaveLength(2); expect(imageUrls(f.plannerCalls[1])).toEqual([]);
    const created = result.envelope!.actions.find(action => action.type === "card.create");
    if (!created || created.type !== "card.create") throw new Error("TEST expected answer card");
    expect(NewsCardSchema.parse(created.card).displayProps.image).toBeUndefined();
    expect(await f.assets()).toHaveLength(1);
  });

  it("rejects unauthenticated and foreign-origin image requests before retention or model use", async () => {
    const f = await fixture(), body = { text: "分析这张图", canvasContext: canvasContext(f.first.spaceId), attachments: [attachment()] };
    expect((await f.request(undefined, "/api/intent", { body })).status).toBe(401);
    const foreign = await f.request(f.first.cookie, "/api/intent", { body, headers: { origin: "https://foreign.test" } });
    expect([401, 403]).toContain(foreign.status);
    expect(f.plannerCalls).toEqual([]); expect(await f.assets()).toEqual([]);
  });

  it("rejects corrupt compressed pixels through hosted HTTP without retaining an image or calling the model", async () => {
    const f = await fixture(), bytes = testPng(), offset = 33, length = bytes.readUInt32BE(offset);
    const corrupt = Buffer.concat([bytes.subarray(0, offset), pngChunk("IDAT", Buffer.alloc(length, 255)), bytes.subarray(offset + length + 12)]);
    const response = await f.request(f.first.cookie, "/api/intent", { body: { text: "分析这张图", canvasContext: canvasContext(f.first.spaceId),
      attachments: [{ type: "image", mime: "image/png", data: corrupt.toString("base64") }] } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: "error", message: expect.stringMatching(/解码|损坏/) });
    expect(f.plannerCalls).toEqual([]); expect(await f.assets()).toEqual([]);
    expect((await f.owner()).record.cardOrder).toEqual([]);
  });
});
