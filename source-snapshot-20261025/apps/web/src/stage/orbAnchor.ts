/**
 * Phase 2a.1 (FIX A): the transient feedback orb must never cover a card.
 * Anchors are probed in a fixed priority order; the first whose full
 * bounding box (orb + 24px margin) is fully on-screen and intersects no
 * card's screen rect wins. Dense canvas => top-center fallback (accepted,
 * reported via `fallback`).
 */

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const ORB_ANCHORS = [
  "top-center",
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
  "center",
] as const;
export type OrbAnchor = (typeof ORB_ANCHORS)[number];

const EDGE = 16;

export const anchorBounds = (
  anchor: OrbAnchor,
  screenW: number,
  screenH: number,
  box: number,
): ScreenRect => {
  switch (anchor) {
    case "top-left":
      return { x: EDGE, y: EDGE, width: box, height: box };
    case "top-center":
      return { x: (screenW - box) / 2, y: EDGE, width: box, height: box };
    case "top-right":
      return { x: screenW - box - EDGE, y: EDGE, width: box, height: box };
    case "bottom-left":
      return { x: EDGE, y: screenH - box - EDGE, width: box, height: box };
    case "bottom-right":
      return { x: screenW - box - EDGE, y: screenH - box - EDGE, width: box, height: box };
    case "center":
      return { x: (screenW - box) / 2, y: (screenH - box) / 2, width: box, height: box };
  }
};

export const anchorCenter = (
  anchor: OrbAnchor,
  screenW: number,
  screenH: number,
  box: number,
): { x: number; y: number } => {
  const b = anchorBounds(anchor, screenW, screenH, box);
  return { x: b.x + box / 2, y: b.y + box / 2 };
};

export const rectsIntersect = (a: ScreenRect, b: ScreenRect): boolean =>
  a.x < b.x + b.width &&
  a.x + a.width > b.x &&
  a.y < b.y + b.height &&
  a.y + a.height > b.y;

/** Canvas world rect -> screen rect via the current React Flow viewport. */
export const cardToScreenRect = (
  layout: { x: number; y: number; width: number; height: number },
  viewport: { x: number; y: number; zoom: number },
): ScreenRect => {
  const z = viewport.zoom || 1;
  return {
    x: layout.x * z + viewport.x,
    y: layout.y * z + viewport.y,
    width: layout.width * z,
    height: layout.height * z,
  };
};

export const chooseOrbAnchor = (args: {
  screenWidth: number;
  screenHeight: number;
  orbSize: number;
  cards: ScreenRect[];
  margin?: number;
}): { anchor: OrbAnchor; fallback: boolean } => {
  const margin = args.margin ?? 24;
  const box = args.orbSize + margin * 2;
  for (const anchor of ORB_ANCHORS) {
    const bounds = anchorBounds(anchor, args.screenWidth, args.screenHeight, box);
    const onScreen =
      bounds.x >= 0 &&
      bounds.y >= 0 &&
      bounds.x + box <= args.screenWidth &&
      bounds.y + box <= args.screenHeight;
    if (!onScreen) continue;
    if (args.cards.every((card) => !rectsIntersect(bounds, card))) {
      return { anchor, fallback: false };
    }
  }
  return { anchor: "top-center", fallback: true };
};
