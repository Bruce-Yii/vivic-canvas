// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalSpeechOptions, MicCaptureOptions } from "../index";
import { LocalWakeInput } from "../../../control/LocalWakeInput";
import type { LocalWakeInputProps } from "../../../control/LocalWakeInput";

const state = vi.hoisted(() => ({
  sessions: [] as { options: LocalSpeechOptions; acceptPcm: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }[],
  microphones: [] as { options?: MicCaptureOptions; stop: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }[],
}));
vi.mock("../index", async importOriginal => {
  const actual = await importOriginal<typeof import("../index")>();
  return { ...actual,
    localSpeechModels: { ...actual.localSpeechModels, prepareModel: vi.fn(async () => {}) },
    createLocalSpeechSession: (options: LocalSpeechOptions) => {
      const session = { options, start: vi.fn(async () => { options.onEvent({ type: "status", status: "listening" }); }),
        acceptPcm: vi.fn(async () => {}), dispose: vi.fn(), stop: vi.fn() };
      state.sessions.push(session); return session;
    },
    MicCapture: class {
      options?: MicCaptureOptions;
      stop = vi.fn(); dispose = vi.fn();
      constructor() { state.microphones.push(this); }
      start = vi.fn(async (options: MicCaptureOptions) => { this.options = options; await options.ready; });
    },
  };
});
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); state.sessions.length = 0; state.microphones.length = 0; });
afterEach(() => { document.body.innerHTML = ""; vi.unstubAllGlobals(); });
const render = async (patch: Partial<LocalWakeInputProps> = {}) => {
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node);
  const props: LocalWakeInputProps = { ownerKey: "provider:canvas:1", recognition: "local", onTranscript: vi.fn(), ...patch };
  await act(async () => root.render(<LocalWakeInput {...props} />));
  const click = async () => { await act(async () => (node.querySelector("button") as HTMLButtonElement).click()); };
  const update = async (values: Partial<LocalWakeInputProps>) => { Object.assign(props, values); await act(async () => root.render(<LocalWakeInput {...props} />)); };
  const unmount = async () => { await act(async () => root.unmount()); };
  return { props, node, click, update, unmount };
};
describe("explicit one-shot wake UI (mocked capture only)", () => {
  it("never enables on mount; a click uses only the verified fixed preset and streams PCM", async () => {
    const onBegin = vi.fn(), view = await render({ onBegin });
    expect(state.microphones).toHaveLength(0); expect(view.node.textContent).toContain("vivic");
    await view.click(); expect(onBegin).toHaveBeenCalledTimes(1);
    expect(state.sessions[0]!.options.maxListenSeconds).toBe(300);
    expect(state.sessions[0]!.options.keywords?.[0]?.label).toBe("vivic");
    expect(state.sessions[0]!.options.keywords?.[0]?.matches[0]?.tokens).toEqual(["V", "IH1", "V", "IH0", "K"]);
    const samples = new Float32Array(512).fill(0.1);
    await state.microphones[0]!.options!.onPcm(samples, 16000);
    expect(state.sessions[0]!.acceptPcm).toHaveBeenCalledWith(samples, 16000);
    await view.unmount(); expect(state.microphones[0]!.dispose).toHaveBeenCalled();
  });
  it.each([{ ownerKey: "other" }, { disabled: true }, { speaking: true }, { cancelKey: 1 }, { recognition: "segment" as const }, { mode: "vad" as const }])("cleans up when owner/provider/PTT/TTS scope changes: %j", async patch => {
    const view = await render(); await view.click(); const session = state.sessions[0]!;
    await view.update(patch);
    expect(session.dispose).toHaveBeenCalled(); expect(state.microphones[0]!.dispose).toHaveBeenCalled();
    await act(async () => session.options.onEvent({ type: "transcript", text: "stale command" }));
    expect(view.props.onTranscript).not.toHaveBeenCalled(); expect(state.sessions).toHaveLength(1);
    await view.unmount();
  });
  it("stops mic before delivery and requires an explicit new click after one transcript", async () => {
    const view = await render(); await view.click();
    await act(async () => state.sessions[0]!.options.onEvent({ type: "transcript", text: "提醒我喝水" }));
    expect(state.microphones[0]!.stop).toHaveBeenCalled(); expect(view.props.onTranscript).toHaveBeenCalledWith("提醒我喝水");
    expect(view.node.textContent).toContain("重新开启"); expect(state.sessions).toHaveLength(1); await view.unmount();
  });
  it("keeps the cloud signal until delivery completes; changing owner aborts it and ignores completion", async () => {
    let resolve!: () => void; const onSegment = vi.fn(() => new Promise<void>(r => { resolve = r; }));
    const view = await render({ recognition: "segment", onSegment }); await view.click(); const session = state.sessions[0]!;
    const signal = session.options.signal!;
    await act(async () => session.options.onEvent({ type: "segment", samples: new Float32Array(3200), sampleRate: 16000,
      wav: new Blob([new Uint8Array(44)]), signal }));
    expect(onSegment).toHaveBeenCalledTimes(1); expect(signal.aborted).toBe(false);
    await view.update({ ownerKey: "new-provider" }); expect(signal.aborted).toBe(true);
    await act(async () => resolve()); expect(view.node.textContent).not.toContain("本次已结束"); await view.unmount();
  });
  it("cancels on foreground loss without restarting", async () => {
    const view = await render(); await view.click();
    await act(async () => window.dispatchEvent(new Event("blur")));
    expect(state.sessions[0]!.dispose).toHaveBeenCalled(); expect(state.sessions).toHaveLength(1); await view.unmount();
  });
});
