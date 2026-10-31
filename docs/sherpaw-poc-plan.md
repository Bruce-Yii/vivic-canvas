# Sherpaw 本地语音候选：有限源码核查与 PoC 计划

核查日期：2026-10-15（Asia/Shanghai）。状态：**仅完成原始来源静态研究，未接入 Vivic、未下载权重、未执行 Sherpaw 浏览器推理或本机性能测试**。

独立复核：已通过现有 Pi OAuth 调用 GPT subagent，对下述源码、发布元数据及模型卡证据进行复核；禁用其工具、扩展、MCP、skills 和会话保存。它只评审提供的证据，未独立运行浏览器或下载模型；复核意见已并入本文，不能将其视作第二次实机验证。

## 1. 范围与结论

已先读 `Vivic_Kimi_Handoff_v0.6/{README_FIRST,AGENTS,COMPONENT_LOCK}.md`，并参考 PRD 的 Web 双窗口和文字降级约束。Sherpaw 保持 **PREFERRED-POC**，不升级为已验证组件。本次唯一项目写入为本文；不修改 app、依赖、组件锁定表或现有研究报告。

用户当前约束覆盖旧交接包中更宽的 provider 清单：LLM 仅允许 **StepFun Coding Plan** 与 **GPT（Pi 现有 OAuth）**；本研究不重新调查 StepFun 搜索或 GPT 能力，也不增加第三种 LLM。STT/ASR、TTS 与 LLM 分开选用：GPT 没有配置语音时可以完整保留文字操作；不能因 GPT 登录成功就推导出 STT/TTS 权限。

建议落地顺序：**先验证本地 KWS/VAD → 复用现有 StepFun Plan ASR → 再可选本地 ASR；TTS 始终是独立模块**。前两步仍含云端 ASR，不能称整条链路离线。Sherpaw 的上游框架介绍提及 TTS，不等于本仓库交付了 TTS package。[S1][S2]

## 2. 原仓库快照与包能力

GitHub API 查得默认分支 `main`，当前具体 SHA 为 **`2b12da09ab0cf45894e9565c386bf003cf44a106`**，提交时间 `2026-10-12T17:23:17Z`，消息 `chore: release v0.3.0`。下列源码链接固定此 SHA；不能用将来变化的 `main` 代替此快照。递归 tree 返回 `truncated: false`。[S1]

| 包 | 该 SHA 的源码能力 | npm 当前 latest | Worker 边界 |
| --- | --- | --- | --- |
| `@sherpaw/asr` | `initASRModule`、在线 Transducer/Paraformer、`createStreamingRecognizer` 生命周期及离线识别接口；另有可选 `/webgpu` 入口 | `0.3.0` | 核心 API 不自动创建 Worker；sandbox 的 `runtime.worker.ts` 才包起识别调用 |
| `@sherpaw/vad` | `initVADModule`、`createVad`、音段/环形缓冲等；负责语音活动检测，不输出转写文字 | `0.3.0` | 本包入口无自动 Worker；Vivic PoC 需把同步 WASM 调用放入专用 Worker |
| `@sherpaw/vad-asr` | `initVADASRModule`、VAD + `OfflineRecognizer`；README 示例使用离线 Paraformer | `0.3.0` | 本包入口无自动 Worker；不是云端 ASR adapter，也不是所有在线模型的通用组合入口 |
| `@sherpaw/kws` | 默认异步 `createKeywordSpotter`，`processAudio/setKeywords/reset/dispose`；有 `/core`、`/worker`、`/node` 入口 | `0.3.0` | 默认创建 module Web Worker；core 是调用线程内同步接口，node 使用 worker threads |

依据为各包实际 `package.json`、`src/index.ts` 和实现文件，而非只看仓库简介。[S3][S4][S5][S6] 配套 `@sherpaw/preloader` 当前也是 `0.3.0`，负责把 data/metadata 或虚拟文件装入 Emscripten FS，不提供麦克风、模型权重或模型推理能力。[S7]

**TTS 核查结果：该 SHA 的完整 `packages/` 树没有 `tts` package，也无含 `tts` 的文件路径；`sherpa-onnx/build.sh` 明确设置 `SHERPA_ONNX_ENABLE_TTS=OFF`。** 上游 Sherpa-ONNX 的 TTS 能力不能套用到 Sherpaw 当前发布包。本次没有据此断言整个 npm registry 永远不存在同名包。[S1][S2]

### npm 发布与源码必须分开判断

2026-10-15 直接读取 npm registry：上述四包的 `dist-tags.latest` 均为 `0.3.0`，发布于 `2026-10-12`；KWS 的已发布版本从 `0.2.0` 开始，不能沿用早期 ASR 包资料推断 KWS 已可用。四个 `0.3.0` 元数据均没有 `gitHead`，因此“版本号相同”不能当作 npm 二进制与此 Git SHA 逐字节相同的证明。[S8]

| 发布包 | registry 的 `dist.shasum`（发布包身份，非模型校验值） | 清单中的独立 WASM 大小 |
| --- | --- | ---: |
| asr `0.3.0` | `ef93a38dc4371ee09309079919615584532d0481` | 13,788,938 bytes |
| vad `0.3.0` | `96bb1167cffb6e873fe6ed10d84c30a1e0262eed` | 12,299,952 bytes |
| vad-asr `0.3.0` | `f38df575854ac13fe8d590b9ba5e848d872dbdac` | 13,455,394 bytes |
| kws `0.3.0` | `d101dfb1b56ed7dbef4efe02330ac54c808f8e52` | 12,481,468 bytes |

读取了 npm 原始元数据，以及 UNPKG 提供的这些固定版本的文件清单和少量已发布 JS；未获取 tarball、WASM 二进制或模型 data。UNPKG 是发布文件的分发镜像，本节发现需要后续安装产物 smoke test 确认，不代表已运行通过。[S8][S9]

发现两项具体发布边界：

1. **ASR 的 `./module.wasm` 导出路径不一致。** 源码及已发布 `package.json` 指向 `./dist/asr.wasm`，但构建配置、发布清单和已发布 `initASRModule()` 使用 `dist/prebuilt/asr.wasm`。README 还展示传 `locateFile` 参数，而当前初始化实现无参数且内部生成 URL。不能直接复制旧 README 的 `module.wasm?url` 用法；优先验证当前无参初始化与实际 bundler 的资源输出。[S3][S9]
2. **存在 WebGPU API 不等于 npm 包内资源齐全。** 源码构建按本机是否已有 GPU 产物决定是否复制；`asr@0.3.0` 清单虽有 `dist/webgpu.js`，却没有该入口引用的 `asr-webgpu.js/.wasm` 和 ORT asyncify 资源。源码中可选 GPU 路线需要另行构建及兼容验证；不能承诺直接安装 npm 包即可 GPU 加速。sandbox 对 X-ASR 的 GPU encoder 路径选的是 FP32，不能据此承诺 169 MB INT8 包走 GPU。[S10]

## 3. 模型来源、大小与许可分层

以下 MB 均按十进制；是 `preload.data` 文件大小，**不是**下载压缩包、npm 包、整个 WASM bundle 或峰值 RAM。数据包包含原始 ONNX/token 字节，另需相应运行时。HF revision 来自该 Git SHA 的 submodule gitlink；本次只读模型卡、LICENSE、manifest、metadata，不执行下载脚本。[S11][S12][S13]

| 候选用途 | 模型及精确 data 大小 | Sherpaw 固定的 HF revision | 来源与模型许可 |
| --- | --- | --- | --- |
| KWS 首选比较项 | `sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20`，13,076,183 bytes，约 13.08 MB | `1770a4b22db32184c110ac43c601db17cc9c93f8` | pkufool 中英 KWS，经 k2-fsa `kws-models` 官方 release 分发；HF 包含 Apache-2.0 LICENSE，模型卡注明原模型声明 Apache-2.0 |
| KWS 中文比较项 | `sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01`，13,082,946 bytes，约 13.08 MB | `9b3856fe1cb0c5a460b68303ef2645bcbcfbc021` | pkufool Wenetspeech 中文 KWS，经 k2-fsa `kws-models` release 分发；HF LICENSE 与模型卡均为 Apache-2.0 |
| 可选本地中文/中英 ASR | `sherpaw-x-asr-zh-en-480ms-int8`，169,227,953 bytes，约 169.23 MB（约 161.39 MiB） | `d9ab70a45493b97ae76e08574fcbc5ad0c5d0039` | GilgameshWind/X-ASR-zh-en，经 k2-fsa `asr-models` 的 2026-06-05 INT8 release 分发并重新打包；原模型卡与 HF 包 LICENSE 为 Apache-2.0 |

两个 KWS 包都是 FP32、chunk-16、left-context-64，不能把“3M”理解为 3 MB 或 INT8。KWS 只检测预设 token 序列，**没有文字到 token 的转换器**；需按对应 `tokens.txt` 人工准备/核验发音变体并测误触发。不能把任意中文或“Vivic”字符串直接当可用唤醒词。KWS 命中不是声纹鉴权，也不应直接执行用户动作。[S6][S11][S12]

169 MB 特指上述 **X-ASR 中英流式 480 ms INT8** 包；encoder/joiner 为 INT8，decoder 保留浮点，虚拟文件名统一为 `/encoder.onnx`、`/decoder.onnx`、`/joiner.onnx`、`/tokens.txt`。对应上游压缩归档为 133,895,136 bytes；另一个中文 Zipformer 候选为 167,360,920 bytes，不能混写成同一模型。480 ms 是模型 chunk 设置，不是端到端响应时间保证。[S13][S14]

未来下载后应核验的 `preload.data` SHA-256（本次仅抄录 manifest，未验证权重字节）：

| 包 | manifest 声明的 SHA-256 |
| --- | --- |
| 中英 KWS | `4ca3ae0d147df1576fac87a4837f5a8959f4f87600a8306c57cc67eb8b40494d` |
| 中文 KWS | `4eb04ad2acd24aee154a60e46e6ee2237c53a4f13798a2da32e5294afac88b43` |
| X-ASR INT8 | `3e1c128c7fdb00c18636a3e68889bd75e55bbf779a5a980a1d08b1ec1d098c2a` |

代码与模型分别记录：

- **Sherpaw 代码/包装层**：根 LICENSE 及四包 `license` 为 Apache-2.0；根 NOTICE 记录来自 Sherpa-ONNX 的文件。锁定的 `sherpa-onnx/upstream` 为 `917bed95c8e5c7c18aa4d69fea42e9ef8ef0a60e`，其 LICENSE 为 Apache-2.0。[S15]
- **所选 KWS、X-ASR 权重包**：上述固定 revision 的模型卡与 LICENSE 分开查阅，均声明 Apache-2.0；KWS 原模型归属链接来自打包方模型卡，本次没有独立审计训练语料或 ModelScope 全部历史版本。[S11][S12][S13]
- **VAD 权重**：包 README 推荐 Silero VAD v5 `silero_vad_v5.onnx`，约 2.3 MB，模型许可 MIT；Silero 官方 LICENSE 同为 MIT。16 kHz 必须配 `windowSize: 512`，README 警告其他窗口可能使 native/WASM 退出。准备脚本固定该导出的 SHA-256 为 `6b99cbfd39246b6706f98ec13c7c50c6b299181f2474fa05cbc8046acc274396`，本次未下载验证。不要用 Sherpaw 的 Apache 许可替代模型 MIT 记录。[S4][S16]

将来分发须保留相应 LICENSE、版权/归属与适用 NOTICE，记录模型 revision、源归档和散列；WASM 内第三方依赖的通知仍需随实际构建产物核对。本轮不是整个依赖树或训练数据权利审计，不能概括为所有 Sherpa 模型或所有 TTS 音色都适用同一许可。

## 4. Web Worker / WASM / 浏览器条件

1. **运行环境**：现代浏览器需支持 ES modules、module Worker、WebAssembly、Fetch、TypedArray；实时麦克风链路还需 `getUserMedia`、`AudioContext`、`AudioWorklet`。通过 localhost/HTTPS 提供页面；WASM 以正确 MIME `application/wasm` 提供以支持 streaming instantiate，Worker/模型资源 URL 必须可访问，跨源模型要符合 CORS，站点 CSP 要允许所选 Worker/WASM 加载方式。[S6][S17]
2. **先走 CPU/WASM**：KWS 默认已隔离 Worker，VAD/ASR 需额外薄 adapter；禁止把同步解码放在 UI 主线程或 AudioWorklet 实时回调。音频采集与推理解耦，传单声道 `Float32Array`（范围 [-1,1]），按模型要求归一为 16 kHz。实际设备采样率不能只靠约束猜测，复用现有 PCM 转换逻辑并测重采样。[S3][S6][S18]
3. **队列和结束语义**：KWS 默认 `maxPendingAudio=4`，调用方必须处理背压；Worker client 会复制再 transfer PCM/模型数据，不能按“零拷贝”估算。词表替换先建新 detector 再释放旧 detector，瞬时峰值也需测。调用 `reset/dispose`，停止麦克风、释放 native stream，丢弃过期会话结果；ASR final/endpoint 和 VAD 段结束要单独处理。[S6][S7]
4. **不是所有 Worker 都需要跨源隔离**：核查到的普通 CPU 构建未启用 `-pthread`，其发布 JS 未见 SharedArrayBuffer/pthread 依赖；不能一概把 COOP/COEP 当作当前单线程路径的硬条件。若另选 pthread/SharedArrayBuffer 运行时，Emscripten 文档要求正确 COOP/COEP；届时还要回归双窗口同步和跨源资产。不能凭配置里 `numThreads: 1` 推断任何其他二进制也满足同样条件。[S2][S19]
5. **bundler**：KWS README 明示 Vite 7 应 `optimizeDeps.exclude: ['@sherpaw/kws']`，称 Vite 8/Rspack 支持默认 Worker。它是上游使用说明，不是本项目 build 已通过的证明。应在实际 Vivic dev/prod 构建中验证 Worker chunk、WASM 路径、base URL 和错误恢复。[S6]
6. **Safari 与 Chrome**：均列为待测目标，记录真实版本；上游测试/sandbox 描述不能替代本机 Safari 麦克风、Worker、长时间推理和资源回收验证。WebGPU 可用性不作为第一阶段前提。[S10][S13]

## 5. 麦克风权限、前台边界与降级

麦克风必须经用户授权；在 Control 的用户手势中启用/恢复 AudioContext。拒绝、未作选择、撤销权限、设备拔出或占用都应可取消并保留文字输入。只申请麦克风，不申请屏幕录制、辅助功能或系统常驻权限；Display 不重复采集，也不承载设置。[S17]

**PoC 的产品边界是用户明确开启、前台 Control 页内监听**。浏览器可冻结/丢弃后台页面，Worker 不赋予后台常驻保证；关闭页签、锁屏、系统睡眠、切换后台都不能承诺继续唤醒。[S20] 本地 `apps/web/src/ai/voiceInput.ts` 目前在 `blur`、隐藏时取消正在申请/录音的采集，在 `pagehide` 取消整个语音输入。因而即使 Display 在另一屏仍可见，也不能宣称 Control 失焦后持续收音；后续 PoC 必须明确测试双窗口切焦，不能静默移除现有取消边界。

建议保持如下降级契约（待实现验证）：

| 情况 | 行为 |
| --- | --- |
| KWS 未加载、误触发率不合格或 Worker 失败 | 关闭自动唤醒，保留显式 PTT；未授权麦克风时直接用文字 |
| VAD 截断、始终检测为语音或段落超限 | 回到手动 PTT 收尾；保持最长 60 秒，丢弃无效段，不持续上传环境音 |
| StepFun ASR 未连接、权限/额度/网络失败，本地 ASR 也未就绪 | 明确语音不可用，保留文字；不自动切普通计费端点或其他 provider |
| 用户选择 GPT，未配置 STT/TTS | GPT 纯文字运行；选择了独立语音服务才使用它，不能自动借用另一账户的语音 |
| TTS 不可用或自动播放被阻止 | 保留卡片/文字操作结果；不能伪称“正在说话”或阻塞动作 |

只由当前 Control owner 管采集和会话；切换 LLM、停止监听、关闭窗口、切画布时要隔离旧转写。KWS/VAD 默认仅在本地处理，唤醒后有界命令段才可交现有云 ASR，并在 Control 说明数据去向。TTS 播放期间先抑制 KWS/采集或显式暂停监听，再测回声；VAD 会把电视人声当语音，不是“只听主人”的过滤器。[S4][S6]

## 6. 后续落地次序与验收

以下是后续独立 PoC 的计划，**不代表本次已获权重、已实现或已实测**。

### A. 先验证发布入口与最小运行条件

固定 npm `0.3.0` 及 registry `dist.integrity`、源码 SHA、模型 revision 和散列；检查实际安装的 CPU 资源、Worker 输出和 ASR 路径问题。先做无需模型的模块初始化/失败恢复 smoke test；模型下载必须由用户主动开启，给出大小、取消及缓存清理入口。下载后显式校验 manifest 散列，不能假设 preloader 会自动验证。按需加载，不能在 Display/Control 各预热一份模型。此步骤通过后才继续真实模型测试。

### B. 本地 KWS/VAD + 现有 StepFun Plan ASR

先单独测 KWS、VAD，再测串联。复用现有 AudioWorklet/PCM 采集，把 bounded PCM 分发给 Worker；测试有限预录缓冲避免吃掉唤醒后的首字，缓冲长度是待调参数。KWS 命中只进入听命令状态，VAD 完成命令段后，用既有 `encodeVoiceWav` 生成 16 kHz / mono / PCM16 WAV，走现有 `POST /api/transcribe`，不把 raw Float32 直接上传。[S18]

`apps/local-api/src/asr.ts` 已固定 `stepaudio-2.5-asr`，`asrAudio.ts` 限 60 秒；本轮只读确认此本地契约，不重做上游 StepFun 能力研究或实时调用。保留现有转写 review/发送策略，KWS 命中或 ASR 部分文字不得直接触发卡片动作。保留 PTT；测试误唤醒、漏检、长静音、TTS 回声和连续两条命令。不直接使用 `vad-asr` 替代云端 adapter，它会引入本地离线识别器。

### C. 通过资源门槛后，可选本地 ASR

单独测 169.23 MB X-ASR INT8 + CPU/WASM 流式识别，先从文件输入，再上真实麦克风。使用 `@sherpaw/asr` 的在线 Transducer 路径及专用 Worker；`vad-asr` 的离线识别作为另一实验，不能把两者接口混用。比较本地 ASR 与现有云 ASR 的转写、端点、耗时和资源，用同一批录音，不能拿厂商/上游吞吐替代结果。

评估识别期间暂时释放 KWS/VAD Worker、结束后重建的方案，或只保留实测可接受的实例；不要默认同时常驻所有运行时。若首载、中文准确率或系统资源不合格，继续使用 B/PTT/文字，不默认下载更大的 FP32，也不隐式启用 WebGPU。

### D. TTS 独立保留

沿用已有、明确配置的 TTS 或无 TTS 运行；未来本地 TTS 另开候选、音色/权重许可和浏览器 PoC。不得标注为“Sherpaw 自带 TTS”，不得把 LLM 连接成功等同于语音服务就绪。

### M1 / 8 GiB 性能必须实测

本机 M1/8 GiB 是目标环境，不是性能合格证明。`sherpa-onnx/HelperFunctions.cmake` 为各运行时设置 **`-sINITIAL_MEMORY=512MB`、`-sALLOW_MEMORY_GROWTH=1`**；这是源码构建配置，不能直接当作发布二进制实际 RSS。preloader FS、下载 ArrayBuffer、Worker 快照、native 模型/中间张量与多个 WASM 实例还可能同时存在。[S7][S21] 即使只有 13 MB KWS 权重，也不能承诺低占用；多个模块的初始线性内存更不能忽略。未在目标浏览器读取实际 memory/进程占用前，不给首载秒数、CPU%、RAM 或全天常驻保证。

| 必测项 | 记录方式与通过依据（全部待测） |
| --- | --- |
| 环境与加载 | M1、物理内存、macOS/浏览器版本、电源模式；冷缓存/热缓存分开；记录下载、WASM 编译、FS 装载、模型初始化到 ready 的分段时间与传输字节 |
| 系统占用 | 文本空闲、KWS、VAD、二者并用、唤醒后云 ASR、本地 ASR分别记录 CPU、浏览器及 Worker 所在进程峰值/稳态内存、memory pressure/swap；不能只看 JS heap |
| 实时性 | KWS 命中延迟、VAD 收尾、ASR 首字/final、队列积压与丢帧；流式吞吐/RTF 另记，不能用模型 480 ms chunk 代替全链路延迟 |
| 识别质量 | 固定中文命令及人工校对稿；安静/远场/噪声/音乐/电视人声/自身 TTS，统计漏检、误触发每小时、命令首尾截断；合成音与现场真人数据分开标记 |
| 生命周期 | Chrome/Safari 各测取消、下载失败、断网、权限撤销、切焦/隐藏/锁屏恢复、连续会话；确认停止后麦克风与 Worker 释放，旧转写不执行动作 |
| 与现有画布共存 | 在 Orb/Grainient/React Flow 与双窗口同时工作时记录帧率、长任务和资源；单独推理页面通过不能代表 Vivic 共存通过 |

每个阶段提交确切版本、原始数据、截图/录屏、可复现步骤及失败记录，再决定是否启用。尚未建立本机基线和验收预算，不在本报告虚构通过阈值或跑分。

## 7. 事实来源（原始项目、原始模型与浏览器官方文档）

- [S1] GitHub 原仓库 [main 提交 API](https://api.github.com/repos/moeru-ai/sherpaw/commits/main)、[固定 commit](https://github.com/moeru-ai/sherpaw/commit/2b12da09ab0cf45894e9565c386bf003cf44a106)、[完整递归 tree](https://api.github.com/repos/moeru-ai/sherpaw/git/trees/2b12da09ab0cf45894e9565c386bf003cf44a106?recursive=1)。
- [S2] [固定构建脚本：TTS/GPU 开关与 Emscripten 4.0.23](https://github.com/moeru-ai/sherpaw/blob/2b12da09ab0cf45894e9565c386bf003cf44a106/sherpa-onnx/build.sh)。
- [S3] [ASR 源码、package.json、README 与构建配置](https://github.com/moeru-ai/sherpaw/tree/2b12da09ab0cf45894e9565c386bf003cf44a106/packages/asr)。
- [S4] [VAD 源码及模型说明](https://github.com/moeru-ai/sherpaw/tree/2b12da09ab0cf45894e9565c386bf003cf44a106/packages/vad)。
- [S5] [VAD-ASR 源码及 README](https://github.com/moeru-ai/sherpaw/tree/2b12da09ab0cf45894e9565c386bf003cf44a106/packages/vad-asr)。
- [S6] [KWS README、types、Worker/client、spotter 与 keywords 源码](https://github.com/moeru-ai/sherpaw/tree/2b12da09ab0cf45894e9565c386bf003cf44a106/packages/kws)。
- [S7] [preloader 的 FS 数据装载实现](https://github.com/moeru-ai/sherpaw/blob/2b12da09ab0cf45894e9565c386bf003cf44a106/packages/preloader/src/index.ts)。
- [S8] npm registry 原始元数据：[asr](https://registry.npmjs.org/@sherpaw%2fasr)、[vad](https://registry.npmjs.org/@sherpaw%2fvad)、[vad-asr](https://registry.npmjs.org/@sherpaw%2fvad-asr)、[kws](https://registry.npmjs.org/@sherpaw%2fkws)、[preloader](https://registry.npmjs.org/@sherpaw%2fpreloader)。latest 为核查当日快照，复查应指定版本。
- [S9] 固定 npm 产物文件清单：[asr](https://unpkg.com/@sherpaw/asr@0.3.0/?meta)、[vad](https://unpkg.com/@sherpaw/vad@0.3.0/?meta)、[vad-asr](https://unpkg.com/@sherpaw/vad-asr@0.3.0/?meta)、[kws](https://unpkg.com/@sherpaw/kws@0.3.0/?meta)；已发布 [ASR 初始化 JS](https://unpkg.com/@sherpaw/asr@0.3.0/dist/index.js) 与 [package.json](https://unpkg.com/@sherpaw/asr@0.3.0/package.json)。
- [S10] [WebGPU 源码](https://github.com/moeru-ai/sherpaw/blob/2b12da09ab0cf45894e9565c386bf003cf44a106/packages/asr/src/webgpu.ts)、[按需复制 GPU 资产的构建配置](https://github.com/moeru-ai/sherpaw/blob/2b12da09ab0cf45894e9565c386bf003cf44a106/packages/asr/tsdown.config.ts)、[sandbox 后端选择](https://github.com/moeru-ai/sherpaw/blob/2b12da09ab0cf45894e9565c386bf003cf44a106/packages/sandbox/src/features/asr/load.ts)、[已发布 WebGPU JS](https://unpkg.com/@sherpaw/asr@0.3.0/dist/webgpu.js)。
- [S11] 中英 KWS 固定 HF 包：[模型卡/源归属](https://huggingface.co/moeru-ai/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20/blob/1770a4b22db32184c110ac43c601db17cc9c93f8/README.md)、[manifest](https://huggingface.co/moeru-ai/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20/blob/1770a4b22db32184c110ac43c601db17cc9c93f8/manifest.json)、[大小 metadata](https://huggingface.co/moeru-ai/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20/blob/1770a4b22db32184c110ac43c601db17cc9c93f8/install/bin/wasm/preload.js.metadata)、[LICENSE](https://huggingface.co/moeru-ai/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20/blob/1770a4b22db32184c110ac43c601db17cc9c93f8/LICENSE)。
- [S12] 中文 KWS 固定 HF 包：[模型卡/源归属](https://huggingface.co/moeru-ai/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01/blob/9b3856fe1cb0c5a460b68303ef2645bcbcfbc021/README.md)、[manifest](https://huggingface.co/moeru-ai/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01/blob/9b3856fe1cb0c5a460b68303ef2645bcbcfbc021/manifest.json)、[大小 metadata](https://huggingface.co/moeru-ai/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01/blob/9b3856fe1cb0c5a460b68303ef2645bcbcfbc021/install/bin/wasm/preload.js.metadata)、[LICENSE](https://huggingface.co/moeru-ai/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01/blob/9b3856fe1cb0c5a460b68303ef2645bcbcfbc021/LICENSE)。
- [S13] X-ASR INT8 固定 HF 包：[模型卡](https://huggingface.co/moeru-ai/sherpaw-x-asr-zh-en-480ms-int8/blob/d9ab70a45493b97ae76e08574fcbc5ad0c5d0039/README.md)、[manifest/源归档及散列](https://huggingface.co/moeru-ai/sherpaw-x-asr-zh-en-480ms-int8/blob/d9ab70a45493b97ae76e08574fcbc5ad0c5d0039/manifest.json)、[大小 metadata](https://huggingface.co/moeru-ai/sherpaw-x-asr-zh-en-480ms-int8/blob/d9ab70a45493b97ae76e08574fcbc5ad0c5d0039/install/bin/wasm/preload.js.metadata)、[LICENSE](https://huggingface.co/moeru-ai/sherpaw-x-asr-zh-en-480ms-int8/blob/d9ab70a45493b97ae76e08574fcbc5ad0c5d0039/LICENSE)；[原作者模型卡](https://huggingface.co/GilgameshWind/X-ASR-zh-en/blob/main/README.md)。
- [S14] [ASR catalog](https://github.com/moeru-ai/sherpaw/blob/2b12da09ab0cf45894e9565c386bf003cf44a106/models/asr-catalog.json)、[X-ASR 打包研究](https://github.com/moeru-ai/sherpaw/blob/2b12da09ab0cf45894e9565c386bf003cf44a106/docs/research/x-asr-model-packaging.md)、[HF submodule URL](https://github.com/moeru-ai/sherpaw/blob/2b12da09ab0cf45894e9565c386bf003cf44a106/.gitmodules)。
- [S15] [Sherpaw LICENSE](https://github.com/moeru-ai/sherpaw/blob/2b12da09ab0cf45894e9565c386bf003cf44a106/LICENSE)、[NOTICE](https://github.com/moeru-ai/sherpaw/blob/2b12da09ab0cf45894e9565c386bf003cf44a106/NOTICE)、[锁定 Sherpa-ONNX 的 LICENSE](https://github.com/k2-fsa/sherpa-onnx/blob/917bed95c8e5c7c18aa4d69fea42e9ef8ef0a60e/LICENSE)。
- [S16] [Silero 官方 MIT LICENSE](https://github.com/snakers4/silero-vad/blob/master/LICENSE)、[Sherpaw 固定 VAD 导出来源/散列的准备脚本](https://github.com/moeru-ai/sherpaw/blob/2b12da09ab0cf45894e9565c386bf003cf44a106/packages/vad-asr/tests/scripts/prepare-models.sh)。
- [S17] MDN：[getUserMedia 安全上下文/权限](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)、[Web Audio 用户手势与自动播放](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Best_practices)、[WASM streaming 的 MIME/CSP 条件](https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/instantiateStreaming_static)。
- [S18] 本地只读依据：[现有 ASR 文档](stepfun-asr.md)、[音频采集](../apps/web/src/ai/voiceInput.ts)、[PCM/WAV 编码](../apps/web/src/ai/pcm.ts)、[ASR 路由](../apps/local-api/src/asr.ts)、[WAV 限制](../apps/local-api/src/asrAudio.ts)。本轮未重跑它们的历史验证。
- [S19] [Emscripten pthreads 对 SharedArrayBuffer/COOP/COEP 的要求](https://emscripten.org/docs/porting/pthreads.html)。
- [S20] [Chrome 官方 Page Lifecycle：hidden/frozen/discarded](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)。
- [S21] [WASM 初始内存与增长配置](https://github.com/moeru-ai/sherpaw/blob/2b12da09ab0cf45894e9565c386bf003cf44a106/sherpa-onnx/HelperFunctions.cmake)。
