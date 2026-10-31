# 本地 StartLux / TTS 验收

2026-10-23。源码与行为见 [更新说明](../updates/2026-10-23-local-runtime-next.md)。本轮不发布、不推送，不覆盖用户现有安装；18787 / 18794 服务保持。

## 原生 Windows

本机 Windows x64、约 32 GB RAM、RTX 3060 12 GB；本轮托管推理及 TTS 使用 CPU，不占用训练 GPU。C 盘检查余约 405 GB 后才选择小档下载。StartLux 4B / 2B / 9B 没有为验收额外下载。

1. 固定 0.8B GGUF 529,296,992 bytes 与上游清单 SHA256 一致。tokenizer / config / decision_config / LICENSE 的四档小元数据已全部取得核验；b11550 三平台压缩档、uv 三平台压缩档真实下载核对。Mac Mach-O 未在 Windows 执行。
2. `ManagedStartluxRuntime` 使用准备好的已验权重/源码缓存，自动新建私有 uv / CPython / venv 并按 hashes 安装依赖，经过 prepare → cached → loading → ready → stopping → cached。没有加载 Qwen 代替。
3. 四条真实 readout（官方 Decider + Instant 双向全 prompt，CPU）分别约 0.93–1.32 秒。「展开这张便笺」接受 expand，概率 0.99036；「显示所有卡片」「不要删除卡片」「聚焦旅行计划」因现有置信/语义门控回退。否定删除的错误候选没有变成允许执行的 Action。小样本只证明真实协议和保守回退，不是准确率评估或 4B 性能保证。
4. 禁止外网 fetch 后，已缓存模型仍能启动和 readout；推理进行中取消会停止计算，之后重新启动成功。篡改 decision_config 为 `{}` 后拒绝启动；恢复原文件再使用。准备阶段取消后返回 absent，临时文件不成为已安装文件。

证据：`.cache/local-runtime-next/startlux-real-evidence.json`、`recovery-evidence.json`。

## 动态本地语音

- 官方 Kokoro 模型与必要配套 365 个文件、399,793,616 bytes 已逐一核对，实际 Sherpa-ONNX worker 成功加载。
- 两条不同中文内容生成 WAV：170,128 bytes / 3.5434 秒、163,110 bytes / 3.3972 秒；均 24 kHz 单声道 PCM16，样本有限、非静音且文件哈希不同。没有音频设备输出。
- 禁止外网后，经真实 `createApp` 的 `/api/local-tts/synthesize` 再生成 129,830 bytes / 2.7039 秒 WAV；响应 MIME / no-store 和两端 RIFF 校验有效。
- 真实长句合成中取消，worker/guardian 完整退出，随后重新启动并生成 113,302 bytes WAV；取消和重启全过程约 5.1 秒。多个下载同时取消时等待全部请求 settled，临时 `.part` 文件数 0。
- 自动化未采集麦克风、未播放。发音自然度、音色听感、长文本边界/实际输出设备的主观体验尚未验收。

证据：`.cache/local-runtime-next/tts-real-evidence.json`、`tts-abort-real-evidence.json`、`tts-cancel-evidence.json`、`local-tts-{0,1,api}.wav`。

## UI 与接口回归

- 最后本地定向 API **7 files / 45 tests passed**：新运行包固定源/密钥环境隔离、metadata/TTS manifest、source archive 路径边界、profile忙碌拒绝/取消、WAV校验/本地路由、online拒绝、旧runtime/platform/provider回归。
- Web 定向 **3 files / 20 tests passed**：本地 WAV transport / 错误无云fallback、launcher状态竞态、决策设置。
- API / Web TypeScript 类型检查通过。新增文件定向 oxlint 无错误，保留 React effect cleanup ref 建议；构建仍有已有 Sherpaw WASM / 外置模块与chunk大小提示，未称零warning。
- Hark 原生资产桌面、390 px、深色/减少动效截图共5张实际查看；浏览器通过真实 `/api/decision/profile` 选择档位，启动到模型已就绪、停止回cached，无横向溢出、无页面error，麦克风调用/播放调用均为0。任务浏览器已关闭，18801临时服务已停止。

证据：`.cache/local-runtime-next/browser/{01-launcher-desktop,02-launcher-local-voice,03-real-model-ready,04-launcher-narrow,05-launcher-dark}.png`、`browser/result.json`。测试生产Web build，本地视图独立origin；未访问用户画布。

## 安装包及 Mac 恢复入口

- Windows新ZIP源于本机锁定依赖的生产构建/部署，内含新 `.py` worker、固定manifest/hash lock；不含模型、私有Python、API凭据或个人缓存。
- 包内 Node + Start-Vivic.ps1 实际在独立18803启动；health/launcher 200、四档清单、选择0.8B、缓存准备、真实模型预热就绪通过。Stop-Vivic.ps1捕获并等待新的StartLux guardian，最终18803关闭、`.launcher.json`不存在。验收后没有把运行过的stage重新发成干净包。
- Windows包截图/说明/最终SHA随交付目录提供，具体包校验见交付 `SHA256SUMS.txt`。
- Mac arm64 / x64 的Python依赖分别做 `uv pip compile --python-platform ... --only-binary :all:` 解析通过；Mac JS语法、Windows停止脚本语法、手动CI YAML双架构和可选模型输入检查通过。
- **用户明确暂时没有可用Mac**，本轮按其选择交付安装/自动验收流程，不将Mac缺机当本轮阻塞，也不声称Mac已运行。运行 `node scripts/verify-local-runtime.mjs --tts` 可在目标原生Mac生成实际证据；GitHub workflow支持同样检查，但本轮未推送或触发CI。

公开验证脚本在本机也已真实执行，`verification.json.passed=true`：`.cache/local-runtime-next/managed/verification.json`。它生成两条不同WAV、执行真实readout并停止，无麦克风/播放。

## 未包含的结论

未将本轮原生0.8B smoke说成4B微调、4B推理性能或商业权重许可已完成。主任务另有实际小档训练与留出评测记录；启动器保持上游基线，训练候选未经评估不会自动替换。未做Mac实机、联合长时内存/CPU压力、用户听感、签名公证或正式DMG/PKG验收。
