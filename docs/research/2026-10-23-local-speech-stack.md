# Windows / macOS 本地语音栈核查

核查：2026-10-23。范围为当前源码与官方文档；本轮没有安装新依赖、下载模型、采集麦克风、播放声音或重启现有服务。结论：用户此前所说的框架与 **Sherpa-ONNX / Sherpaw** 相符。ASR、唤醒、VAD 已有实现，应继续复用；**动态本地 TTS 尚未接入**，可在桌面启动器增加独立的 Sherpa-ONNX TTS 进程。

## 当前可以复用什么

| 用途 | 当前实现与模型 | 本轮确认的边界 |
| --- | --- | --- |
| 本地 ASR | `@sherpaw/asr@0.3.0`；X-ASR 中英 INT8，169,227,953 bytes | `speech.worker.ts` 加载并校验缓存中的 encoder / decoder / joiner ONNX 与 tokens，输出文字，不执行动作 |
| 唤醒 | `@sherpaw/kws@0.3.0`；Zipformer 中英 3M，13,076,183 bytes | 已有 `vivic` 两种发音词元；唤醒词本身不作为命令提交。检测唤醒不等于验证说话人身份 |
| VAD | `@sherpaw/vad@0.3.0`；Silero v5，2,313,101 bytes | 16 kHz / 512 samples；在专用 Worker 分段，命令长度和监听时间有界 |
| 模型准备 | `@sherpaw/preloader@0.3.0`、下载 Worker、IndexedDB | 固定 revision / bytes / SHA-256，取消、部分下载、清缓存、错误恢复已有实现；`preloader` 不提供模型或 TTS |
| 动态播报 | STEPFUN 云 TTS；独立的浏览器 `speechSynthesis` 选项 | 浏览器 `localService` 不是跨系统离线保证；系统音色不随安装包提供 |
| 常用反馈 | 16 段 STEPFUN 温柔女声，以及保留的 3 段 Kokoro 文件 | 精确短句匹配；属于随包音频，不能据此称任意文字的本地合成已接通 |

源码入口：[语音清单](../../apps/web/src/ai/localSpeech/manifest.json)、[推理 Worker](../../apps/web/src/ai/localSpeech/speech.worker.ts)、[会话](../../apps/web/src/ai/localSpeech/session.ts)、[提供方](../../apps/web/src/ai/voiceConfig.ts)、[播放](../../apps/web/src/ai/speech.ts)。旧 [Sherpaw 研究](../sherpaw-poc-plan.md) 的“未接入”是当时状态，本轮以现有源码为准；此工作区未找到其引用的 `evidence/phase3-local-speech/REPORT.md`，不把历史验收声明当作本轮运行验证。

## Sherpaw 与 Sherpa-ONNX TTS 的区别

当前锁定 Sherpaw commit `2b12da09ab0cf45894e9565c386bf003cf44a106` 的 WASM [构建配置](https://github.com/moeru-ai/sherpaw/blob/2b12da09ab0cf45894e9565c386bf003cf44a106/sherpa-onnx/build.sh) 明确关闭 `SHERPA_ONNX_ENABLE_TTS`。不能给现有四个包添加一个配置就声称支持 TTS。

官方 [`sherpa-onnx-node` 安装文档](https://k2-fsa.github.io/sherpa/onnx/javascript-api/install.html) 列出 Windows x64、macOS x64 / arm64 原生预编译支持，并要求处理 macOS 动态库路径。适合桌面启动器的可选运行时；Windows ARM64 不在该表内，不能自动列为本轮支持目标。包版本及平台工件还需在正式接入时固定，不能在安装时无约束使用 latest。

## 建议的实现路线

1. **继续使用浏览器现有 KWS / VAD / ASR。** Windows 与 Mac 复用相同 Worker 协议和模型清单；电脑 Control owner 管理录音。现有会话失焦、隐藏、页面退出即停止，维持这个前台边界；“全系统后台一直唤醒”属于另一个需要原生音频权限与生命周期的功能。
2. **动态本地 TTS 作为电脑端可选模块。** 在受控 local-api 后增加独立子进程，加载官方 Sherpa-ONNX 原生 addon 和已校验权重。进程只接收有界纯文字、受控音色、语速和请求 ID，不接收任意路径、代码或 URL。只生成音频，由现有浏览器播放与输出设备逻辑接管，避免引入另一套扬声器/麦克风依赖。
3. **优先复用已核查的 Kokoro 中英来源。** 本仓库已有 [生成脚本](../../scripts/generate-short-feedback.py) 与 [固定 provenance](../../apps/web/public/voice-feedback/PROVENANCE.md)。可用同一 ONNX 来源做动态 TTS 初始候选；“温柔”音色须真实试听后选定，不能把 Kokoro 音色标成 STEPFUN 的温柔女声。官方也提供 [v1.1 中英模型及 INT8 候选](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/kokoro.html)，量化质量另测。
4. **明确音频格式接线。** 官方 [Node Kokoro 示例](https://k2-fsa.github.io/sherpa/onnx/javascript-api/examples/tts_kokoro_zh_en.html) 返回 PCM samples 与 sampleRate，配置包含 model、voices、tokens、词典和数据目录。当前 `speech.ts` 只允许 MP3 MIME；接入时应显式增加受控 WAV 编码与校验，保留长度、大小、取消和过期请求隔离，不必为了播放新增 FFmpeg。不要伪造本地词级时间戳。
5. **模型按需准备。** 决策模型、ASR、TTS 独立选择和回收；先以 CPU、有限线程运行，避免与 4B 决策模型同时预热挤占内存。线程/驻留/超时上限需按整机联合测量确定，不能按模型文件大小推算稳定内存。低配置可保留短反馈 + 已选云 TTS，用户选本地失败时说明并保留文字，避免静默切到云。

手机仍是配对后的两页遥控，不承担模型准备和常驻唤醒配置。本地语音设置放电脑高级项，沿用当前简洁设置结构。

## 模型来源与许可记录

- 现有 ASR / KWS：清单锁定的 Apache-2.0；Silero VAD：MIT。Sherpaw 包装代码与 Sherpa-ONNX 代码的 Apache-2.0 不替代每套模型自己的许可证，详见 [LICENSES](../../LICENSES.md)。
- Kokoro 原模型 [hexgrad/Kokoro-82M-v1.1-zh](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh/blob/main/README.md) 标注 Apache-2.0。当前项目固定原 revision `01e7505bd6a7a2ac4975463114c3a7650a9f7218`；ONNX [转换来源](https://huggingface.co/csukuangfj/kokoro-multi-lang-v1_1/tree/914313412b607d95400bcd12446233fbd1248801) 固定 revision `914313412b607d95400bcd12446233fbd1248801`，包含 ONNX、voices、tokens、词典、FST 与 espeak 数据，不能只下载一个 `.onnx`。
- [现有生成器](../../scripts/generate-short-feedback.py) 已记录四个核心文件 SHA-256，但动态分发还需完整目录清单、大小、散列和各文件通知。eSpeak NG [COPYING](https://github.com/espeak-ng/espeak-ng/blob/master/COPYING) 为 GPLv3；不得把整个数据/原生依赖包一概写为 Apache-2.0。是否包含与如何分发须按实际工件核对，同时保留许可/通知和对应来源。

## 验证边界与接入验收

本轮只完成只读核查与这份记录，未宣称新增 Windows / Mac TTS 已运行。现成源码具有跨浏览器设计，不代表本轮已实测 Safari、Mac 原生 addon、后台权限、实际延迟或听感。

接入后应分别在 Windows x64、Apple Silicon macOS、Intel macOS 用对应平台实际构建的产物检验：固定依赖加载、动态库、含空格/中文安装路径、模型完整与损坏/取消、断网热启动、并发决策的延迟与峰值内存、关闭窗口/切 owner/播报取消后的资源回收。自动化只使用固定 PCM 与文件输出，不采物理麦克风、不实际播放；用户授权的听感和真实麦克风验收另记。
