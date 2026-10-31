import { describe, expect, it, vi } from "vitest";
import { createBrowserTtsAdapter } from "../browserTts";

const fixture = () => {
  const voices = [
    { voiceURI: "local", name: "Local", lang: "zh-CN", localService: true, default: true },
    { voiceURI: "remote", name: "Remote", lang: "zh-CN", localService: false, default: false },
  ] as SpeechSynthesisVoice[];
  const synthesis = { getVoices: () => voices, speak: vi.fn(), cancel: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const utterances: SpeechSynthesisUtterance[] = [];
  const adapter = createBrowserTtsAdapter({ synthesis: synthesis as unknown as SpeechSynthesis,
    makeUtterance: text => { const utterance = { text } as SpeechSynthesisUtterance; utterances.push(utterance); return utterance; },
  });
  return { adapter, synthesis, utterances };
};
describe("independent browser TTS (mocked, no audio)", () => {
  it("is off by default and discloses localService separately", async () => {
    const { adapter, synthesis } = fixture();
    await expect(adapter.speak("你好")).rejects.toThrow("未启用"); expect(synthesis.speak).not.toHaveBeenCalled();
    expect(adapter.voices()[1]?.localService).toBe(false);
    adapter.setEnabled(true);
    await expect(adapter.speak("你好", { voiceId: "remote" })).rejects.toThrow("音色");
  });
  it("cancels old utterances, ignores stale completion, and stops on abort", async () => {
    const { adapter, synthesis, utterances } = fixture(); adapter.setEnabled(true);
    const first = adapter.speak("第一条"); const firstRejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    const oldEnd = utterances[0]!.onend;
    const abort = new AbortController(), second = adapter.speak("第二条", { signal: abort.signal });
    await firstRejected;
    oldEnd?.call(utterances[0]!, {} as SpeechSynthesisEvent);
    abort.abort(); await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(synthesis.cancel).toHaveBeenCalledTimes(2); adapter.dispose();
  });
  it("uses actual browser start/boundary events and removes every handler on cancellation", async () => {
    const { adapter, utterances } = fixture(); adapter.setEnabled(true);
    const onStart = vi.fn(), onBoundary = vi.fn();
    const promise = adapter.speak("你好世界", { rate: 0.75, volume: 0.4, onStart, onBoundary });
    const utterance = utterances[0]!;
    expect(utterance.rate).toBe(0.75); expect(utterance.volume).toBe(0.4);
    expect(onStart).not.toHaveBeenCalled(); expect(onBoundary).not.toHaveBeenCalled();
    const start = utterance.onstart!, boundary = utterance.onboundary!;
    start.call(utterance, {} as SpeechSynthesisEvent);
    boundary.call(utterance, { charIndex: 1, charLength: 2 } as SpeechSynthesisEvent);
    expect(onStart).toHaveBeenCalledTimes(1); expect(onBoundary).toHaveBeenCalledWith(1, 2);
    const rejected = expect(promise).rejects.toMatchObject({ name: "AbortError" });
    adapter.cancel(); await rejected;
    expect([utterance.onstart, utterance.onboundary, utterance.onend, utterance.onerror]).toEqual([null, null, null, null]);
    start.call(utterance, {} as SpeechSynthesisEvent);
    boundary.call(utterance, { charIndex: 0, charLength: 1 } as SpeechSynthesisEvent);
    expect(onStart).toHaveBeenCalledTimes(1); expect(onBoundary).toHaveBeenCalledTimes(1);
  });
  it.each([{ rate: 0.49 }, { rate: 2.01 }, { rate: NaN }, { volume: -0.1 }, { volume: 1.01 }])("rejects out of range speed/volume before speaking", async options => {
    const { adapter, synthesis } = fixture(); adapter.setEnabled(true);
    await expect(adapter.speak("你好", options)).rejects.toThrow("参数"); expect(synthesis.speak).not.toHaveBeenCalled();
  });
});
