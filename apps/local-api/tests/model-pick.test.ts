import { describe, expect, it } from "vitest";
import { pickDefaultModel } from "../src/stepfun.js";

// Real model list captured from the user's live plan on 2026-10-15, with
// step-tts-mini first — the exact ordering that previously produced the
// "模型服务返回 HTTP 404" failure (a TTS model as chat default).
const LIVE_PLAN_MODELS = [
  "step-tts-mini",
  "step-asr",
  "step-1o-turbo-vision",
  "step-1o-audio",
  "step-tts-vivid",
  "step-audio-2",
  "step-audio-2-mini",
  "step-audio-2-think",
  "step-tts-2",
  "dr-search-api",
  "step-gui",
  "step-audio-r1.1",
  "step-3.5-flash",
  "step-asr-1.1",
  "step-3.7-flash",
  "stepaudio-2.5-tts",
  "stepaudio-2.5-asr",
  "stepaudio-2.5-chat",
];

describe("pickDefaultModel never picks a speech/media model as chat default", () => {
  it("live plan list with tts first resolves to step-3.5-flash", () => {
    expect(pickDefaultModel(LIVE_PLAN_MODELS)).toBe("step-3.5-flash");
  });

  it("without preferred models, fallback skips speech/search/models", () => {
    const picked = pickDefaultModel(["step-tts-mini", "step-asr", "step-2-16k"]);
    expect(picked).toBe("step-2-16k");
  });

  it("preferred order beats fallback ordering", () => {
    expect(pickDefaultModel(["step-9-flash", "step-3"])).toBe("step-3");
  });

  it("empty list fails closed instead of inventing access to a model", () => {
    expect(pickDefaultModel([])).toBeUndefined();
  });

  it.each([
    ["step-tts-mini"],
    ["step-tts-mini", "stepaudio-2.5-tts", "step-asr"],
    ["step-TTS-mini", "step-audio-2", "dr-search-api", "step-gui"],
  ])("media-only catalog %j has no chat default", (...ids) => {
    expect(pickDefaultModel(ids)).toBeUndefined();
  });

  it("unknown chat models may be used by an explicitly configured stub", () => {
    expect(pickDefaultModel(["step-tts-mini", "step-9-flash"])).toBe("step-9-flash");
  });

  it("recognizes the documented Plan preview and router models", () => {
    expect(pickDefaultModel(["step-5-preview"])).toBe("step-5-preview");
    expect(pickDefaultModel(["step-router-v1"])).toBe("step-router-v1");
  });
});
