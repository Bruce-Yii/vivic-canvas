# StartLux 托管运行与本地语音

2026-10-23。本轮继续 Windows / Mac 可选启动器，界面沿用 library Hark `26ac2724` 的字体、SVG、天空、连续圆角和透明材质。线上使用 API 仍无需安装启动器；手机仍只承担远控两页。

## 现在能做什么

- 启动器按可用内存建议 StartLux 0.8B / 2B / 4B，4B 为首选，9B 只供手动选择。模型切换要求当前运行已停止，推荐是保守内存估算，不能代表实测速度或质量。
- 「准备模型」现在准备真正的 StartLux Instant，包括固定 GGUF、BF16 仓库的 tokenizer / config / decision_config / LICENSE、官方 readout 源码和独立 Python 环境。没有把 Qwen 改名；旧 Qwen 实现保留以兼容既有验证。
- 「启动模型」先核验文件，再启动 API 专属 guardian 管理的 llama-server 和官方 Python Decider。模型健康、双向 readout 预热成功之后才显示就绪。取消、停止和 API 退出均回收本次拥有的进程；不会按名字批量终止其他服务。
- 新增本地动态 TTS：Sherpa-ONNX 1.12.32 + Kokoro v1.1 中文女声 speaker 3，可生成任意受限短句的 24 kHz 单声道 PCM16 WAV。它与 StepFun 温柔女声是不同音色。现有 Sherpaw ASR / KWS / VAD 和 StepFun 预生成声音保留。
- 音色默认不准备、不加载；在更多语音选项选择「本地 Sherpa-ONNX」后准备并启动。开启语音回复仍由用户操作，选本地失败保留文字，不静默转成云端付费合成。启动器也提供折叠的本地语音管理入口。

## 固定来源与准备

StartLux 模型继续使用 [原固定清单](../research/startlux-profiles.md)。官方推理源码固定 [`83fe6c7d61a687a6e17f118b4f7d8f429f5d3a01`](https://github.com/StartLuxLabs/StartLux-Decision/tree/83fe6c7d61a687a6e17f118b4f7d8f429f5d3a01)，来源压缩档有 SHA256，解压仅保留推理 Python、README 和许可，不提取无关演示媒体。该包不在本次核查的 PyPI 1.1.0 入口发布，运行时直接复用已核验源码，通过私有 PYTHONPATH 调用。

上游文档测试版本 b11549 没有可用 release 二进制；本轮选择固定官方 [b11550](https://github.com/ggml-org/llama.cpp/releases/tag/b11550) Windows CPU / Mac arm64 / Mac x64 工件，逐个实际下载核验 bytes / SHA256。Windows 0.8B 的真实验证见验收记录，不能将其推断为 Mac 或 4B 已实测。完整 prompt 单 micro-batch、parallel=1、ctx-checkpoints=0，读取非 causal GGUF，官方 `STARTLUX_LLAMACPP_BIDIR=server`；未走普通聊天协议。

环境固定 uv 0.12.24、CPython 3.12.15、transformers 5.8.0、Jinja2 3.1.6、numpy 2.3.3、Sherpa-ONNX 1.12.32，全部 Python 依赖及平台 wheels 由通用哈希锁校验。uv 安装 Python 使用 `--no-bin --no-registry`，只写本运行目录，拒绝系统配置继承；子进程只传必要系统环境，不传模型服务密钥。Sherpa `core` 仅 Windows 另装，Mac 使用自身 wheel，不强装不存在的 Mac core wheel。

Kokoro 来源 [`csukuangfj/kokoro-multi-lang-v1_1@914313412b607d95400bcd12446233fbd1248801`](https://huggingface.co/csukuangfj/kokoro-multi-lang-v1_1/tree/914313412b607d95400bcd12446233fbd1248801)，365 个完整必要文件及许可逐文件固定大小 / SHA256，399,793,616 bytes。模型 Apache-2.0；内含 eSpeak 数据按 GPL-3.0-or-later 记录并提供 COPYING / 来源，不将整个包统一标为 Apache。模型下载到用户本机缓存，Windows 安装包不捆绑权重。

下载进度中的模型/引擎数量不包括首次独立 Python/wheel 准备。0.8B 模型、metadata、引擎和上游源码合计约 672 MB；TTS 约 400 MB，首次各自环境还需额外网络与空间。2B / 4B 使用同一准备流程，未为本轮盲下全部大权重。

## 平台、安装与自动验收

Windows 新包支持原 Install / Start / Stop 入口；停止器识别三种本包 guardian，包括 StartLux 与 TTS。Mac 安装和打包仍在对应架构 Mac 上执行，安装器不覆盖旧 App，不绕过系统安全许可。用户已明确本轮没有可用 Mac，实际 Mac 安装 / 推理按其选择延后。

Windows 最终安装包内的 `LICENSES.md` 已同步本轮按需下载的模型、Python 工具与语音依赖清单；最终封包前将安装烟测产生的日志移入独立验收证据，不分发运行状态。

可复现原生模型验收：

```sh
node scripts/verify-local-runtime.mjs --tts
```

默认使用隔离 `.cache/local-runtime-smoke-<platform>-<arch>`，固定下载小档 StartLux，真正启动和 readout，合成两条不同 WAV 到文件，停止并记录 `verification.json`；不采集物理麦克风、不播放、不打开用户画布。已有 `.github/workflows/package-macos.yml` 手动工作流新增可选 `verify_models`，分别在 arm64 / Intel runner 构建安装包、跑安装 API smoke，再可选做真实模型/语音验收。本轮没有提交、运行 CI 或发布。

## 接口与接线

- 本机 `POST /api/decision/profile` 选择四档 `profileId`；已有 status / prepare / enable / stop / clear 接口保持。
- 本机 `GET /api/local-tts/status`、`POST /api/local-tts/{prepare,enable,stop,clear}`。
- `POST /api/local-tts/synthesize` 只收 `{text,speed?}`，1–200 可见字符、0.5–2 倍速；最多 45 秒/2,160,044 bytes，返 `audio/wav` 和 `no-store`，两端校验 RIFF/PCM 参数，不生成伪词级时间戳。用户取消会终止计算并释放 worker，需要重新启动后继续。
- 在线模式不创建/访问本地运行环境，也不接受上述本地端点；浏览器持久偏好中的本地声音在 online build 映射回云提供方，不自动开启反馈。

## 验证和保留边界

Windows 原生 0.8B 准备、启动、真实 readout、停止、离线热启、损坏拒绝和取消均已执行。动态 TTS 已实际生成多条不同 WAV、经过真实 API、校验采样和非静音、取消并恢复；未播放或评价主观听感。真实运行与测试数据在 [验收记录](../verification/local-runtime-next-20261023.md)。

4B 大权重运行、目标 Mac 实机、联合压力/速度与用户听感验收尚未完成。微调由主任务的独立训练流水线负责，托管启动器仍加载上游基线权重，不会未经评估切成训练候选。StartLux 代码 Apache-2.0 与权重 CC BY-NC 4.0 分开记录；后续定制权重需保留原许可和归属。
