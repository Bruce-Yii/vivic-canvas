import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { definitionRef, readPackageZip, type CardDefinition } from "@vivic/card-runtime";
import { ExtensionCardSchema, type ActionEnvelope, type ExtensionCard } from "@vivic/contracts";
import { createHostedService } from "../src/hosted/service.js";
import type { OwnerCanvas } from "../src/hosted/owner.js";
import type { IntentRouter, RouteResult } from "../src/decision/router.js";
import { STEPFUN_PLAN_BASE_URL } from "../src/config.js";
import { IntentResponseSchema, type CanvasContext, type IntentResponse } from "../src/schemas.js";

// Real HTTP registration, package upload, intent planning, owner persistence and export.
// Only the router and outbound model are synthetic; all package/grounding checks stay real.
vi.mock("../src/search/transport.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/search/transport.js")>(),
  requestPublicHttps: vi.fn(() => { throw new Error("TEST forbids external search/image transport"); }),
}));
import { requestPublicHttps } from "../src/search/transport.js";

const ORIGIN = "https://unit.test", MODEL = "step-3.7-flash";
const TEST_KEY = "TEST-hosted-extension-model-key";
const FITNESS_ID = "example.fitness-log", CONTRACT = `ext.${FITNESS_ID}` as const;
const TEXT = "今天练了40分钟背", CLIENT_MARKER = "TEST_CLIENT_CATALOG_MUST_NOT_REACH_PLANNER";
const folders: string[] = [], services: ReturnType<typeof createHostedService>[] = [];
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("TEST forbids ambient network"); }));
  vi.mocked(requestPublicHttps).mockClear(); vi.stubEnv("VIVIC_DECISION_V2_URL", "");
});
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
  for (const folder of folders.splice(0)) {
    const absolute = realpathSync(folder);
    expect(path.dirname(absolute)).toBe(realpathSync(tmpdir())); expect(path.basename(absolute)).toMatch(/^vivic-extension-intent-/);
    rmSync(absolute, { recursive: true, force: true });
  }
  const ambientCalls = vi.mocked(fetch).mock.calls.length, externalCalls = vi.mocked(requestPublicHttps).mock.calls.length;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  expect(ambientCalls, "No real model request may use ambient fetch").toBe(0);
  expect(externalCalls, "No external service may supply fitness facts").toBe(0);
});

function shanghaiDate() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date()).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
const facts = () => ({ trainingDate: shanghaiDate(), bodyPart: "背", minutes: 40 });
const fullSlots = () => ({ config: { title: "训练记录" }, data: facts(), state: { note: "" } });
const modelReply = (payload: unknown) => Response.json({ choices: [{ message: { content: JSON.stringify(payload) } }] });
interface ModelRequest { model: string; max_tokens?: number; messages: Array<{ role: string; content: string }> }
interface ModelCall { request: ModelRequest; output: unknown }
interface Classification { ids: string[]; hashes: string[]; text: string; canvasId: string }
interface OwnerResponse { serverVersion: number; record: OwnerCanvas }
type RequestOptions = { method?: string; body?: unknown; form?: FormData; headers?: Record<string, string> };
const context = (canvasId: string): CanvasContext => ({ canvasId, stage: "STANDBY", viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], cards: [], timeZone: "Asia/Shanghai" });
const fixtureFiles = ["manifest.json", "config.schema.json", "data.schema.json", "state.schema.json", "ui.json", "examples/default.json"];
async function fitnessPackage(version = "1.0.0") {
  const bytes = zipSync(Object.fromEntries(fixtureFiles.map(file => {
    const text = readFileSync(new URL(`../../../examples/vivicard/fitness-log/${file}`, import.meta.url), "utf8");
    return [file, strToU8(file === "manifest.json" ? JSON.stringify({ ...JSON.parse(text), version }) : text)];
  })), { level: 6 });
  const definition = await readPackageZip(bytes);
  expect(definition.manifest.formatVersion).toBe("0.2"); expect(definition.manifest.id).toBe(FITNESS_ID);
  return { bytes, definition };
}
function extensionCard(result: IntentResponse): ExtensionCard {
  expect(result.kind, result.message).toBe("envelope");
  const created = result.envelope!.actions.filter(action => action.type === "card.create"); expect(created).toHaveLength(1);
  if (created[0].type !== "card.create") throw new Error("TEST expected a creation");
  return ExtensionCardSchema.parse(created[0].card);
}
function noExtension(result: IntentResponse) {
  expect(result.envelope?.actions.some(action => action.type === "card.create" && action.card.type === "ExtensionCard") ?? false).toBe(false);
  expect(["clarify", "error", "unknown"]).toContain(result.kind);
}

async function fixture(twoAccounts = false) {
  const dir = mkdtempSync(path.join(tmpdir(), "vivic-extension-intent-")); folders.push(dir);
  const calls: ModelCall[] = [], classifications: Classification[] = [], catalogs: string[][] = [];
  let output: () => unknown = () => ({ contract: CONTRACT, slots: fullSlots(), say: "已记录今天的训练。", text: "已记录训练日期、部位和时长。" });
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://api.stepfun.com/v1/models") return Response.json({ data: [{ id: MODEL }] });
    if (url === `${STEPFUN_PLAN_BASE_URL}/chat/completions` && init?.body) {
      const request = JSON.parse(String(init.body)) as ModelRequest;
      if (request.max_tokens === 256) return modelReply({ ok: true });
      const payload = output(); calls.push({ request, output: payload }); return modelReply(payload);
    }
    throw new Error("TEST forbids unlisted model endpoints");
  });
  const rootRoute = vi.fn<IntentRouter["routeUtterance"]>(async () => { throw new Error("TEST requires a request-scoped router"); });
  const router: IntentRouter = { mode: "shadow", routeUtterance: rootRoute, chooseTarget: vi.fn(async () => null),
    forDefinitions: vi.fn((definitions: readonly CardDefinition[]): IntentRouter => {
      const captured = definitions.map(definition => ({ id: definition.manifest.id, hash: definition.hash })); catalogs.push(captured.map(item => item.id));
      return { mode: "shadow", chooseTarget: vi.fn(async () => null),
        routeUtterance: vi.fn(async (text, canvas): Promise<RouteResult> => {
          classifications.push({ ids: captured.map(item => item.id), hashes: captured.map(item => item.hash), text, canvasId: canvas.canvasId });
          const route = captured.some(item => item.id === FITNESS_ID) ? CONTRACT : "generate";
          return { route, probability: .99, probabilities: { [route]: .99, chat: .01 }, none: false, latencyMs: 1 };
        }),
      };
    }),
  };
  const open = (inviteCode: string) => {
    const service = createHostedService({ origin: ORIGIN, dataDir: dir, inviteCode, router, fetchImpl, autoStartReminders: false });
    services.push(service); return service;
  };
  let service = open("TEST-extension-first-invite");
  const request = (cookie: string | undefined, route: string, options: RequestOptions = {}) => service.fetch(new Request(ORIGIN + route, {
    method: options.method ?? (options.body === undefined && !options.form ? "GET" : "POST"),
    headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}), ...(options.body === undefined ? {} : { "content-type": "application/json" }), ...options.headers },
    ...(options.form ? { body: options.form } : options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  }));
  const register = async (invite: string, username: string) => {
    const registered = await request(undefined, "/api/space/register", { body: { invite, username, password: "TEST-extension-registration-password", deviceName: "TEST isolated browser" } });
    expect(registered.status).toBe(200);
    const cookie = registered.headers.get("set-cookie")?.split(";")[0]; if (!cookie) throw new Error("TEST missing registration session");
    const response = await request(cookie, "/api/space/spaces"); expect(response.status).toBe(200);
    const { spaces } = await response.json() as { spaces: Array<{ id: string }> };
    return { cookie, spaceId: spaces[0]!.id };
  };
  const first = await register("TEST-extension-first-invite", "test_extension_first");
  let second: typeof first | undefined;
  if (twoAccounts) {
    await service.dispose(); service = open("TEST-extension-second-invite");
    second = await register("TEST-extension-second-invite", "test_extension_second");
  }
  for (const account of [first, ...(second ? [second] : [])]) {
    const response = await request(account.cookie, "/api/credentials/stepfun/validate", { body: { apiKey: TEST_KEY } });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ ok: true, connected: true, defaultModel: MODEL });
  }
  const pack = await fitnessPackage();
  const upload = async (input = pack) => {
    const form = new FormData(); form.append("file", new File([new Uint8Array(input.bytes)], "fitness-log.vivicard", { type: "application/zip" }));
    const response = await request(first.cookie, "/api/space/cards", { form }); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ record: { enabled: true, definition: { hash: input.definition.hash } } });
  };
  const intent = async (extra: Record<string, unknown> = {}, account = first, text = TEXT) => {
    const response = await request(account.cookie, "/api/intent", { body: { text, canvasContext: context(account.spaceId), ...extra } });
    expect(response.status).toBe(200); return IntentResponseSchema.parse(await response.json());
  };
  const owner = async (account = first): Promise<OwnerResponse> => {
    const response = await request(account.cookie, `/api/space/owner/canvases/${account.spaceId}`); expect(response.status).toBe(200);
    return response.json() as Promise<OwnerResponse>;
  };
  const commit = async (envelope: ActionEnvelope, card: ExtensionCard) => {
    const previous = await owner();
    const record: OwnerCanvas = { ...previous.record, version: previous.record.version + 1, updatedAt: card.metadata.updatedAt,
      cardsById: { ...previous.record.cardsById, [card.id]: card }, cardOrder: [...previous.record.cardOrder, card.id],
      processedRequestIds: [...previous.record.processedRequestIds ?? [], envelope.requestId] };
    const response = await request(first.cookie, `/api/space/owner/canvases/${first.spaceId}`, { method: "PUT", body: { record, expectedVersion: previous.serverVersion, requestId: envelope.requestId } });
    expect(response.status).toBe(200); return response.json() as Promise<OwnerResponse>;
  };
  return { first, second, request, intent, owner, commit, upload, pack, calls, classifications, catalogs, rootRoute,
    setOutput: (next: () => unknown) => { output = next; } };
}

describe("server-owned extension catalogs through hosted HTTP intent", () => {
  it("registers, uploads fitness-log v0.2, creates by unnamed intent, commits via owner, protects deletion and exports the same hash", async () => {
    const f = await fixture(); await f.upload();
    expect(TEXT).not.toContain(f.pack.definition.manifest.name); expect(TEXT).not.toContain(FITNESS_ID);
    const before = await f.owner(), result = await f.intent(), card = extensionCard(result);
    expect(card.displayProps).toEqual({ def: definitionRef(f.pack.definition), ...fullSlots() });
    expect(card.sourceData).toEqual({}); expect(card.sources).toEqual([]);
    expect(card.metadata.aliases).toContain(f.pack.definition.manifest.name);
    expect((await f.owner()).record.cardOrder).toEqual(before.record.cardOrder);
    expect(f.calls).toHaveLength(1); expect(f.rootRoute).not.toHaveBeenCalled();
    expect(f.classifications).toEqual([{ ids: [FITNESS_ID], hashes: [f.pack.definition.hash], text: TEXT, canvasId: f.first.spaceId }]);
    const system = f.calls[0].request.messages[0].content;
    expect(system).toContain(CONTRACT); expect(system).toContain("trainingDate"); expect(system).toContain("config");
    expect(system).not.toContain('"bodyPart":"腿"'); expect(system).not.toContain('"minutes":25');
    const saved = await f.commit(result.envelope!, card);
    expect(saved.serverVersion).toBe(before.serverVersion + 1); expect((await f.owner()).record.cardsById[card.id]).toEqual(card);
    const removal = await f.request(f.first.cookie, `/api/space/cards/${FITNESS_ID}?hash=${f.pack.definition.hash}`, { method: "DELETE" });
    expect(removal.status).toBe(409); expect(await removal.json()).toMatchObject({ code: "definition-in-use" });
    const exported = await f.request(f.first.cookie, `/api/space/cards/${FITNESS_ID}/package?hash=${f.pack.definition.hash}`);
    expect(exported.status).toBe(200); expect(exported.headers.get("content-type")).toBe("application/zip");
    const bytes = new Uint8Array(await exported.arrayBuffer()); expect([...bytes.slice(0, 4)]).toEqual([80, 75, 3, 4]);
    expect((await readPackageZip(bytes)).hash).toBe(f.pack.definition.hash);
    expect(JSON.stringify(saved)).not.toContain(TEST_KEY);
  });

  it("accepts flat fact slots with only schema config/state defaults and never copies DEMO facts or notes", async () => {
    const f = await fixture(); await f.upload();
    f.setOutput(() => ({ contract: CONTRACT, slots: facts(), say: "已记录训练。", text: "已保存今天的训练。" }));
    const card = extensionCard(await f.intent());
    expect(card.displayProps).toEqual({ def: definitionRef(f.pack.definition), config: { title: "训练记录" }, data: facts(), state: { note: "" } });
    expect(card.displayProps.data).not.toEqual(f.pack.definition.examples[0].data);
    expect(card.displayProps.state.note).not.toBe(f.pack.definition.examples[0].state.note);
    expect(card.displayProps.data.trainingDate).toBe(shanghaiDate());
  });

  it.each(["missing-date", "missing-minutes", "fabricated-date", "fabricated-duration"])("rejects %s rather than filling fact data from the example", async scenario => {
    const f = await fixture(); await f.upload();
    f.setOutput(() => {
      const data: Record<string, unknown> = facts();
      if (scenario === "missing-date") delete data.trainingDate;
      if (scenario === "missing-minutes") delete data.minutes;
      if (scenario === "fabricated-date") data.trainingDate = "1901-02-03";
      if (scenario === "fabricated-duration") data.minutes = 25;
      return { contract: CONTRACT, slots: data };
    });
    noExtension(await f.intent()); expect((await f.owner()).record.cardOrder).toEqual([]);
    expect(f.calls).toHaveLength(2);
  });

  it("removes a disabled package from the next scoped classifier and rejects stale extension output", async () => {
    const f = await fixture(); await f.upload(); extensionCard(await f.intent());
    const disabled = await f.request(f.first.cookie, `/api/space/cards/${FITNESS_ID}`, { method: "PATCH", body: { enabled: false, hash: f.pack.definition.hash } });
    expect(disabled.status).toBe(200);
    const before = f.classifications.length, callsBefore = f.calls.length;
    noExtension(await f.intent({ extensionDefinitions: [f.pack.definition] }));
    expect(f.classifications.slice(before)).toEqual([{ ids: [], hashes: [], text: TEXT, canvasId: f.first.spaceId }]);
    expect(f.catalogs.at(-1)).toEqual([]); expect(f.rootRoute).not.toHaveBeenCalled();
    for (const call of f.calls.slice(callsBefore)) expect(call.request.messages[0].content).not.toContain(FITNESS_ID);
    expect((await f.owner()).record.cardOrder).toEqual([]);
  });

  it("classifies against the highest enabled semantic version while preserving old instances and package hashes", async () => {
    const f = await fixture(); await f.upload();
    const original = await f.intent(), oldCard = extensionCard(original); await f.commit(original.envelope!, oldCard);
    const higher = await fitnessPackage("1.10.0"), lower = await fitnessPackage("1.9.0");
    await f.upload(higher); await f.upload(lower); // Install the lexically greater, semantically lower version last.
    const latest = extensionCard(await f.intent());
    expect(latest.displayProps.def).toEqual(definitionRef(higher.definition));
    expect(f.classifications.at(-1)).toEqual({ ids: [FITNESS_ID], hashes: [higher.definition.hash], text: TEXT, canvasId: f.first.spaceId });
    expect((await f.owner()).record.cardsById[oldCard.id]).toEqual(oldCard);
    const listed = await f.request(f.first.cookie, "/api/space/cards");
    const stored = await listed.json() as { definitions: Array<{ definition: CardDefinition; enabled: boolean }> };
    expect(stored.definitions.map(row => row.definition.hash).sort()).toEqual([f.pack.definition.hash, lower.definition.hash, higher.definition.hash].sort());
    expect(stored.definitions.every(row => row.enabled)).toBe(true);
    const disabled = await f.request(f.first.cookie, `/api/space/cards/${FITNESS_ID}`, {
      method: "PATCH", body: { enabled: false, hash: higher.definition.hash },
    });
    expect(disabled.status).toBe(200);
    expect(extensionCard(await f.intent()).displayProps.def).toEqual(definitionRef(lower.definition));
    expect(f.classifications.at(-1)?.hashes).toEqual([lower.definition.hash]);
    expect((await f.owner()).record.cardsById[oldCard.id]).toEqual(oldCard);
    const oldExport = await f.request(f.first.cookie, `/api/space/cards/${FITNESS_ID}/package?hash=${f.pack.definition.hash}`);
    expect(oldExport.status).toBe(200);
    expect((await readPackageZip(new Uint8Array(await oldExport.arrayBuffer()))).hash).toBe(f.pack.definition.hash);
    expect((await f.request(f.first.cookie, `/api/space/cards/${FITNESS_ID}?hash=${f.pack.definition.hash}`, { method: "DELETE" })).status).toBe(409);
    expect(f.rootRoute).not.toHaveBeenCalled();
  });

  it("ignores malformed and over-eight client catalogs before parsing while retaining the server's enabled definition", async () => {
    const f = await fixture(); await f.upload();
    const injected: unknown[] = [null, CLIENT_MARKER, { invalid: CLIENT_MARKER }, [null], Array.from({ length: 9 }, () => f.pack.definition)];
    for (const extensionDefinitions of injected) {
      const before = f.calls.length;
      const card = extensionCard(await f.intent({ extensionDefinitions }));
      expect(card.displayProps.def).toEqual(definitionRef(f.pack.definition));
      expect(f.catalogs.at(-1)).toEqual([FITNESS_ID]);
      for (const call of f.calls.slice(before)) expect(JSON.stringify(call.request.messages)).not.toContain(CLIENT_MARKER);
    }
    expect(f.classifications).toHaveLength(injected.length); expect(f.rootRoute).not.toHaveBeenCalled();
  });

  it("never lends another account the first account's package through client definitions, even with a valid model connection", async () => {
    const f = await fixture(true); await f.upload(); extensionCard(await f.intent());
    const second = f.second!;
    const catalog = await f.request(second.cookie, "/api/space/cards"); expect(await catalog.json()).toEqual({ definitions: [] });
    const stolen: unknown[] = [[f.pack.definition], Array.from({ length: 9 }, () => f.pack.definition), { files: CLIENT_MARKER }, [null]];
    const before = f.classifications.length;
    for (const extensionDefinitions of stolen) {
      const callsBefore = f.calls.length;
      noExtension(await f.intent({ extensionDefinitions }, second));
      for (const call of f.calls.slice(callsBefore)) {
        expect(JSON.stringify(call.request.messages)).not.toContain(CLIENT_MARKER);
        expect(call.request.messages[0].content).not.toContain(FITNESS_ID);
      }
    }
    expect(f.classifications.slice(before)).toEqual(stolen.map(() => ({ ids: [], hashes: [], text: TEXT, canvasId: second.spaceId })));
    expect((await f.owner(second)).record.cardOrder).toEqual([]);
    const exported = await f.request(second.cookie, `/api/space/cards/${FITNESS_ID}/package?hash=${f.pack.definition.hash}`); expect(exported.status).toBe(404);
    expect(f.rootRoute).not.toHaveBeenCalled();
  });

  it("still enforces the total HTTP body limit before discarding an oversized client catalog", async () => {
    const f = await fixture(); await f.upload();
    const response = await f.request(f.first.cookie, "/api/intent", { body: { text: TEXT, canvasContext: context(f.first.spaceId),
      extensionDefinitions: CLIENT_MARKER.repeat(Math.ceil(6 * 1024 * 1024 / CLIENT_MARKER.length)) } });
    expect(response.status).toBe(413); expect(await response.json()).toMatchObject({ code: "body-limit" });
    expect(f.calls).toEqual([]); expect(f.catalogs).toEqual([]); expect(f.classifications).toEqual([]);
    expect((await f.owner()).record.cardOrder).toEqual([]);
  });
});
