import type { CardContract } from "@vivic/contracts";
import type { CanvasContext } from "../schemas.js";

/** Extra values are authenticated/selected by the host, never extracted from model slots. */
export interface CardBuildContext extends CanvasContext {
  targetId?: string;
  itemId?: string;
  /** Host-resolved reference card of a movement relation, never a model slot. */
  relativeToId?: string;
  trustedImageRef?: string;
}
export type BuiltinCardContract = CardContract<unknown, CardBuildContext>;
export function defineCardContract<S>(contract: CardContract<S, CardBuildContext>): BuiltinCardContract {
  return { ...contract, build: (slots, context, now) => contract.build(contract.slots.parse(slots), context, now) };
}
