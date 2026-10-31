import { describe, expect, it } from "vitest";
import { STARTLUX_DEFAULT_PROFILE_ID, STARTLUX_PROFILES, recommendStartluxProfile } from "../src/runtime/startluxProfiles.js";

const GiB = 2 ** 30;
const recommend = (total: number, free: number) => recommendStartluxProfile({ totalMemoryBytes: total * GiB, freeMemoryBytes: free * GiB });

describe("StartLux hardware advice", () => {
  it("keeps 4B as the principal recommendation and never automatically selects 9B", () => {
    expect(STARTLUX_DEFAULT_PROFILE_ID).toBe("startlux-4b");
    expect(STARTLUX_PROFILES.filter(profile => profile.recommended).map(profile => profile.id)).toEqual(["startlux-4b"]);
    expect(recommend(16, 8)).toEqual({ profileId: "startlux-4b", reason: "recommended", basis: "vivic-estimate" });
    expect(recommend(256, 200).profileId).toBe("startlux-4b");
    expect(STARTLUX_PROFILES.find(profile => profile.id === "startlux-9b")?.autoSelect).toBe(false);
  });

  it("uses both total and current free memory, including exact tier boundaries", () => {
    expect(recommend(16, 8 - 1 / GiB).profileId).toBe("startlux-2b");
    expect(recommend(16 - 1 / GiB, 8).profileId).toBe("startlux-2b");
    expect(recommend(8, 4)).toMatchObject({ profileId: "startlux-2b", reason: "lower-memory" });
    expect(recommend(8, 4 - 1 / GiB).profileId).toBe("startlux-0.8b");
    expect(recommend(8 - 1 / GiB, 4).profileId).toBe("startlux-0.8b");
    expect(recommend(6, 2)).toMatchObject({ profileId: "startlux-0.8b", reason: "lower-memory" });
    expect(recommend(6 - 1 / GiB, 2).profileId).toBeNull();
    expect(recommend(64, 2 - 1 / GiB)).toMatchObject({ profileId: null, reason: "insufficient-memory" });
    expect(recommend(64, 0).reason).toBe("insufficient-memory");
  });

  it("does not select a model from impossible or missing memory measurements", () => {
    for (const [total, free] of [[0, 0], [-1, 0], [8, -1], [8, 9], [NaN, 4], [16, NaN], [Infinity, 4], [16, Infinity]])
      expect(recommend(total!, free!)).toEqual({ profileId: null, reason: "invalid-memory", basis: "vivic-estimate" });
  });

  it("pins artifacts independently of mutable main branches and makes engine/license requirements explicit", () => {
    for (const profile of STARTLUX_PROFILES) {
      expect(profile.gguf.revision).toMatch(/^[a-f0-9]{40}$/);
      expect(profile.source.revision).toMatch(/^[a-f0-9]{40}$/);
      expect(profile.gguf.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(profile.gguf.bytes).toBeGreaterThan(0);
      const url = new URL(profile.gguf.url);
      expect(url.hostname).toBe("huggingface.co");
      expect(url.pathname).toBe(`/${profile.gguf.repo}/resolve/${profile.gguf.revision}/${profile.gguf.name}`);
      expect(profile.license).toBe("CC-BY-NC-4.0");
      expect(profile.requiresStartluxEngine).toBe(true);
    }
  });
});
