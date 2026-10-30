import { useEffect, useState } from "react";
import type { CardDefinition } from "@vivic/card-runtime";
import { loadBuiltinOfficeDefinitions, officePlannerKind, type OfficePlannerKind } from "./builtinOfficePackages";

export function useOfficePlannerKind(definition: CardDefinition | undefined): OfficePlannerKind | undefined {
  const [, setLoaded] = useState(0);
  useEffect(() => {
    let active = true;
    void loadBuiltinOfficeDefinitions().then(() => { if (active) setLoaded(value => value + 1); })
      .catch(() => { /* The generic validated host remains available if a bundled package cannot load. */ });
    return () => { active = false; };
  }, []);
  return officePlannerKind(definition);
}
