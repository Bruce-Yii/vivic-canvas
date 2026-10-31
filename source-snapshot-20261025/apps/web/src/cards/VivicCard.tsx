import { memo, Suspense, type ComponentType } from "react";
import type { CardRecord } from "@/contracts";
import type { HighlightState } from "@/state/canvasStore";
import { CARD_VIEWS } from "./registry";
import { CardErrorBoundary } from "./scene/CardErrorBoundary";
import type { CardViewProps } from "./scene/types";

/**
 * Card registry renderer. Only registered, schema-gated types reach this
 * point — unknown types were rejected at the contract boundary and never hit
 * a React component. A failing card shows a contained fallback.
 */
export const VivicCard = memo(({
  record,
  highlight,
  height,
}: {
  record: CardRecord;
  highlight?: HighlightState | null;
  /** Display canvas only: exact content height for fixed-height scene cards. */
  height?: number;
}) => {
  const View = CARD_VIEWS[record.type] as ComponentType<CardViewProps>;
  return <CardErrorBoundary card={record}><Suspense fallback={<div role="status" className="p-4 text-sm text-muted-foreground">正在加载卡片…</div>}>
    <View card={record} highlight={highlight} height={height} />
  </Suspense></CardErrorBoundary>;
});
