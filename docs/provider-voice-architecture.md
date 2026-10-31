# 两种模型连接与独立语音能力

更新：2026-10-15。依据本地源码、固定安装包和已归档证据，仅提供 **StepFun Coding Plan** 与 **GPT（Pi OAuth）** 两种 LLM。历史研究中的「GPT 尚未接入」「Sherpaw 仅计划」不再是当前状态；已实现不等于所有设备、账号和交互均通过验收。

同日语音细节增量见 [voice-feedback](voice-feedback.md)：固定预录短句、词级字幕及实际 PCM 包络接入已实现；下文的原运行证据仍保留，不扩写为新增接口的账户实测。

## 能力与验证

| 能力 | 当前实现 | 证据与限制 |
| --- | --- | --- |
| StepFun 规划 | Plan Key、目录+短推理连接校验、结构化动作、多事项提醒 | [Plan 说明](stepfun-plan-tts.md)、[语音输入验收](../evidence/phase2-voice-input/REPORT.md)保留历史真实请求；Key 只在后端内存 |
| GPT 规划 | Pi 1.2.0 OAuth/provider、既有登录及 refresh，新登录入口 | [GPT live](../evidence/phase3-gpt/live.json)：真实 `gpt-6-luna` 推理、多事项提醒；动作仅检查未派发。新 OAuth 完整交互未实测 |
| 搜索 | StepFun StepSearch；GPT OAuth Responses `web_search` | [StepSearch](../evidence/phase2-stepsearch/REPORT.md)、[GPT live](../evidence/phase3-gpt/live.json)、[浏览器 live](../evidence/phase3-live-browser/live.json)；真实来源不等于全文已读 |
| 视觉 | 当次附件、Sharp 完整解码、当前模型能力检查 | 浏览器 GPT 从自生成 TEST 图片得到 `17 + 26 = 43` 并创建便笺；未使用用户图片，不代表任意图片或模型均验收 |
| ASR | 独立选关闭、StepFun Plan、本地 Sherpaw X-ASR | 云端有合成麦克风真实请求；本地有合成 WAV/虚拟 AudioWorklet 真实 WASM；物理麦克风未验收 |
| TTS | 独立选关闭、StepFun Plan、浏览器 `localService` 音色 | 云端有历史接口/播放记录；浏览器音色仅模拟事件测试，无实际发声验收；最新测试静音/TTS 关闭 |
| VAD/KWS | Sherpaw Worker、默认下载并缓存、前台单句，默认不开麦；唤醒词 `vivic` | [本地语音归档](../evidence/phase3-local-speech/REPORT.md)是旧版实测；`vivic` 的实际词表已核对，真人唤醒率仍待验收 |

STT/TTS 不依附所选 LLM。可以使用 GPT 加独立 StepFun 语音、本地 ASR，或纯文字；未配置音频不阻塞模型连接。LLM、搜索、视觉、ASR 和 TTS 分别验证，不能从 OAuth 成功推导语音权限，也不因换 LLM 擅自切换语音 provider。

## Pi OAuth 与隔离

实际安装 `@earendil-works/pi-ai@1.2.0`、`@earendil-works/pi-coding-agent@1.2.0`，MIT，Node >=22.19.0。来源与迁移见 [本地 provenance](../apps/local-api/src/gpt/PROVENANCE.md)。复用上游模型/provider、OAuth 和凭据存储，不重写认证协议。

仅注册 `openai` / `openai-codex`，没有 agent session、coding tools、MCP dispatcher、宿主 extensions/skills 或任意模型配置加载。固定包的 AuthStorage 单独加载实现模块，避免导入 CLI/session/tool registry；不能误写成发行包根入口公开重导出。

- 新 OAuth 使用上游 `openai` / Sign in with ChatGPT，公共 Responses；legacy `openai-codex` 凭据保持对应路由，不混用 token/端点。
- 复用 Pi 时在原受控存储内刷新，不复制 refresh token；断开 Vivic 不注销 Pi CLI。自有登录使用 `~/.vivic/auth.json` 和独立 device id。凭据不进入浏览器、prompt、Display 或导出。
- 真实证据覆盖既有 Pi OAuth 的连接/刷新、推理和搜索；新授权页、回调及手动回调输入已实现，但未完成真实交互验收。
- GPT 搜索迁移固定 `pi-web-access@0.41.0` 的受限 Responses 调用与 citation 提取，MIT 全文保留。snippet 可能来自带引用回答附近文本，不冒称网页逐字摘录。

GPT 订阅登录不当作通用 OpenAI API Key 或 STT/TTS 授权。固定官方地址、拒绝重定向、响应/期限限制和取消/断开代次检查保留。当前实测账号成功，不代表所有账号或未来套餐政策。

## StepFun、搜索与网页读取

StepFun 推理默认 `https://api.stepfun.com/step_plan/v1`，目录和短推理均通过后保存内存 Key。Plan ASR/TTS 独立使用 `stepaudio-2.5-asr` / `stepaudio-2.5-tts`，不向语音模型发送规划请求，不静默转普通按量路径。

StepSearch 固定 `https://api.stepfun.com/step_plan/v1/mcp/web_search/mcp`，复用 Plan Key，调用实测 `web_search(query,n)`；使用服务端遵循的 MCP `2024-11-05`，未知版本 fail closed。工具和浏览器来源卡已有真实成功记录。

**搜索回退链（2026-10-16 起，见 [search-fallback](search-fallback-20261016.md)）：** 依次尝试所选模型的搜索（GPT 仅在已连接时）、另一条已连接的搜索、最后无凭据公共搜索（Exa）；任一路返回来源即止，空结果继续下一路。改用非所选路径时结果提示会写明「X 不可用，已改用 Y」，不静默切换；调用方取消或模型连接变更立即终止，不再回退。无凭据搜索只发送查询，不带任何 Key。

GPT/StepFun 搜索保留真实标题/URL、时间和 provider，来源文本作为非可信数据；空摘要不补造。无凭据 Exa 子集仍受 fake-IP DNS/免费额度影响。任意 `/fetch` 保持 DNS **全部地址**验证、每跳校验与 socket pin；本机 fake-IP 拒绝仍是限制，不能为搜索可用而放宽通用 SSRF。搜索成功不证明全文提取、模型比较或来源可靠性自动验收。

## 本地语音与前台生命周期

已安装 `@sherpaw/{asr,kws,vad,preloader}@0.3.0`。2026-10-21 起，可写控制窗口默认逐个下载缺失的三个固定模型，完整 SHA-256 后进入专用 IndexedDB；已缓存模型复用，只读窗口不下载。取消不提交部分缓存，清理会停止自动准备，损坏不标假 ready。模型 revision/散列/许可见 [manifest](../apps/web/src/ai/localSpeech/manifest.json)、[LICENSES](../LICENSES.md)。

X-ASR/KWS/Silero VAD 在 Worker 运行。捕获命令后先终止监听 Worker，再启动本地 ASR；选择云识别时仅把有界命令段交给独立 StepFun ASR。设置组件挂载会准备模型，前台可写控制窗口会请求位置和麦克风权限。麦克风已授权时只检查状态；需要请求时获授权即停止临时轨道，不启动录音、转写或上传，实际监听需手动开启。用户每次点击最多前台等待 300 秒，单段最长 60 秒，成功/失败后结束，不自动循环。失焦、隐藏、pagehide、取消、切画布/owner/provider 或 TTS 状态变化会停止、清理并丢弃迟到结果。

本地 ASR 文件结果约 7.40 秒，VAD→ASR 4.48 秒，虚拟 AudioWorklet→重采样→VAD→ASR 11.17 秒（含实时音源等待），均是合成音，不是物理麦克风或整页 GPU 场景性能保证。ASR/KWS 浏览器下载用已验证文件经 loopback 提供，不能称该耗时为公网速度；VAD 固定 HF URL 有真实 CORS/校验记录。

当前默认唤醒词 `vivic` 未做真人声学命中、召回率或误唤醒率验收；历史真实 KWS 命中的是「十分钟」。物理麦克风、Safari、5 分钟监听、锁屏/睡眠唤醒仍待验收。识别结果默认自动发送，用户可关闭后检查文字；PTT/文字保留为显式降级，不自动换云服务。详见 [local-speech](local-speech.md)。

## 独立 TTS 与测试约束

StepFun TTS 默认关闭，用户显式开启后才请求；浏览器 TTS 同样默认关闭，只选 `localService` 音色，用真实 `onstart`/`onboundary` 驱动状态，取消/失败清理。`localService` 是浏览器/系统声明，不等于已验证断网可用或实际听感。Sherpaw 当前包没有因此获得 TTS 能力。

**最新测试静音、TTS 关闭，旧的一次发声授权不视为持续授权。** GPT/真实浏览器记录没有播放音频，本地 TTS 只做模拟事件测试。声音不可用或播放被阻止时继续卡片/字幕和文字，不显示虚假的“正在说话”。

## 数据、图片与剩余验收

七卡 renderer 已接通。天气由 Open-Meteo/GeoNames adapter 提供，明确模型有效时间；最简温度/图标整体提供来源链接，Radix HoverCard 按需显示 Open-Meteo、GeoNames、CC BY 4.0 及字段/图标转换说明，默认不加 footer。表格/图表只接受用户数值或现有 ctx 数据转换，保留 provenance，混合破坏性操作澄清。模型不能直接补造 Weather/Table/Chart。图片仅作为当次视觉附件，Sharp 有界完整解码，失败/无视觉能力即拒绝，不丢图后冒充视觉回答。见 [data-providers](data-providers.md)、[data-cards](data-cards.md)、[image-input](image-input.md)。

拖动/Pin、主题和减少动效已实现，Display 交互由 owner 校验并落盘确认。最新[真实浏览器记录](../evidence/phase3-live-browser/live.json)5/5 通过，7 卡在刷新前后 `overlaps: []`；[Chromium 全套](../evidence/phase3-final/chromium.json)58/58、约 4.5 分钟通过。此处无重叠结论限于已测场景。[稳定性审计](../evidence/phase3-stability/final-resource-audit.json)仍保留旧快照约 30 分钟 23/24、新快照 14/14 专项且 soak 约 61 秒的区别；全套浏览器通过不替代新版完整 30 分钟验收。

Laya 当前组合 **NO_GO / MODEL_OR_ADAPTER_UNCERTAIN**；Winnow **BLOCKED**，未下载/运行或生产接入。Google/Claude/Grok 等不在本轮两 LLM 范围。本次仅据本地资料更新文档，没有新建服务、模型测试、浏览器会话、麦克风或音频输出。
