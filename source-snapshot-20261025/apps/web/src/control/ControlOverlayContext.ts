import { createContext } from "react";

/** Keep Radix menus and confirmations inside an enclosing native top layer. */
export const ControlOverlayContext = createContext<HTMLElement | null>(null);
