import type { DisplayClientStatus } from "./displayClient";

// Read-only bridge for shared card renderers. Importing a renderer must not
// initialize the legacy controller, local speech manager or model workers.
let readStatus: () => DisplayClientStatus | null = () => null;
export const getDisplayStatus = (): DisplayClientStatus | null => readStatus();
export const setDisplayStatusReader = (reader: () => DisplayClientStatus | null): void => { readStatus = reader; };
