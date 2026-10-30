import { createContext } from "react";
import type { CardDefinition } from "@vivic/card-runtime";

export interface HostedDefinitionScope {
  loading: boolean;
  error?: string;
  get(reference: { id: string; version: string; hash: string }): CardDefinition | undefined;
}
/** A logged-in server scope takes precedence over this browser's legacy installed packages. */
export const HostedDefinitionContext = createContext<HostedDefinitionScope | null>(null);
