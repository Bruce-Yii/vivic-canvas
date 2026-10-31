/** Metadata verified against the official Hugging Face API on 2026-10-23.
 * These profiles describe candidates, not an installed or trained runtime.
 * See docs/research/startlux-profiles.md for engine and license requirements.
 */
export type StartluxProfileId = "startlux-0.8b" | "startlux-2b" | "startlux-4b" | "startlux-9b";
export type StartluxProfile = Readonly<{
  id: StartluxProfileId;
  label: string;
  tier: "low-memory" | "balanced" | "recommended" | "high-end";
  recommended: boolean;
  autoSelect: boolean;
  license: "CC-BY-NC-4.0";
  requiresStartluxEngine: true;
  source: Readonly<{ repo: string; revision: string }>;
  gguf: Readonly<{ repo: string; revision: string; name: string; bytes: number; sha256: string; url: string }>;
  /** Vivic planning estimates for short text decisions, NOT official minimum requirements. */
  estimate: Readonly<{ totalMemoryGiB: number; freeMemoryGiB: number }>;
}>;

export const STARTLUX_ENGINE_REVISION = "83fe6c7d61a687a6e17f118b4f7d8f429f5d3a01";
export const STARTLUX_DEFAULT_PROFILE_ID: StartluxProfileId = "startlux-4b";

function profile(id: StartluxProfileId, size: string, tier: StartluxProfile["tier"],
  sourceRevision: string, ggufRevision: string, bytes: number, sha256: string,
  totalMemoryGiB: number, freeMemoryGiB: number): StartluxProfile {
  const label = `StartLux-Decision-v1.1-${size}-Instant`;
  const repo = `startlux-models/${label}-GGUF`, name = `${label}-Q4_K_M.gguf`;
  return Object.freeze({ id, label, tier, recommended: id === STARTLUX_DEFAULT_PROFILE_ID,
    autoSelect: id !== "startlux-9b", license: "CC-BY-NC-4.0", requiresStartluxEngine: true,
    source: Object.freeze({ repo: `startlux-models/${label}`, revision: sourceRevision }),
    gguf: Object.freeze({ repo, revision: ggufRevision, name, bytes, sha256,
      url: `https://huggingface.co/${repo}/resolve/${ggufRevision}/${name}` }),
    estimate: Object.freeze({ totalMemoryGiB, freeMemoryGiB }) });
}

/** Q4_K_M is Vivic's memory-saving candidate; upstream recommends Q8_0 for GGUF accuracy. */
export const STARTLUX_PROFILES: readonly StartluxProfile[] = Object.freeze([
  profile("startlux-0.8b", "0.8B", "low-memory",
    "6496ae641cc71b149ce9dad69bd97f2a44e7bf11", "529edd1b9dae38fda3ba6a5ab0cbc785c91e8359", 529296992,
    "9a5d52f0d69e86994188aa5a58597e3d09ed602fef5c8a2d34a870b617541e94", 6, 2),
  profile("startlux-2b", "2B", "balanced",
    "f1e6cd147dda82c9ffa3e8e725d5c1f175566fb1", "afb95dbba67e648f4e1b5ad3f770a91f799f9496", 1274396256,
    "d20a1270afe0cef5b29c4d5bb9872c743a9c5e9fcfc388d26645f1d9cfa0fd34", 8, 4),
  profile("startlux-4b", "4B", "recommended",
    "416088f77cfce09633906a3675c7cd2e5dabcf10", "a9ab4199fdff586f86e3baf8c9557f6c5ca0fdc0", 2708804064,
    "5fcfe9771db996a868f78215c08955c21cf5e8188609e17e9c653183d946e84d", 16, 8),
  profile("startlux-9b", "9B", "high-end",
    "18a17f734966b213b2f00fa9c915e8b9af2a9b20", "951208c80943806346b55aed6b5bc2a1fff35d09", 5629108768,
    "d3015763493f625608c4c7743824b14eb4af92da279f1b814458f71a96b07756", 32, 14),
]);

export type StartluxMemorySnapshot = Readonly<{ totalMemoryBytes: number; freeMemoryBytes: number }>;
export type StartluxRecommendation = Readonly<{
  profileId: StartluxProfileId | null;
  reason: "recommended" | "lower-memory" | "insufficient-memory" | "invalid-memory";
  basis: "vivic-estimate";
}>;

/** Pure advisory calculation: no download, OS probe, model activation or speed guarantee.
 * A caller must recheck available memory before starting an engine; GPU/architecture
 * compatibility and installation readiness are separate checks.
 */
export function recommendStartluxProfile(memory: StartluxMemorySnapshot): StartluxRecommendation {
  const { totalMemoryBytes: total, freeMemoryBytes: free } = memory;
  if (!Number.isFinite(total) || !Number.isFinite(free) || total <= 0 || free < 0 || free > total)
    return { profileId: null, reason: "invalid-memory", basis: "vivic-estimate" };
  const GiB = 2 ** 30;
  // Deliberately stop at 4B, even on a large machine. 9B is always a manual choice.
  for (const candidate of [...STARTLUX_PROFILES].reverse()) {
    if (candidate.autoSelect && total >= candidate.estimate.totalMemoryGiB * GiB && free >= candidate.estimate.freeMemoryGiB * GiB)
      return { profileId: candidate.id, reason: candidate.recommended ? "recommended" : "lower-memory", basis: "vivic-estimate" };
  }
  return { profileId: null, reason: "insufficient-memory", basis: "vivic-estimate" };
}
