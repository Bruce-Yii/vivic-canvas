import { z } from "zod";

/** Declarative data only. The host validates these objects against the exact installed definition. */
export const ExtensionDefinitionRefSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/).max(80),
  version: z.string().regex(/^\d+\.\d+\.\d+$/).max(32),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const ExtensionCardDisplayPropsSchema = z.strictObject({
  def: ExtensionDefinitionRefSchema,
  config: z.record(z.string(), z.json()),
  data: z.record(z.string(), z.json()),
  state: z.record(z.string(), z.json()),
});
export type ExtensionCardDisplayProps = z.infer<typeof ExtensionCardDisplayPropsSchema>;
