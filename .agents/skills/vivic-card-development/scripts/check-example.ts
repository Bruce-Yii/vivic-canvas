import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ActionEnvelopeSchema, CardRecordSchema, SCENE_CARD_TYPE } from "../../../../packages/contracts/src/index";
import { parseScenePayload } from "../../../../apps/local-api/src/scenes/payload";
import { buildSceneActions } from "../../../../apps/local-api/src/scenes/index";
import type { CanvasContext } from "../../../../apps/local-api/src/schemas";

// Local teaching fixture. This script has no network, credential or storage calls.
const fixture = JSON.parse(readFileSync(new URL("../assets/goal-progress.example.json", import.meta.url), "utf8"));
const raw = fixture.modelOutput.cards[0];
const ctx: CanvasContext = {
  canvasId: "TEST-card-development", stage: "WORKSPACE", cards: [],
  viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], timeZone: fixture.timeZone,
};
const request = { text: fixture.input, ctx, now: Date.parse(fixture.now) };
const parsed = parseScenePayload(raw);
assert.ok(parsed.ok, "The documented payload must pass the actual parser");
assert.equal(SCENE_CARD_TYPE[parsed.value.scene], fixture.expectedType);
assert.ok(parseScenePayload({ ...raw, card_type: fixture.expectedType }).ok);
assert.equal(parseScenePayload({ ...raw, card_type: "TodoCard" }).ok, false);
assert.equal(parseScenePayload({ ...raw, scene_id: "TEST-unregistered" }).ok, false);
assert.equal(parseScenePayload({ ...raw, component: "ModelSuppliedRenderer" }).ok, false);
assert.equal(parseScenePayload({ ...raw, data: { ...raw.data, html: "<b>not a field</b>" } }).ok, false);
assert.equal(parseScenePayload({ ...raw, data: fixture.invalidData }).ok, false);
const { target: _target, ...missingTarget } = raw.data;
assert.equal(parseScenePayload({ ...raw, data: missingTarget }).ok, false);

const built = buildSceneActions(fixture.modelOutput.cards, request);
assert.ok(built.ok, "Grounded sample must build a real card");
assert.equal(built.cards.length, 1);
const card = built.cards[0]!;
assert.equal(card.type, fixture.expectedType);
assert.deepEqual(card.displayProps, fixture.expectedDisplayProps);
assert.deepEqual(card.sources, []);
assert.deepEqual(card.sourceData, { scene: "goal_progress", provenance: "user-text" });
assert.equal(card.metadata.createdAt, fixture.now);
assert.ok(card.id.length > 0);
assert.deepEqual(card.layout, { x: 0, y: 0, width: 280, height: 300, pinned: false });
const envelope = ActionEnvelopeSchema.parse({
  schemaVersion: "0.6", canvasId: ctx.canvasId, requestId: "TEST-card-development",
  spokenText: fixture.modelOutput.spokenText, actions: built.actions,
});
assert.equal(envelope.actions[0]!.type, "card.create");
assert.deepEqual(CardRecordSchema.parse(JSON.parse(JSON.stringify(card))), card);

// Mirrors only the documented first-level merge for contract checking, not a UI/owner test.
const edited = { ...card, displayProps: { ...card.displayProps, ...fixture.validPatch } };
assert.ok(CardRecordSchema.safeParse(edited).success);
assert.equal(CardRecordSchema.safeParse({ ...card, displayProps: { ...card.displayProps, target: 0 } }).success, false);

// A structurally valid but invented fact must fail in the grounding/build layer.
const ungrounded = { ...raw, data: fixture.ungroundedData };
assert.ok(parseScenePayload(ungrounded).ok);
const refusal = buildSceneActions([ungrounded], request);
assert.equal(refusal.ok, false);
if (!refusal.ok) assert.match(refusal.issue, /current/);
const batch = buildSceneActions([raw, ungrounded], request);
assert.equal(batch.ok, false);
assert.equal("actions" in batch, false);
assert.equal("cards" in batch, false);
console.log("PASS: payload / type mapping / grounding / CardRecord / ActionEnvelope / serialization / patch shape / batch rejection");
console.log("Not covered: real MCP, model routing, renderer interaction, owner persistence, or browser recovery.");
