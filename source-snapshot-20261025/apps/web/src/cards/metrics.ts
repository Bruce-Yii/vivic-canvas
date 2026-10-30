/** Keep CSS reading tokens and conservative canvas estimates together. */
export const CARD_METRICS = {
  paddingX: 22,
  paddingY: 20,
  bodySize: 16,
  lineHeight: 28,
  rowGap: 8,
} as const;
export const CARD_INNER_HEIGHT = CARD_METRICS.paddingY * 2 + 2;
