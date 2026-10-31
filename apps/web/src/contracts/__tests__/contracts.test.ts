import { describe, expect, it } from "vitest";
import {
  ActionEnvelopeSchema,
  CardRecordSchema,
  type CardRecord,
} from "@/contracts";

const baseCard = {
  id: "card-1",
  variant: "minimal" as const,
  sources: [],
  layout: { x: 0, y: 0, width: 240, height: 120, pinned: false },
  metadata: {
    createdAt: "2026-10-14T00:00:00.000Z",
    updatedAt: "2026-10-14T00:00:00.000Z",
  },
};

const countdown: CardRecord = {
  ...baseCard,
  type: "CountdownCard",
  displayProps: {},
  sourceData: {
    targetAt: "2026-10-14T00:10:00.000Z",
    startedAt: "2026-10-14T00:00:00.000Z",
  },
};

const todo: CardRecord = {
  ...baseCard,
  type: "TodoCard",
  displayProps: {
    items: [
      { id: "t1", text: "Ship phase 0", done: false },
      { id: "t2", text: "Record evidence", done: true },
    ],
  },
  sourceData: {},
};

const search: CardRecord = {
  ...baseCard,
  type: "SearchResultCard",
  displayProps: {
    title: "React Flow",
    summary: "Node-based editor library for React.",
    sourceLabel: "xyflow.com",
  },
  sourceData: {},
  sources: [
    {
      title: "React Flow",
      url: "https://reactflow.dev/",
      fetchedAt: "2026-10-14T00:00:00.000Z",
      provider: "demo",
      readFullPage: false,
    },
  ],
};

describe("CardRecordSchema", () => {
  it("accepts the three minimal demo cards", () => {
    for (const card of [countdown, todo, search]) {
      expect(CardRecordSchema.safeParse(card).success).toBe(true);
    }
  });

  it("rejects an unknown card type", () => {
    const res = CardRecordSchema.safeParse({
      ...countdown,
      type: "MotivationCard",
    });
    expect(res.success).toBe(false);
  });

  it("rejects description/footer/advice on the minimal CountdownCard", () => {
    for (const field of ["description", "footer", "advice", "motivation"]) {
      const res = CardRecordSchema.safeParse({
        ...countdown,
        displayProps: { [field]: "keep going!" },
      });
      expect(res.success, `displayProps.${field} must be rejected`).toBe(false);
    }
  });

  it("rejects unknown fields on any displayProps", () => {
    expect(
      CardRecordSchema.safeParse({
        ...todo,
        displayProps: { ...todo.displayProps, hint: "you can do it" },
      }).success,
    ).toBe(false);
    expect(
      CardRecordSchema.safeParse({
        ...search,
        displayProps: { ...search.displayProps, comment: "nice one" },
      }).success,
    ).toBe(false);
  });

  it("rejects unknown top-level fields on the record", () => {
    expect(
      CardRecordSchema.safeParse({ ...countdown, chatLog: [] }).success,
    ).toBe(false);
  });

  it("requires at least one source on SearchResultCard", () => {
    expect(
      CardRecordSchema.safeParse({ ...search, sources: [] }).success,
    ).toBe(false);
  });
});

describe("ActionEnvelopeSchema", () => {
  const envelope = {
    schemaVersion: "0.6",
    requestId: "req-1",
    canvasId: "demo",
    actions: [
      { type: "stage.awaken" },
      { type: "card.create", card: countdown },
      { type: "card.focus", targetId: "card-1" },
      {
        type: "card.highlight",
        targetId: "card-1",
        itemId: "t2",
        durationMs: 1200,
      },
      { type: "card.delete", targetId: "card-1" },
      { type: "canvas.restore" },
      { type: "ambient.setPreset", preset: "grainient", theme: "dark" },
      { type: "subtitle.show", text: "Done.", durationMs: 2000 },
    ],
  };

  it("accepts a full valid envelope", () => {
    expect(ActionEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it("rejects an unknown action type", () => {
    const res = ActionEnvelopeSchema.safeParse({
      ...envelope,
      actions: [{ type: "card.explain" }],
    });
    expect(res.success).toBe(false);
  });

  it("rejects unknown fields on the envelope and on actions", () => {
    expect(
      ActionEnvelopeSchema.safeParse({ ...envelope, debug: true }).success,
    ).toBe(false);
    expect(
      ActionEnvelopeSchema.safeParse({
        ...envelope,
        actions: [{ type: "subtitle.show", text: "hi", extra: 1 }],
      }).success,
    ).toBe(false);
  });

  it("rejects subtitle durations outside 300–12000ms", () => {
    for (const durationMs of [100, 12001]) {
      expect(
        ActionEnvelopeSchema.safeParse({
          ...envelope,
          actions: [{ type: "subtitle.show", text: "hi", durationMs }],
        }).success,
      ).toBe(false);
    }
  });
});
