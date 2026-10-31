import type { WakeKeyword } from "./types";

/** Fixed preset only. Every token was checked against the SHA-pinned 3M model vocabulary. */
export const DEFAULT_WAKE_PHRASE = "vivic";
export const DEFAULT_WAKE_KEYWORDS: WakeKeyword[] = [{
  label: DEFAULT_WAKE_PHRASE,
  matches: [
    // English /ˈvɪvɪk/ and /ˈviːvɪk/, using the model's CMU-phone vocabulary.
    { tokens: ["V", "IH1", "V", "IH0", "K"] },
    { tokens: ["V", "IY1", "V", "IH0", "K"] },
  ],
  score: 1,
  threshold: 0.25,
}];
