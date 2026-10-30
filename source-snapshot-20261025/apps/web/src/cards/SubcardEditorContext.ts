import { createContext } from "react";
import type { Action } from "@/contracts";
export interface SubcardEditor { editable: boolean; dispatch: (action: Action) => boolean }
export const SubcardEditorContext = createContext<SubcardEditor | null>(null);
/** Portals need the same surface tokens as the React Flow node they came from. */
export const SubcardThemeContext = createContext<"light" | "dark">("light");
