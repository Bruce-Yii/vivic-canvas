import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { SPEECH_MODELS } from "../models";

it("keeps module and public manifests identical without importing from public", () => {
  const moduleText = readFileSync(new URL("../manifest.json", import.meta.url), "utf8");
  const publicText = readFileSync(new URL("../../../../public/models/sherpaw-manifest.json", import.meta.url), "utf8");
  expect(moduleText).toBe(publicText);
  expect(SPEECH_MODELS).toHaveLength(3);
  for (const model of SPEECH_MODELS) {
    expect(model.url).toMatch(/^https:\/\/huggingface.co\/.*\/resolve\/[a-f0-9]{40}\//);
    expect(model.sha256).toMatch(/^[a-f0-9]{64}$/);
    if (model.metadata) {
      expect(model.metadata.remote_package_size).toBe(model.bytes);
      expect(model.metadata.files.at(-1)?.end).toBe(model.bytes);
    }
  }
});
