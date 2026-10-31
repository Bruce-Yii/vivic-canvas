import { describe, expect, it } from "vitest";
import { CardRecordSchema, SCENES, sceneOfCard } from "@/contracts";
import { buildDemoCards, RING_ORDER } from "../demoCards";

describe("landing demo cards", () => {
  const cards = buildDemoCards(Date.parse("2026-10-17T06:00:00Z"));

  it("every demo card passes the same schema the canvas uses", () => {
    for (const [key, { card, prompt }] of Object.entries(cards)) {
      const parsed = CardRecordSchema.safeParse(card);
      expect(parsed.success, `${key}: ${parsed.success ? "" : parsed.error.message}`).toBe(true);
      expect(prompt.trim().length).toBeGreaterThan(0);
    }
  });

  it("the ring shows all twenty-one scene cards once, plus classic cards", () => {
    expect(new Set(RING_ORDER).size).toBe(RING_ORDER.length);
    const scenes = new Set(RING_ORDER.map(key => sceneOfCard(cards[key].card)).filter(Boolean));
    expect(scenes.size).toBe(SCENES.length);
  });
  it("labels tourism as a synthetic demo without live availability or booking links", () => {
    expect(RING_ORDER).toContain("travel");
    expect(cards.travel.card.type).toBe("TravelOffersCard");
    if (cards.travel.card.type !== "TravelOffersCard") throw new Error("Travel demo fixture has wrong type");
    expect(cards.travel.card.displayProps.mode).toBe("demo");
    expect(cards.travel.card.displayProps.items.every(item => !item.detailUrl)).toBe(true);
    expect(cards.travel.card.sourceData.provider).toBe("vivic-demo");
    expect(cards.travel.prompt).toContain("DEMO");
  });
});
