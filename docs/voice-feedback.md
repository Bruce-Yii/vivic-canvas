# 语音反馈增量：预录短句、词级字幕和振幅

2026-10-15，分支 `agent/next-iteration`。在现有语音链路上补齐原计划细节，继续保留默认关闭 TTS、独立语音选择、单 owner 播放和极简 Display。

## 当前行为

- 请求超过 300ms 且用户已开启语音反馈时，用内置「我看看」作一次短反馈；超过 5 秒可用一次「稍等」。短句结束后恢复原思考状态；结果返回、取消、新请求、切画布、失去控制权和页面离开都会停止对应短句。快速规则请求不必先播一声。
- 「我看看」「稍等」「好的」只有三个固定文件；共 19,911 字节 MP3。任意用户内容仍走所选语音服务。没有后台生成器、新语音 provider 或音色克隆。未连接云服务时可单独使用预录短句；选择「仅卡片与字幕」或关闭语音时不请求/播放音频。试听仍使用所选服务，不能拿固定音色冒充用户选中的音色。
- StepFun 的「请求逐词字幕」为可选项，默认关闭以保留原有整句语音请求；账户确认支持后可开启。只对与实际请求文字精确对齐的范围高亮。归一化改写、缺失、重叠、逆序、越界或无效时间戳退回整句字幕，不按字数猜时间。长句分段显示时，词间停顿保持当前段落。若服务拒绝时间戳请求，关闭此项即可恢复普通语音，不自动重试消耗额度。
- 浏览器本地声音通过真实 `onstart` / `onboundary` 事件驱动；没有有效边界时不显示猜测高亮。系统声音的 PCM 不可读取，振幅保持零。
- 预录音和 StepFun 音频由 `OfflineAudioContext` 解码后测量 PCM RMS 包络，按媒体 `currentTime` 与用户音量取样，传给批准的 SmoothUI Siri Orb 的 `amplitude` 公开属性。此解码不创建扬声器图，也不请求麦克风；失败/超时只关闭振幅反馈。缓冲、暂停、结束、取消时清零，减少动效时 Orb 不响应振幅。
- Control 只广播当前字词范围与 0–1 振幅；约 10Hz/媒体事件更新，Display 不播放音频。原始音频、完整词轴和播放开关不进入画布、导出或浏览器偏好存储。

## StepFun 契约与边界

核对官方 [语音合成文档](https://platform.stepfun.com/docs/zh/api-reference/audio/create-audio) 及其同路径 `.md` 公开正文：`timestamp=true` 需要 `return_url=true` 或 `stream_format="sse"`。本项目选择 SSE，同一个固定 Plan 请求返回音频与 `response.subtitle`，不抓取任何上游返回的下载 URL。

本地 `POST /api/speech` 新增可选 `timestamps: boolean`。省略时继续返回原有 `audio/mpeg`；为 true 时请求固定 `stepaudio-2.5-tts`、`timestamp=true`、`stream_format="sse"`，完整校验后返回 `{audioBase64, words}`，其中 word 为 `{startMs, endMs, charStart, charEnd}`，字符索引使用 UTF-16。若上游返回有效裸音频，词轴为空。不会新增付费路径、模型回退、重试或下载 URL 请求。

SSE 响应正文最多 8MiB、解码音频最多 4MiB、最多 400 个词，时间范围最多 120 秒。必须收到音频完成事件和 `[DONE]`；截断、错误事件、非法 Base64、超限或取消均不播放部分音频。前端 JSON 正文最多 6MiB。读 body 期间继续受取消/时限约束，错误只用静态说明，不回显上游正文或凭据。

## 素材来源

[素材来源与固定 revision](../apps/web/public/voice-feedback/PROVENANCE.md)、[文件散列](../apps/web/public/voice-feedback/manifest.json)、[模型 Apache-2.0 许可全文](../apps/web/public/voice-feedback/MODEL-LICENSE.txt) 已提交。使用 Kokoro-82M-v1.1-zh 固定 ONNX 版本，独立 Python 工具离线生成三个自编短句，经 FFmpeg 输出 24kHz 单声道 MP3；没有克隆用户或具名个人的音色。工具、权重及字典留在忽略的 `.cache/`，不是应用依赖，不会由浏览器下载。

可用 `scripts/generate-short-feedback.py` 在固定工具环境重新生成；脚本检查权重散列，只输出文件，不播放。自动检查证明文件非空、散列一致、浏览器可静默解码并取得实际非零包络，不等于已经验收音质或发音听感。

## 验证与待验收

单元测试使用离线网络/播放器替身，覆盖真实格式的分片 SSE、错位时间戳降级、完整性、字节限制、取消、PCM 取样、音量、长字幕和素材散列。浏览器只用独立 context、5174/8788；所有播放与系统合成替换为静音替身，实际 PCM 解码保持离线，不采集物理麦克风。时间戳测试数据明确为 TEST，不是用户账户的实际 StepFun 返回。

当前仍待用户允许发声后的音质/音色/声画同步听感，以及真实 StepFun Plan 账户的时间戳权限和响应验收；未为此次测试索取 Key 或发起新 OAuth。本人唤醒词、物理 Safari、外接屏和最终长期性能基线依旧待验收，不能从本轮自动化推导成功。

最后检查：Web 329、API 819 项单测通过，另 3 项外部测试跳过；`pnpm typecheck` / `pnpm build` 通过。Chromium 15/15（语音、原等待/取消、天气/表格与清除回归）；Firefox/WebKit 新增语音专项各 3/3，分别运行。原有 Sherpaw 构建提示、包体积和 React Flow 归属提示仍存在，本轮没有把所有日志称为零告警。

[可移植记录](verification/voice-feedback.json)纳入 Git；实际截图/录像位于本机 `evidence/voice-feedback/`，不提交媒体证据。新增截图已目视检查，字幕只高亮当前词，继续使用原 SmoothUI Orb。语音和“请求逐词字幕”默认均关闭；更新后刷新两个页面即可载入，勿把真实听音验收和静音替身测试混为一谈。
