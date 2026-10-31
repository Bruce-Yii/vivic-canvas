import type { CardDefinition } from "@vivic/card-runtime";

/** Old instances keep their exact hash; new automatic matching uses the highest enabled version. */
export function compareCardVersions(left: string, right: string): number {
  const a = left.split("."), b = right.split(".");
  for (let i = 0; i < 3; i++) {
    const x = BigInt(a[i]!), y = BigInt(b[i]!);
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}
export function currentCardDefinitions(definitions: readonly CardDefinition[]): CardDefinition[] {
  const selected = new Map<string, CardDefinition>();
  for (const definition of definitions) {
    const previous = selected.get(definition.manifest.id);
    if (!previous || compareCardVersions(definition.manifest.version, previous.manifest.version) >= 0) selected.set(definition.manifest.id, definition);
  }
  return [...selected.values()];
}
