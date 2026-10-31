import { createContext, useContext } from "react";
import type { CardRecord, SceneImage } from "@/contracts";

/**
 * One card component serves both surfaces. "display" is the shared stage:
 * browse-only (view-local paging/zoom), no edit controls. "control" is the
 * user's own page: the same data plus edits routed through CardActions.
 */
export type CardMode = "display" | "control";
export const CardModeContext = createContext<CardMode>("display");
export const useCardMode = (): CardMode => useContext(CardModeContext);

export interface CardPatch {
  displayProps?: Record<string, unknown>;
  sourceData?: Record<string, unknown>;
}

/** Edits go through the owner's validated card.update path; never direct state writes. */
export interface CardActions {
  editable: boolean;
  update: (cardId: string, patch: CardPatch) => boolean;
  remove?: (cardId: string) => boolean;
  refresh?: (cardId: string) => Promise<boolean>;
  /** Store user-picked photos locally and return image references for the card. */
  addPhotos?: (files: File[]) => Promise<SceneImage[]>;
}
export const CardActionsContext = createContext<CardActions | null>(null);
export const useCardActions = (): CardActions | null => useContext(CardActionsContext);

/** Edit affordances only exist in control mode with a writable owner. */
export function useCardEditor<T extends CardRecord>(card: T) {
  const actions = useCardActions();
  const mode = useCardMode();
  const editable = mode === "control" && Boolean(actions?.editable);
  return {
    mode,
    editable,
    patch: (displayProps: Partial<T["displayProps"]>): boolean => editable ? actions!.update(card.id, { displayProps: displayProps as Record<string, unknown> }) : false,
    remove: (): boolean => editable && actions?.remove ? actions.remove(card.id) : false,
    refresh: editable && actions?.refresh ? () => actions.refresh!(card.id) : undefined,
    addPhotos: editable && actions?.addPhotos ? actions.addPhotos : undefined,
  };
}
