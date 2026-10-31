import { describe, expect, it } from "vitest";
import {
  anchorBounds,
  anchorCenter,
  cardToScreenRect,
  chooseOrbAnchor,
  rectsIntersect,
  type ScreenRect,
} from "../orbAnchor";

const W = 1440;
const H = 900;
const ORB = 64;
const BOX = ORB + 24 * 2; // orb + margin

const coverCenter: ScreenRect[] = [
  { x: W / 2 - 300, y: H / 2 - 200, width: 600, height: 400 },
];

describe("chooseOrbAnchor (FIX A)", () => {
  it("cards covering center push the orb to a non-overlapping corner/top anchor", () => {
    const { anchor, fallback } = chooseOrbAnchor({
      screenWidth: W,
      screenHeight: H,
      orbSize: ORB,
      cards: coverCenter,
    });
    expect(fallback).toBe(false);
    expect(anchor).not.toBe("center");
    const bounds = anchorBounds(anchor, W, H, BOX);
    expect(coverCenter.every((c) => !rectsIntersect(bounds, c))).toBe(true);
  });

  it("returns the first clean anchor in priority order (top-center when free)", () => {
    const { anchor, fallback } = chooseOrbAnchor({
      screenWidth: W,
      screenHeight: H,
      orbSize: ORB,
      cards: [],
    });
    expect(anchor).toBe("top-center");
    expect(fallback).toBe(false);
  });

  it("skips anchors occupied by cards and lands clean elsewhere", () => {
    // Occupy the entire top edge and center; side bottoms are free.
    const cards: ScreenRect[] = [
      { x: 0, y: 0, width: W, height: 200 },
      coverCenter[0]!,
    ];
    const { anchor, fallback } = chooseOrbAnchor({
      screenWidth: W,
      screenHeight: H,
      orbSize: ORB,
      cards,
    });
    expect(fallback).toBe(false);
    expect(["bottom-left", "bottom-right"]).toContain(anchor);
    const bounds = anchorBounds(anchor, W, H, BOX);
    expect(cards.every((c) => !rectsIntersect(bounds, c))).toBe(true);
  });

  it("dense canvas => top-center fallback, honestly flagged", () => {
    const dense: ScreenRect[] = [{ x: 0, y: 0, width: W, height: H }];
    const { anchor, fallback } = chooseOrbAnchor({
      screenWidth: W,
      screenHeight: H,
      orbSize: ORB,
      cards: dense,
    });
    expect(anchor).toBe("top-center");
    expect(fallback).toBe(true);
  });

  it("on-screen constraint: margins respected at tight screens", () => {
    const { anchor, fallback } = chooseOrbAnchor({
      screenWidth: 140,
      screenHeight: 130,
      orbSize: ORB,
      cards: [],
    });
    expect(fallback).toBe(false);
    const bounds = anchorBounds(anchor, 140, 130, BOX);
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + BOX).toBeLessThanOrEqual(140);
    expect(bounds.y + BOX).toBeLessThanOrEqual(130);
  });
});

describe("geometry helpers", () => {
  it("cardToScreenRect maps canvas world rect through the viewport", () => {
    const rect = cardToScreenRect(
      { x: 100, y: 50, width: 260, height: 120 },
      { x: -200, y: 30, zoom: 1.5 },
    );
    expect(rect).toEqual({ x: 100 * 1.5 - 200, y: 50 * 1.5 + 30, width: 390, height: 180 });
  });

  it("anchorCenter is the middle of anchorBounds", () => {
    const c = anchorCenter("bottom-right", W, H, BOX);
    const b = anchorBounds("bottom-right", W, H, BOX);
    expect(c).toEqual({ x: b.x + BOX / 2, y: b.y + BOX / 2 });
  });
});
