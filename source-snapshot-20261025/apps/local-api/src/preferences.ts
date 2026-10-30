import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

/**
 * Which model connection the user chose, so a backend restart (tsx watch
 * reloads on every source edit) does not silently fall back to a disconnected
 * StepFun or forget a working GPT login. Holds names only — never keys or
 * tokens; GPT authorization stays in Pi's own auth.json.
 */
const PreferencesSchema = z.object({
  activeProvider: z.enum(["stepfun", "gpt"]).optional(),
  gptSource: z.enum(["pi", "vivic"]).optional(),
  gptModel: z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/).optional(),
});
export type ProviderPreferences = z.infer<typeof PreferencesSchema>;

export interface PreferenceStore {
  read(): ProviderPreferences;
  update(change: Partial<Record<keyof ProviderPreferences, string | undefined>>): void;
}

export const filePreferences = (path: string): PreferenceStore => {
  let current: ProviderPreferences | undefined;
  const read = (): ProviderPreferences => {
    if (current) return current;
    try {
      const parsed = PreferencesSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
      current = parsed.success ? parsed.data : {};
    } catch {
      current = {};
    }
    return current;
  };
  return {
    read,
    update(change) {
      const next = PreferencesSchema.safeParse(Object.fromEntries(
        Object.entries({ ...read(), ...change }).filter(([, value]) => value !== undefined)));
      if (!next.success || JSON.stringify(next.data) === JSON.stringify(current)) return;
      current = next.data;
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
      } catch {
        // A read-only home only loses restore-after-restart, never a request.
      }
    },
  };
};
