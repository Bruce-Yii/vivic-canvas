import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { filePreferences } from "../src/preferences.js";

// Isolated temp files only; the user's real ~/.vivic is never touched.
const dirs: string[] = [];
const tempFile = () => { const dir = mkdtempSync(join(tmpdir(), "vivic-TEST-prefs-")); dirs.push(dir); return join(dir, "nested", "preferences.json"); };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("file preferences", () => {
  it("round-trips names across instances and removes cleared fields", () => {
    const path = tempFile();
    filePreferences(path).update({ activeProvider: "gpt", gptSource: "vivic", gptModel: "gpt-6-luna" });
    expect(filePreferences(path).read()).toEqual({ activeProvider: "gpt", gptSource: "vivic", gptModel: "gpt-6-luna" });
    const store = filePreferences(path);
    store.update({ gptSource: undefined, gptModel: undefined });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ activeProvider: "gpt" });
  });

  it("ignores a missing, corrupt or out-of-contract file and rejects invalid values", () => {
    const path = tempFile();
    expect(filePreferences(path).read()).toEqual({});
    filePreferences(path).update({ activeProvider: "gpt" });
    writeFileSync(path, "{not json");
    expect(filePreferences(path).read()).toEqual({});
    writeFileSync(path, JSON.stringify({ activeProvider: "claude" }));
    expect(filePreferences(path).read()).toEqual({});
    const store = filePreferences(path);
    store.update({ gptModel: "../../etc/passwd" });
    expect(store.read()).toEqual({});
  });
});
