/// <reference types="node" />
/** DOM plumbing only: these mocks exercise lifecycle, not a real browser's image codec. */
import { Blob as NodeBlob, File as NodeFile } from "node:buffer";
import { vi } from "vitest";
import { testPng } from "../../../../local-api/tests/images.fixture";

export function installImageBrowserMocks() {
  const state = {
    width: 2, height: 1, mode: "load" as "load" | "error" | "pending", encodePending: false,
    output: testPng(), images: [] as MockImage[],
  };
  class MockImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = state.width;
    naturalHeight = state.height;
    removeAttribute = vi.fn();
    constructor() { state.images.push(this); }
    set src(_url: string) {
      queueMicrotask(() => { if (state.mode === "load") this.onload?.(); if (state.mode === "error") this.onerror?.(); });
    }
  }
  let urlIndex = 0;
  const createObjectURL = vi.fn(() => `blob:TEST-${++urlIndex}`), revokeObjectURL = vi.fn();
  vi.stubGlobal("Blob", NodeBlob); vi.stubGlobal("File", NodeFile); vi.stubGlobal("Image", MockImage);
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
  const toBlob = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (callback) {
    if (!state.encodePending) queueMicrotask(() => callback(new Blob([Uint8Array.from(state.output)], { type: "image/png" })));
  });
  return { state, createObjectURL, revokeObjectURL, drawImage, toBlob };
}
export function testImageFile(bytes: Uint8Array = testPng(), type = "image/png"): File {
  return new File([Uint8Array.from(bytes)], "TEST_PRIVATE_FILENAME.png", { type });
}
