import { BoundedCapture } from "./capture";
import { readVerifiedModel } from "./download";
import { getSpeechModel, validatePcm } from "./models";
import { IndexedDbModelStorage, matchesModel } from "./storage";
import type { SpeechRequest, SpeechResponse } from "./protocol";
import type { VadInstance } from "@sherpaw/vad";
import type { KeywordSpotter } from "@sherpaw/kws/core";

const scope = self as unknown as { onmessage: ((event: MessageEvent<SpeechRequest>) => void) | null; postMessage: (data: SpeechResponse, transfer?: Transferable[]) => void };
const storage = new IndexedDbModelStorage();
let capture: BoundedCapture | undefined;
let vad: VadInstance | undefined;
let kws: KeywordSpotter | undefined;
let queue = Promise.resolve();
let failed = false;
const reply = (message: SpeechResponse, transfer?: Transferable[]) => scope.postMessage(message, transfer);
const release = () => { kws?.dispose(); kws = undefined; vad?.free(); vad = undefined; };

async function run(message: SpeechRequest) {
  if (failed) throw new Error("识别 Worker 已失败，请重新开始或使用文字。");
  if (message.op === "listen") {
    if (capture) throw new Error("此监听会话已开始。");
    const config = message.config;
    if (config.requireAsr && !matchesModel(await storage.get("asr-zh"), getSpeechModel("asr-zh"))) throw new Error("请先下载本地识别模型，或改用云 ASR / 文字。");
    capture = new BoundedCapture(config.mode, config.maxSegmentSeconds);
    if (config.mode !== "ptt") {
      const [{ initVADModule, createVad }, { loadVirtualData }, bytes] = await Promise.all([
        import("@sherpaw/vad"), import("@sherpaw/preloader"), readVerifiedModel(storage, getSpeechModel("vad")),
      ]);
      const module = await initVADModule();
      loadVirtualData({ module, virtualData: { "silero_vad_v5.onnx": new Uint8Array(bytes) } });
      vad = createVad(module, { sileroVad: { model: "./silero_vad_v5.onnx", windowSize: 512,
        threshold: 0.5, minSpeechDuration: 0.25, minSilenceDuration: 0.6, maxSpeechDuration: config.maxSegmentSeconds },
        sampleRate: 16000, numThreads: 1, provider: "cpu", debug: 0, bufferSizeInSeconds: config.maxSegmentSeconds + 2 });
      if (!vad.handle) throw new Error("VAD 初始化失败。");
    }
    if (config.mode === "wake") {
      if (!config.keywords?.length) throw new Error("唤醒模式需要已编码的关键词词元。");
      const [{ initKWSModule, createKeywordSpotter }, { loadData }, bytes] = await Promise.all([
        import("@sherpaw/kws/core"), import("@sherpaw/preloader"), readVerifiedModel(storage, getSpeechModel("kws-zh-en")),
      ]);
      const module = await initKWSModule();
      loadData({ module, data: bytes, metadata: getSpeechModel("kws-zh-en").metadata! });
      kws = createKeywordSpotter(module, { model: { encoder: "/encoder.onnx", decoder: "/decoder.onnx", joiner: "/joiner.onnx", tokens: "/tokens.txt" },
        keywords: config.keywords, maxActivePaths: 4 });
    }
    reply({ id: message.id, type: "ack" });
  } else if (message.op === "pcm") {
    if (!capture || capture.isDone) throw new Error("监听会话未就绪。");
    validatePcm(message.samples, 16000, 16000);
    for (let offset = 0; offset < message.samples.length; offset += 512) {
      const frame = message.samples.subarray(offset, offset + 512);
      if (!capture.isArmed) {
        const hit = kws?.processAudio(frame, 16000)[0];
        if (hit && capture.wake()) {
          vad?.reset();
          reply({ id: message.id, type: "wake", label: hit.label });
        }
        continue; // Do not submit the wake phrase itself as a command.
      }
      const wasRecording = capture.isRecording;
      vad?.acceptWaveform(frame);
      const speech = vad?.isDetected() ?? true;
      let ended = false;
      while (vad && !vad.isEmpty()) { ended = true; vad.pop(); }
      const segment = capture.accept(frame, speech, ended);
      if (!wasRecording && capture.isRecording) reply({ id: message.id, type: "recording" });
      if (segment) {
        release();
        reply({ id: message.id, type: "segment", samples: segment }, [segment.buffer]);
        break;
      }
    }
    reply({ id: message.id, type: "ack" });
  } else if (message.op === "finish") {
    if (!capture) throw new Error("监听会话未就绪。");
    const samples = capture.finish();
    release();
    reply({ id: message.id, type: "segment", samples }, [samples.buffer]);
    reply({ id: message.id, type: "ack" });
  } else {
    validatePcm(message.samples, 16000);
    const [{ initASRModule, createStreamingRecognizer }, { loadData }, bytes] = await Promise.all([
      import("@sherpaw/asr"), import("@sherpaw/preloader"), readVerifiedModel(storage, getSpeechModel("asr-zh")),
    ]);
    // Use the working default initializer; package's module.wasm export is incorrect in 0.3.0.
    const module = await initASRModule();
    loadData({ module, data: bytes, metadata: getSpeechModel("asr-zh").metadata! });
    const recognizer = await createStreamingRecognizer(module, {
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: { transducer: { encoder: "/encoder.onnx", decoder: "/decoder.onnx", joiner: "/joiner.onnx" },
        tokens: "/tokens.txt", numThreads: 1, provider: "cpu", debug: 0 },
      enableEndpoint: 0, decodingMethod: "greedy_search",
    });
    try {
      for (let offset = 0; offset < message.samples.length; offset += 1600) await recognizer.accept(message.samples.subarray(offset, offset + 1600));
      const text = (await recognizer.finish()).trim();
      if (!text || text.length > 500 || /[\p{Cc}\p{Cf}]/u.test(text)) throw new Error("本地识别没有返回有效文字，请使用 PTT 或文字。");
      reply({ id: message.id, type: "transcript", text });
    } finally { await recognizer.dispose(); }
  }
}
scope.onmessage = event => {
  const message = event.data;
  queue = queue.then(() => run(message)).catch(error => {
    failed = true;
    release();
    reply({ id: message.id, type: "error", message: error instanceof Error ? error.message : "本地语音失败，请使用 PTT 或文字。" });
  });
};
