import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { ActionEnvelopeSchema, type Action } from "@vivic/contracts";
import { createWireJsonSchemas } from "@vivic/contracts/json-schema";

const directory = new URL("../../../Vivic_Kimi_Handoff_v0.6/", import.meta.url);
const generated = createWireJsonSchemas();
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(generated["card-record.schema.json"]);
const validate = ajv.compile(generated["action-envelope.schema.json"]);
const stamp = "2026-10-16T08:00:00.000Z";
const timer = (sourceData: Record<string, unknown>) => ({
  id: "TEST-timer", type: "CountdownCard", variant: "minimal", displayProps: {}, sourceData: { targetAt: stamp, ...sourceData }, sources: [],
  layout: { x: 0, y: 0, width: 288, height: 160, pinned: false }, metadata: { createdAt: stamp, updatedAt: stamp },
});
const envelope = (actions: unknown[]) => ({ schemaVersion: "0.6", requestId: "TEST-wire", canvasId: "TEST-canvas", actions });
const assertBoth = (payload: unknown, expected: boolean) => {
  expect(ActionEnvelopeSchema.safeParse(payload).success).toBe(expected);
  expect(validate(payload), JSON.stringify(validate.errors)).toBe(expected);
};

describe("published JSON contracts stay aligned with the runtime", () => {
  it.each(Object.keys(generated) as Array<keyof typeof generated>)("keeps %s generated from the shared Zod source", name => {
    expect(readFileSync(new URL(`contracts/${name}`, directory), "utf8")).toBe(`${JSON.stringify(generated[name], null, 2)}\n`);
  });
  it.each(["01_focus_and_countdown.json", "02_search_results.json"])("retains the existing %s example", name => {
    assertBoth(JSON.parse(readFileSync(new URL(`examples/${name}`, directory), "utf8")), true);
  });
  it.each([
    { type: "cards.delete", targetIds: ["TEST-one", "TEST-two"] },
    { type: "card.subcard.set", targetId: "TEST-parent", subcard: { id: "TEST-child", text: "补充", itemId: "TEST-row", anchor: "TEST-anchor" } },
    { type: "card.subcard.delete", targetId: "TEST-parent", subcardId: "TEST-child" },
  ] satisfies Action[])("supports the current $type action", action => assertBoth(envelope([action]), true));
  it.each([
    { schedule: { kind: "interval", everySeconds: 60 }, timeZone: "Asia/Shanghai", lastDeliveredTargetAt: stamp, lastFiredAt: stamp },
    { schedule: { kind: "calendar", time: "09:00", timeZone: "Asia/Shanghai", weekdays: [1, 3, 5] } },
    { condition: { kind: "todo.completed", cardId: "TEST-todo", itemId: "TEST-item", delaySeconds: 30 }, conditionMetAt: stamp },
    { condition: { kind: "countdown.completed", cardId: "TEST-other", delaySeconds: 0 } },
    { schedule: null, condition: null, notifiedAt: null },
  ])("accepts real reminder schedule and delivery fields %#", fields => {
    assertBoth(envelope([{ type: "card.create", card: timer(fields) }]), true);
  });
  it.each([
    { schedule: { kind: "interval", everySeconds: 4 } },
    { schedule: { kind: "calendar", time: "25:00", timeZone: "Asia/Shanghai" } },
    { schedule: { kind: "calendar", time: "09:00", timeZone: "Asia/Shanghai", weekdays: [1, 1] } },
    { condition: { kind: "countdown.completed", cardId: "TEST-other", itemId: "TEST-item", delaySeconds: 0 } },
    { condition: { kind: "todo.completed", cardId: "TEST-todo", delaySeconds: -1 } },
    { schedule: { kind: "interval", everySeconds: 60 }, condition: { kind: "todo.completed", cardId: "TEST-todo", delaySeconds: 0 } },
    { unknownSchedule: true },
  ])("rejects invalid reminder combinations and closed fields %#", fields => {
    assertBoth(envelope([{ type: "card.create", card: timer(fields) }]), false);
  });
  it("keeps destructive scope explicit, unique and bounded", () => {
    for (const targetIds of [[], ["TEST-one", "TEST-one"], Array.from({ length: 1001 }, (_, i) => `TEST-${i}`)])
      assertBoth(envelope([{ type: "cards.delete", targetIds }]), false);
    assertBoth(envelope([{ type: "cards.delete", targetIds: ["TEST-one"], surprise: true }]), false);
  });
  it("rejects countdown copy injection and notes without content", () => {
    assertBoth(envelope([{ type: "card.create", card: { ...timer({}), displayProps: { description: "注入" } } }]), false);
    const note = { ...timer({}), type: "NoteCard", sourceData: {}, displayProps: {} };
    assertBoth(envelope([{ type: "card.create", card: note }]), false);
    assertBoth(envelope([{ type: "card.create", card: { ...note, displayProps: { text: "原文" } } }]), true);
  });
});
