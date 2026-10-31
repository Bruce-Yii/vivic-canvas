# 本地语音实现与主线接入

2026-10-21 更新：控制窗口取得写入权后自动准备 X-ASR、KWS、VAD 三个模型，共 184,617,237 字节；已缓存模型直接复用。只读窗口不下载，准备过程不启动麦克风。下载逐个进行，失败保留单项错误和手动重试；取消、清理缓存或窗口失去写入权会停止相应准备，清理后不会在同一页会话中自动回填。固定唤醒词改为 `vivic`，其英文发音词元已按实际固定模型词表核对；词表通过不等于真人唤醒率验收。下方 2026-10-15 的结果是旧版本历史实测。

同日新增启动权限准备：前台可写控制窗口打开时请求位置和麦克风权限，每页只请求一次；显式关闭位置或选择仅文字输入时保留该选择。麦克风已授权时只检查权限，需要请求时通过 `getUserMedia` 获得授权后立即停止所有临时轨道，不创建录音、转写或上传任务。拒绝、不支持、设备不存在或暂不可用均有设置提示；忽略麦克风提示不会阻塞位置请求或文字输入。实际录音与唤醒仍需手动开启。

2026-10-15。状态：本地 X-ASR / KWS / Silero VAD 的真实 WASM 文件链路已跑通；设置、单次前台唤醒组件及独立浏览器 TTS adapter 已实现。本文更新实现状态；前期依据见 [源码核查](sherpaw-poc-plan.md)。本任务没有修改主线的 ControlApp、VoiceInput、CommandSection、speech.ts、api.ts、PCM 编码器、package、lockfile 或 Vite 配置；主线负责挂载和应用路由。

只沿用 StepFun Coding Plan 与 GPT（Pi 现有 OAuth）的 LLM 范围。本模块不调用任何 LLM、不读认证、不执行卡片动作。STT 和 TTS 独立；GPT 未配置语音仍可纯文字操作。没有增加依赖；使用已安装的 `@sherpaw/{asr,kws,vad,preloader}@0.3.0`。

## 模块冻结通知

**2026-10-15 16:39:40 +08:00 冻结实现。** 不再改动模块、组件、manifest 或脚本，不启动新的推理/浏览器验证，以免干扰主线全量回归和 soak。冻结后仅核对并归档已有 JSON 证据；53 项单测和类型检查是实现轮的结果，归档时没有重跑。

37 个实现/组件/脚本/manifest/测试文件的逐文件 SHA-256 和聚合指纹见 [module-freeze.json](../evidence/phase3-local-speech/module-freeze.json)。聚合指纹：`a2579234802939c0e0784767266b808ae312f02d2be90c4a96c6a90754614128`。本文是状态说明，不包含在该代码指纹内。

最终交付证据已复制到 [`evidence/phase3-local-speech/`](../evidence/phase3-local-speech/REPORT.md)，见[交付报告](../evidence/phase3-local-speech/REPORT.md)及[归档校验清单](../evidence/phase3-local-speech/CHECKSUMS.json)。归档未改变下列原始报告/截图字节，也未改变接口冻结状态。

冻结时已有证据：

| 证据 | 实际结论 | SHA-256 |
| --- | --- | --- |
| [browser-result.json](../evidence/phase3-local-speech/browser-result.json) | 17/17 独立生产浏览器用例通过，page/console error 为 0 | `43eeee804a50ec7c5b5abf113eec3aece070c620dd0f4572431949dd77b02023` |
| [ui-result.json](../evidence/phase3-local-speech/ui-result.json) | 独立开发页通过，零麦克风调用、无 public raw import 错误 | `1cca69da48dd3222dae0c4aaf7effd59e434db493fb3cbaab771bce2d0539549` |
| [设置与唤醒组件截图](../evidence/phase3-local-speech/settings-and-wake.png) | 已实渲染检查，默认不开麦 | `2c2f87ab7f535fbf8326cd9aeedb7e481bdecd7c3728ee4b2eec9f79d5dbffb1` |

**没有当前仍阻塞文件 PoC 的失败项；不等于现场语音验收通过。** 真实 ASR/VAD/虚拟 AudioWorklet 三条链路都返回「十分钟后提醒我喝水」。真实 KWS 命中只对样本中「十分钟」成立；默认「你好维维」仅完成真实词表校验、native 初始化和静音不触发，缺少该短语音频，不能把它记作已通过的声学唤醒。物理麦克风、发声、Safari、长时唤醒及误触发率没有测试。

ASR 全文件该轮为 7.40 秒、VAD→ASR 4.48 秒、虚拟 AudioWorklet→VAD→ASR 11.17 秒，后者包含实时音源等待；这些不是主线端到端或低延迟保证。184–884 MiB 是短时浏览器进程采样合计，不是可靠峰值或 30 分钟稳定性结果。本模块不认领主线正在进行的 GPT/搜索/Plan ASR 回归或 soak 结果。

## 可直接使用的接口

统一入口 `@/ai/localSpeech`：

```ts
// 现有 PTT 已有 16kHz Float32 PCM 时：最长 60 秒，不隐式下载。
const text = await transcribeLocalPcm(samples, {
  sampleRate: 16000,
  signal: controller.signal,
  timeoutMs: 120_000, // 可选，1–300 秒
});

// 模型下载与 React external store；构造/导入不会启动 Worker 或联网。
localSpeechModels.subscribe(listener); // 返回 unsubscribe
localSpeechModels.getSnapshot();      // 引用稳定的快照，更新后换引用
await localSpeechModels.refresh();    // 仅检查缓存，不下载
await localSpeechModels.prepareDefaultModels(); // 仅补齐缺失模型；设置组件会在可写窗口挂载后调用
await localSpeechModels.prepareModel("asr-zh", { signal });
localSpeechModels.cancelDownload("asr-zh");
await localSpeechModels.clearModelCache(); // 可传单个 ModelId
```

`ModelId = "asr-zh" | "kws-zh-en" | "vad"`。快照为：

```ts
{
  models: Record<ModelId, {
    phase: "absent" | "cached" | "downloading" | "verifying" | "ready" | "error";
    loaded: number;
    total: number;
    error: string | null;
  }>;
  busy: boolean;
}
```

`cached` 表示缓存条目与 manifest 身份/大小相符；`ready` 表示本次下载/检查已完成全量 SHA 验证。二者都不代表运行时已预热。实际推理前仍在 Worker 内重读并验证全部字节。`prepareModel` 失败/取消会 reject，调用方应 catch；取消不会发布假 ready。缓存损坏不会隐式重新下载，用户清理后再点下载。

独立设置组件：

```tsx
<LocalSpeechSettings
  disabled={readonly}
  onBeforeClear={() => { cancelAllVoiceWork(); }}
/>
```

可注入 `manager` 便于独立宿主/测试。清除缓存不会神奇地撤销其他调用方已经持有的推理结果，主线应通过 `onBeforeClear` 先取消采集/ASR/云上传。组件只读取缓存和处理用户点击，不自行开启语音。

## 单次唤醒 / VAD 的 UI 与采集

`LocalWakeInput` 可从 `control/LocalWakeInput` 或 `control/LocalSpeechSettings` 导入；无需主线另写麦克风采集。

```tsx
<LocalWakeInput
  disabled={readonly || pttBusy}
  ownerKey={`${providerId}:${canvasId}:${sttMode}`}
  cancelKey={voiceEpoch}
  speaking={ttsPreparing || ttsPlaying}
  recognition={sttMode === "local" ? "local" : "segment"}
  mode="wake" // 可选 "vad"：直接等一句话，不等关键词
  onBegin={() => { cancelTTS(); cancelPTT(); }}
  onTranscript={text => setInputForReview(text)}
  onSegment={async ({ wav, signal }) => {
    // 复用主线既有 /api/transcribe，传递 signal，并保留转写 review。
    await uploadWithExistingAsr(wav, signal);
  }}
/>
```

上面主线函数名为接入示意，不是本模块创建的新后端。`onSegment` 最好返回整个上传 Promise，组件在完成/失败后结束会话；若返回 void，麦克风仍立刻停止，但 segment.signal 会保留到取消、下一次开启或卸载，以免中途取消调用方的异步上传。

挂载和 props 更新绝不开麦。用户每次点击后，最多 **前台等待 300 秒，只收一段（最长 60 秒）**；结束后显示需要重新开启，不自动循环、不宣称常驻。只在 Control 使用。固定唤醒短语为 **「vivic」**，不开放任意字符串输入框：

```ts
DEFAULT_WAKE_PHRASE === "vivic";
DEFAULT_WAKE_KEYWORDS[0].matches === [
  { tokens: ["V", "IH1", "V", "IH0", "K"] },
  { tokens: ["V", "IY1", "V", "IH0", "K"] },
];
```

`vivic` 的两个英文发音变体逐项通过固定 KWS 包实际 `tokens.txt` 校验；使用该模型的 [CMU 英文音素格式](https://k2-fsa.github.io/sherpa/onnx/kws/pretrained_models/index.html#customize-your-own-keywords)。**这不是默认短语现场命中率或误唤醒率的保证**；历史真实 KWS 命中测试使用授权合成录音中已有的「十分钟」。用户应说完唤醒短语再说命令；与唤醒词粘连的命令首字仍需现场调试。转写依照用户的自动发送选项处理，默认自动发送，关闭后留在输入框供检查。

`ownerKey / recognition / mode / cancelKey` 变化、disabled、speaking、blur、hidden、pagehide、取消按钮和卸载均会停止会话、关闭 AudioContext、释放 stream/port/Worker，过期回调不再交付文字。**主线在同窗口 PTT 开始、provider 切换、外部 TTS 取消或整体取消时递增 `cancelKey`；不要依赖按钮焦点变化等同于 window blur。** 不要在该组件自身 `onBegin` 内递增同一个 key，否则会取消刚开启的会话。

内部 `MicCapture` 也公开导出，供其他已获授权的采集宿主复用：

```ts
const capture = new MicCapture(); // 不开麦
const ready = session.start();
// 直接在 click 中调用；先同步发起 AudioContext.resume，再等待 ready。
await capture.start({ ready, signal, maxSeconds: 300,
  onPcm: (pcm, rate) => session.acceptPcm(pcm, rate),
  onError: error => { session.stop(); showFallback(error); },
});
capture.stop(); // dispose() 则永久释放该采集器
```

采集复用 `/audio-capture-worklet.js`；worklet 强制单声道，输出连接零增益节点，不作麦克风回放。使用 AudioContext 实际采样率，65-tap/1024-phase 的有状态低通重采样器保留跨 packet 相位和历史，以 16 kHz 交付，不按每块重新计算比例。队列超过 8000 个 16k 帧会停止并降级，不能静默丢帧或无限积压。权限请求被取消后，迟到的 MediaStream 也会立即 stop。

## 不带 UI 的会话接口

已有 PCM 采集器可跳过 `MicCapture`：

```ts
const session = createLocalSpeechSession({
  mode: "wake", // 或 "ptt" / "vad"
  recognition: "segment", // 或 "local"
  keywords: DEFAULT_WAKE_KEYWORDS,
  maxListenSeconds: 60,   // 默认 60；允许 1–300
  maxSegmentSeconds: 15,  // 默认 15；允许 0.5–60
  signal,
  onEvent,
});
await session.start();
await session.acceptPcm(pcm16k, 16000); // 每块最多 1 秒；必须 await，调用者 buffer 不被 detach
await session.finish();               // PTT 手动收尾；VAD/KWS 可自动结束
session.stop();
session.dispose();
```

事件有 `status`、`wake`、`segment`、`transcript`、`fallback`。`segment` 带 `{ samples, sampleRate: 16000, wav, signal }`，WAV 复用现有 PCM16 编码器；本模块绝不自动上传。`transcript` 只交付完整最终文字，无部分指令执行。失败发出 fallback 并终止 Worker；主线保留 PTT/文字，不自动换云 provider。单次结果后下一次必须显式 `start()`。

KWS/VAD 在专用 Worker 内运行，捕获命令后先 terminate 监听 Worker，再为本地 ASR 建立新的 Worker，避免三个独立 WASM 堆同时常驻。ASR 使用 CPU 在线 Transducer 对有界音段做识别；不是持续部分转写 UI，不启用 WebGPU。超时/AbortSignal 会 terminate Worker；native 同步计算无法靠 JS 队列内取消中断，所以不等待 native 自行返回。

## 下载、缓存和来源

模块仅导入同目录 `manifest.json?raw`；`public/models/sherpaw-manifest.json` 供 URL 访问，不能再从 JavaScript 导入 public 路径。专属测试校验两份逐字节一致。仅 manifest/说明入 public，权重不入仓库 public。

| ID | 固定来源 | 文件大小 | 模型许可 |
| --- | --- | ---: | --- |
| asr-zh | moeru-ai X-ASR zh-en 480ms INT8，HF `d9ab70a45493b97ae76e08574fcbc5ad0c5d0039` | 169,227,953 bytes | Apache-2.0 |
| kws-zh-en | moeru-ai Zipformer zh-en 3M，HF `1770a4b22db32184c110ac43c601db17cc9c93f8` | 13,076,183 bytes | Apache-2.0 |
| vad | Sherpa 维护者 csukuangfj/vad，HF `fba88cd2e921609e7675c3aaf51e0b9b295da4bc` | 2,313,101 bytes | Silero MIT |

精确 URL、SHA-256、metadata、licenseUrl 均见 [manifest](../apps/web/src/ai/localSpeech/manifest.json)。VAD 原 GitHub release 没有浏览器 CORS 头，已换为维护者固定 HF revision；[HF 文件元数据](https://huggingface.co/api/models/csukuangfj/vad?blobs=true) 与原归档的 `6b99cbfd...` SHA 完全一致。真实浏览器已验证该 URL 的下载/校验。其余来源和代码 Apache-2.0 / 上游 NOTICE 见 [原始核查](sherpaw-poc-plan.md)。TTS 不是此模型表的一部分。

下载在独立模型 Worker 中进行：限定固定 URL、omit credentials、实际字节上限、完整 SHA-256 后写入 IndexedDB `vivic-local-speech-v1`；取消不提交部分文件。缓存写入有跨 Worker/页签的 IDB lease：清理会更新 lease，旧下载之后即使完成也不能回填。缓存检查的晚到结果不能覆盖更新的下载状态。浏览器配额、私密模式、缓存回收或网络失败会明确报错，不标假成功；用户可取消/清理后重试。

WASM 另来自 npm 包，模型大小不代表 RAM。ASR 使用包当前可工作的无参 `initASRModule()`，不使用错误的 `@sherpaw/asr/module.wasm` 导出。标准生产构建仍会显示上游 fallback WASM URL / Node `module` externalized 的 warning；浏览器正常走 `locateFile` 的实际资源，本轮生产构建/推理均通过，未修改 node_modules 或主线 Vite。

## 独立浏览器 TTS

```ts
const tts = createBrowserTtsAdapter(); // 默认关闭；不会说话
tts.voices();                        // id/name/lang/localService/default
const unsubscribe = tts.subscribeVoices(refreshVoices);
tts.setEnabled(true);                // 用户主动选择
await tts.speak(text, {
  voiceId, localOnly: true, signal,
  rate: 1, volume: 0.8,             // rate 0.5–2；volume 0–1
  onStart: () => setPlaying(true),
  onBoundary: (charIndex, charLength) => updateSubtitle(charIndex, charLength),
});
tts.cancel(); unsubscribe(); tts.dispose();
```

只在真实 `utterance.onstart` 才调 `onStart`，不能把调用 speak 当作 playing；boundary 位置对应 trim 后实际播报文字。取消/结束/报错清除 onstart/onboundary/onend/onerror、信号与超时，旧事件不会更新新语音状态。默认只选 `localService` 音色；它是浏览器/系统声明，不是已证明断网可用，语言包下载、设备/浏览器服务可能影响结果。此 adapter 与 Sherpaw 无关；本轮只用假 SpeechSynthesis 做事件测试，没有实际发声。

## 可复现检查与真实结果

从项目根运行（只运行本模块专属检查）：

```sh
pnpm --filter @vivic/web exec vitest run src/ai/localSpeech/__tests__
pnpm --filter @vivic/web exec tsc --noEmit -p src/ai/localSpeech/tsconfig.check.json
node scripts/speech-models/download.mjs --all
SPEECH_POC_LIVE_VAD=1 node scripts/speech-models/poc.mjs
node scripts/speech-models/dev-smoke.mjs
```

CLI 下载逐字节核验写出的磁盘文件，使用原子 rename，临时文件在取消/失败时清除。仅写 `.cache/sherpaw-poc/models/`。独立 PoC 将 bundle/报告写 `.cache/sherpaw-poc/`，使用系统分配临时端口、结束后关闭；不运行 5174/8788 的集成 Playwright。模型浏览器缓存也在测试末清除。

2026-10-15 本机 **Apple M1 / 8 GiB，Headless Chrome 156.0.8078.4**：

- **53 个专属单测通过**：校验/截断/超限、取消与缓存 lease、过期 generation、队列上限、PCM 与时限、TTS 事件/参数、设置默认不下载、UI owner/PTT/provider/TTS/失焦取消、晚到权限流清理等。局部 TypeScript 检查通过。
- **17 个独立生产浏览器项目通过，page/console error 为 0**；最终该轮端口 `54349` 已关闭。完整原始报告：[browser-result.json](../evidence/phase3-local-speech/browser-result.json)。
- **独立 Vite 开发页检查通过**：启用正常 public 目录规则，设置和单次唤醒组件均真实挂载；3 个模型条目、固定短语标签、默认零麦克风调用，page/console error 为 0，无 public raw import。端口 `59402` 已关闭。[ui-result.json](../evidence/phase3-local-speech/ui-result.json)、[实渲染截图](../evidence/phase3-local-speech/settings-and-wake.png)；截图已检查，使用现有 Button、Lucide 与项目 CSS。
- **真实 X-ASR 文件识别**：仅使用现有 `evidence/phase2-voice-input/synthetic-command.wav`（11.184 秒，合成音，非现场麦克风），返回「十分钟后提醒我喝水」。该轮含缓存读取/再次 SHA/初始化和识别为 **7.40 秒**；VAD 分段 → 本地 ASR 串联 **4.48 秒**，同样返回完整命令。
- **真实 AudioWorklet 验证**：授权 WAV → AudioBufferSource/虚拟 MediaStream → 原 public AudioWorklet → 本模块有状态 48k→16k → Silero VAD → X-ASR，输出同一句文字。收到 58,016 个 16k PCM 帧，整条含实时文件播放时钟和推理 **11.17 秒**。没有请求物理麦克风；音源不连接扬声器，capture 输出零增益，浏览器额外 `--mute-audio`。本测试允许自动恢复 AudioContext 仅为虚拟音源验收，不能替代实际用户手势/权限 UX。
- **KWS**：真实权重识别合成录音中的「十分钟」，再交有界 VAD 段；固定「你好维维」的 token/native 初始化及静音不触发通过，未录制该默认短语做声学命中验收。
- 下载取消、三个模型 SHA、真实 IDB 清理/旧 lease 拒写/损坏检测、真实 ASR abort 和前台 blur 取消通过。ASR/KWS 浏览器下载测试从已下载文件经 loopback 流式提供，时间不是公网下载速度；`SPEECH_POC_LIVE_VAD=1` 的 VAD 直接走固定 HF URL 验证了真实 CORS。
- 该轮浏览器进程 RSS 每 500ms 的采样合计范围约 **184–884 MiB**，含浏览器/renderer 等该实例进程，不是纯模型内存或可靠峰值；数据在同一报告 `resources`。不是长时间 CPU/温升/swap 压测，不能承诺同机完整 Vivic 画布下有同样占用或时延。

尚未完成：物理麦克风/现场人声、默认「你好维维」的召回/误唤醒率、Safari、5 分钟长时稳定性、锁屏/系统睡眠可靠唤醒、主线全页与 GPU 背景共存性能、页面及运行时资源断网重载、真实 TTS 声音。上述保持实验项；任一失败均保留 PTT/文字。主线整合测试结果由主线另行记录，不能用本模块文件 PoC 替代。

## 变更范围

新增 `apps/web/src/ai/localSpeech/**`（实现、同目录 manifest、专属 tests/检查配置）、`control/LocalSpeechSettings.tsx`、获扩展授权的 `control/LocalWakeInput.tsx`、`scripts/speech-models/**`、public 的 manifest/README 以及本文。模型权重与生成 bundle 保留在获准的 `.cache/sherpaw-poc/**`；非秘密 JSON 报告、冻结清单、模型 manifest 与截图另行归档到 `evidence/phase3-local-speech/`，正式交付链接不再依赖 cache。未递归委派、未调用外部 agent CLI、未触碰 Pi 认证。
