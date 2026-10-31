import { createContext } from "react";
/** Bound by the existing elected owner/display, never inferred from imported card metadata. */
export const FileScopeContext = createContext<string | null>(null);
