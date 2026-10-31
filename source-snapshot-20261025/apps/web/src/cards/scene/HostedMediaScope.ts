import { createContext } from "react";

/** Online media is resolved by the authenticated Space, never an imported URL/path. */
export const HostedMediaResolverContext = createContext<((reference: string) => string | undefined) | null>(null);
