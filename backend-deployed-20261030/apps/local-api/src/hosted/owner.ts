import { z } from "zod";
import { CardRecordSchema, ViewportSchema } from "@vivic/contracts";
import { type HostedSpaceStore, type SpaceIdentity, SpaceError } from "../space/index.js";
import { hostedBody, hostedJson } from "./http.js";
import { assertCardPackageOrigin, deleteHostedDefinition, saveHostedDefinition } from "./cardPackages.js";

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const OwnerCanvasSchema = z.strictObject({
  schemaVersion: z.literal(1).optional(), id, title: z.string().trim().min(1).max(120),
  version: z.int().min(0), updatedAt: z.iso.datetime(),
  cardsById: z.record(id, CardRecordSchema), cardOrder: z.array(id).max(1000),
  viewport: ViewportSchema, focusHistory: z.array(id).max(20),
  processedRequestIds: z.array(id).max(500).optional(), recovery: z.unknown().optional(),
}).refine(record => new Set(record.cardOrder).size === record.cardOrder.length
  && Object.keys(record.cardsById).length === record.cardOrder.length
  && record.cardOrder.every(key => record.cardsById[key]?.id === key), "Invalid card order");
export type OwnerCanvas = z.infer<typeof OwnerCanvasSchema>;

export function ownerCanvas(store: HostedSpaceStore, accountId: string, spaceId: string) {
  const snapshot = store.getSnapshot(accountId, spaceId).space;
  const document = store.getSpaceDocument(accountId, spaceId);
  const saved = OwnerCanvasSchema.safeParse(document.ownerRecord);
  const previous = saved.success ? saved.data : undefined;
  const cards = snapshot.cards.map(card => {
    const layout = previous?.cardsById[card.id]?.layout;
    return layout ? { ...card, layout: { ...card.layout, surface: layout.surface, userPos: layout.userPos } } : card;
  });
  const byId = Object.fromEntries(cards.map(card => [card.id, card]));
  const order = [...new Set([...(previous?.cardOrder ?? []), ...cards.map(card => card.id)])].filter(key => byId[key]);
  return { serverVersion: snapshot.version, record: {
    ...previous, schemaVersion: 1 as const, id: snapshot.id, title: snapshot.title,
    version: (previous?.version ?? 0) + Math.max(0, snapshot.version - Number(document.ownerServerVersion ?? 0)),
    updatedAt: snapshot.updatedAt, cardsById: byId, cardOrder: order,
    viewport: previous?.viewport ?? { x: 0, y: 0, zoom: 1 }, focusHistory: previous?.focusHistory ?? [],
    processedRequestIds: previous?.processedRequestIds ?? [],
  } };
}

/** Cookie authentication and origin validation run before this adapter. */
export async function ownerRoute(store: HostedSpaceStore, request: Request, identity: SpaceIdentity): Promise<Response | null> {
  const route = new URL(request.url).pathname, base = "/api/space/owner";
  if (!route.startsWith(base + "/")) return null;
  const { accountId, device } = identity;
  if (route === base + "/definitions" && (request.method === "PUT" || request.method === "DELETE")) {
    assertCardPackageOrigin(request); store.assertDeviceActive(accountId, device.id);
    const { revalidateDefinition, definitionKey, definitionRef } = await import("@vivic/card-runtime");
    if (request.method === "PUT") {
      const input = z.strictObject({ record: z.strictObject({ key: z.string().max(512), definition: z.unknown(), enabled: z.boolean() }) }).parse(await hostedBody(request, 2 * 1024 * 1024));
      const definition = await revalidateDefinition(input.record.definition), key = definitionKey(definitionRef(definition));
      if (key !== input.record.key) throw new SpaceError(400, "invalid-definition", "卡片包未通过校验。");
      request.signal.throwIfAborted();
      saveHostedDefinition(store, identity, { ...input.record, definition });
    } else {
      const input = z.strictObject({ key: z.string().max(512) }).parse(await hostedBody(request));
      request.signal.throwIfAborted(); deleteHostedDefinition(store, identity, input.key);
    }
    return hostedJson({ ok: true });
  }
  if (route === base + "/canvases" && request.method === "GET")
    return hostedJson({ canvases: store.listSpaces(accountId).map(space => ownerCanvas(store, accountId, space.id)) });
  const canvas = new RegExp(`^${base}/canvases/([A-Za-z0-9_-]{1,128})$`).exec(route);
  if (canvas && request.method === "GET") return hostedJson(ownerCanvas(store, accountId, canvas[1]!));
  if (canvas && request.method === "PUT") {
    const input = z.strictObject({ record: OwnerCanvasSchema, expectedVersion: z.int().min(0).nullable(), requestId: id }).parse(await hostedBody(request, 8 * 1024 * 1024));
    if (input.record.id !== canvas[1]) throw new SpaceError(400, "canvas-id-mismatch", "画布编号不一致。");
    request.signal.throwIfAborted();
    store.saveOwnerCanvas(accountId, input, device.id);
    return hostedJson(ownerCanvas(store, accountId, canvas[1]!));
  }
  if (canvas && request.method === "DELETE") {
    const input = z.strictObject({ expectedVersion: z.int().min(0) }).parse(await hostedBody(request));
    store.deleteOwnerCanvas(accountId, canvas[1]!, input.expectedVersion, device.id);
    return hostedJson({ ok: true });
  }
  const meta = new RegExp(`^${base}/meta/(lastCanvasId|reminderInbox|displayPreferences(?:_[A-Za-z0-9_-]{1,128})?)$`).exec(route);
  if (meta && request.method === "GET") return hostedJson({ value: store.getAccountValue(accountId, `ownerUI:${meta[1]}`) });
  if (meta && request.method === "PUT") {
    const input = z.strictObject({ value: z.string().max(65536) }).parse(await hostedBody(request, 128 * 1024));
    store.assertDeviceActive(accountId, device.id);
    store.setAccountValue(accountId, `ownerUI:${meta[1]}`, input.value);
    return hostedJson({ ok: true });
  }
  throw new SpaceError(404, "not-found", "没有此画布接口。");
}
