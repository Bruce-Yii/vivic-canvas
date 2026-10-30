import { definitionRef, validateInstance, type CardDefinition, type CardExample } from "@vivic/card-runtime";
import { ExtensionCardSchema, type CardOfType } from "@/contracts";
import { newId } from "@/lib/id";

export function createExtensionInstance(definition: CardDefinition, example: Pick<CardExample, "config" | "data" | "state">): CardOfType<"ExtensionCard"> {
  validateInstance(definition, example);
  const now = new Date().toISOString();
  return ExtensionCardSchema.parse({ id: newId("ext"), type: "ExtensionCard", variant: "standard", sources: [], sourceData: {},
    displayProps: { def: definitionRef(definition), config: structuredClone(example.config), data: structuredClone(example.data), state: structuredClone(example.state) },
    layout: { x: 0, y: 0, width: 360, height: 340, pinned: false, surface: "user" }, metadata: { createdAt: now, updatedAt: now } });
}
