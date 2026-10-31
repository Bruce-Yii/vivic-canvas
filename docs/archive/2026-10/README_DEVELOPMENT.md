> 历史归档：原路径 `README_DEVELOPMENT.md`。记录当时的需求与验证，不作为当前操作指令。当前入口：[README_FIRST](../../../README_FIRST.md)。

# Vivic v0.6 — 双页面信息画布

> 2026-10-19：当前开发入口是 [贡献指南](../../../CONTRIBUTING.md) 和 [本地开发路线](../../LOCAL_ROADMAP.md)。下文保留早期运行记录；最新产品有用户页 `/`、设置 `/control`、展示 `/display` 和 20 种场景，具体实现以源码与最新交接为准。当前先完成本地功能，再讨论部署和账号。

当前入口：**[http://localhost:5175/control](http://localhost:5175/control)**。5173 当前由其他项目占用；Vivic 固定使用 5175，端口冲突时明确报错，不自动换端口。详见 [入口修正](entry-port-20261016.md)。

自然语言驱动的极简信息画布，Web First 个人版 MVP。当前已实现 **StepFun Coding Plan / GPT 两种 LLM、独立语音、七类卡片、真实天气/搜索、数值图表/转换、当次图片、拖动/固定、事项提醒、子卡片、长文详情与中文/拼音找卡**。用户参与的新 GPT 授权已于 2026-10-16 完成；本人语音/设备与本轮完整手测仍待逐项验收。

现在先看 [一期收尾与本轮检查](finalization-20261016.md)，从 [完整测试清单第 0 组](../../FINAL_ACCEPTANCE_CHECKLIST.md) 开始。128 项人工操作和 9 项技术检查分组进行，先修反馈，再逐条讨论 [二期候选](PHASE2_CANDIDATES.md)，不同时加入部署/多用户/手机/新卡片功能。

一个 Web 应用两条路由：`/control` 是唯一写入端，`/display` 是只读舞台。两窗口通过 BroadcastChannel snapshot/patch 同步，多画布使用 IndexedDB 保存。Display 可将拖动意图交给 Control owner 校验、落盘并确认，不自行写存储。规格见 `Vivic_Kimi_Handoff_v0.6/`；详细范围见 [实施现状](../../implementation-status.md)。

交付入口：[完整测试清单](../../FINAL_ACCEPTANCE_CHECKLIST.md) · [完成/未完与验收事实](DELIVERY.md) · [下一位 Agent 交接](../../AGENT_HANDOFF.md) · [Git 分支约定](../../GIT_WORKFLOW.md)。新 Agent 先读根目录 `README_FIRST.md`。

## 启动

需要 Node **>=22.19.0**（Pi 1.2.0 的运行要求）和 workspace 指定的 pnpm。

```sh
pnpm install
pnpm dev          # web :5175；local-api 127.0.0.1:8787
```

`pnpm dev:web` / `pnpm dev:api` 可分别启动。本轮手测使用上述开发代理；`pnpm build` 的静态文件不等于已交付服务器/多用户部署方案，生产路由与认证代理需在二期单独验证。服务仅绑定 loopback；本地 bearer 由开发代理在服务端注入，浏览器不持有该令牌。后端热重启会清空 StepFun 内存 Key，需要重连。

## 模型与独立语音

控制端仅提供 **StepFun Coding Plan** 与 **GPT（Pi OAuth）** 两个 LLM 选项。

- StepFun：粘贴 Plan Key，目录和短 JSON 推理均通过后才显示连接成功。Key 只在本机后端内存，不进入日志、浏览器存储、画布或导出。推理、ASR、TTS 使用 Plan 路径，不静默改投普通按量接口。
- GPT：已安装 `@earendil-works/pi-ai` / `pi-coding-agent` **1.2.0**，复用既有 OAuth、刷新和 provider 传输；2026-10-16 本人新授权及真实推理/搜索/图片已有记录。没有 coding agent session、文件/shell 工具、extensions 或 skills；已有授权可以恢复，无须为这轮测试重复登录。
- **ASR 与 TTS 分别选择，与 LLM 解耦**：ASR 可选 StepFun、本地 Sherpaw 或关闭；TTS 可选 StepFun、浏览器本地音色或关闭。GPT 未连接语音时仍可完整使用文字/卡片，不把 OAuth 当作语音 API 授权。
- StepFun Plan ASR/PTT、8 种 TTS 音色已有历史真实接口证据。浏览器 TTS 使用声明 `localService` 的音色，不属于 Sherpaw TTS，也未证明任意设备断网可用。

**最新测试静音、TTS 关闭。** 既往单次发声测试只属于对应历史记录，不构成持续发声授权或当前听感验收。详见 [模型与语音架构](../../provider-voice-architecture.md)、[Plan 语音](../../stepfun-plan-tts.md)。

## 本地语音与前台单句入口

Sherpaw **0.3.0** 的 ASR/KWS/VAD 和模型设置已接入。用户按需下载固定模型，校验字节数与 SHA-256 后缓存到浏览器；默认不下载、不自动开麦。X-ASR 约 169.23 MB、KWS 约 13.08 MB、Silero VAD 约 2.31 MB；模型大小不是运行内存上限。

PTT 松开后转写，默认先放入输入框检查。VAD/KWS 每次点击只处理前台单句，最长等待 300 秒、单段最长 60 秒，结束后需重新开启；失焦、隐藏、取消、切画布或失去 owner 时停止。不承诺锁屏、后台或关闭 Control 后持续唤醒。

[本地语音原证据](../../../evidence/phase3-local-speech/REPORT.md)记录 17/17 独立生产浏览器项目：合成 WAV 的真实 X-ASR、VAD→ASR、虚拟 AudioWorklet 重采样等。默认「你好维维」随后有三种合成音色链路和静音会话记录，见 [剩余计划交付](remaining-plan.md)；**本人麦克风、真实噪声中的唤醒召回/误触发和听感仍未验收**。浏览器本地 TTS 不能用模拟事件冒充实际发声。接口和下载见 [local-speech](../../local-speech.md)。

## 七类卡片、数据与图片

Countdown、Todo、Note、SearchResult、Weather、Table、Chart 七类卡片均有 renderer。默认 minimal：倒计时只有数字，天气只有温度和图标；原始依据保留在 sourceData/sources，focus 不增加展示字段。

- 提醒：`10分钟后提醒我喝水，20分钟后提醒我休息`；支持多事项、修改/暂停/取消、跨画布到期标记及防重复交付。关闭 Control 或系统休眠期间不承诺准时播报。
- 搜索：StepFun 使用同一 Plan Key 的官方 StepSearch；GPT 使用已有 OAuth 的 Responses 搜索，保留真实 URL。无凭据 Exa 备选的 fake-IP DNS/额度问题仍存在；任意网页 `/fetch` 保持 DNS 全地址校验和 socket pin，fake-IP 被拒绝。搜索成功不代表全文读取成功，不编造来源或静默转付费路径。
- 天气：Open-Meteo 无 Key 当前模型天气，必须明确城市，同名地点澄清。已实测 `上海,上海市天气`，保留 GeoNames 地点、模型有效时间和原始查询 URL，不冒称站点观测。温度/图标整体带来源链接，Radix HoverCard 按需显示 Open-Meteo、GeoNames、CC BY 4.0 和转换说明，默认最简视图不加 footer。
- 数值：`用表格记录：苹果3，香蕉5`、`把这组数据画成折线图：周一3，周二5，周三4`。只接收明确数值，标记 `user-input`，sources 为空。现有表格可按唯一目标/明确焦点转柱状图、折线图或饼图，保留可恢复来源；歧义、负数饼图、缺失数据和混合删除均澄清，不让 LLM 补数。
- 图片：Control 支持单张 PNG/JPEG/WebP 文件、区域粘贴或拖入；浏览器重绘后只随当次显式请求发送。后端 Sharp **0.35.5** 完整解码，模型无视觉能力时拒绝。图片不进入 Display 同步、持久化、导出或后续上下文。真实浏览器用自生成 TEST 图片识别 `17 + 26 = 43`，不代表所有用户图片均已验收。

对应说明：[数据源与转换](../../data-providers.md)、[七卡 renderer](../../data-cards.md)、[图片与解码](../../image-input.md)。

## 画布交互

Control 可管理画布、主题、减少动效、Pin/取消 Pin、导出导入和撤销。Display 不增加工具栏；拖动只发送受限 `card.move`，owner 检查画布/epoch/版本/layout 基线、限流、去重并落盘，再同步确认。Pinned 卡不可拖动；未 Pin 卡仍可能参与后续自动布局。Fit 只改镜头。Auto 日夜主题支持自定义本地开始/结束时间（默认 07:00–19:00，可跨夜），背景与卡片同步按分钟切换；手动浅/深色优先。便笺可说「展开这张便笺」「收起便笺」，多张时先选择目标，原文保留。

已有 10/30/60 卡创建、刷新和拖动的浏览器记录。历史真实 7 卡场景修复后，刷新前后的 `overlaps` 均为空数组；该结论限于已测场景，不概括为任意卡片组合均无重叠。当前版本检查见一期收尾，原交互细节见 [canvas-interaction](../../canvas-interaction.md)。

## 历史基线证据与剩余边界

| 记录 | 实际证明的范围 |
| --- | --- |
| [GPT live](../../../evidence/phase3-gpt/live.json) | 既有 Pi OAuth 真实推理、多事项提醒结果及订阅搜索；动作仅检查、未派发，无图片/声音/物理麦克风 |
| [真实浏览器 live](../../../evidence/phase3-live-browser/live.json) | 5/5 通过：GPT 视觉 TEST 算式、天气、用户表格、表格转柱状图、GPT 搜索；刷新保留 7 卡，刷新前后 overlaps 均为 []，pageErrors 为空；音频与物理麦克风关闭 |
| [Chromium 全套](../../../evidence/phase3-final/chromium.json) | 58/58 通过，约 4.5 分钟；与真实账号/公网流程和长期 soak 分别记录 |
| [本地语音归档](../../../evidence/phase3-local-speech/REPORT.md) | 固定模型文件、真实 WASM、合成音频、取消/缓存完整性及设置 UI；不是现场人声或本地 TTS 发声验收 |
| [稳定性最终审计](../../../evidence/phase3-stability/final-resource-audit.json) | 旧快照约 30 分钟 23/24 检查通过、主题检查失败；另一次完整运行中断；新快照 14/14 专项通过、soak 约 61 秒，不能称新版 30 分钟全通过 |

Laya 原组合 NO_GO，Winnow 未在本机接入；Kev 是默认关闭的中文实验，不是最终可靠选型，见 [本地决策](../../local-decision.md)。新 OAuth 已完成；本人麦克风、真实环境唤醒/听感、系统输入法、物理 Safari/外接屏仍待验收。新版本的完整回归与实时长测以 [一期收尾](finalization-20261016.md) 为准，不复用上表旧快照结论。

## 检查命令

```sh
pnpm typecheck
pnpm test
pnpm contracts:check
pnpm build
pnpm --filter @vivic/web exec playwright test
pnpm --filter @vivic/web exec playwright test --config playwright.production.config.ts
node scripts/verify-stability.mjs --no-video
```

这些命令按顺序运行，浏览器使用预留 5174/8788，不与日常 5175/8787 混用；长测与其他浏览器命令串行。实际执行结果见一期验证摘要。真实联网需对应用户授权/连接，离线测试不能替代账号权限验收；自动化静音，不采集物理麦克风。

## 目录

```text
apps/web             Control / Display、七卡、React Flow、同步、持久化、图片及本地语音
apps/local-api       loopback API、StepFun、Pi GPT、搜索、天气/数值、图片解码与动作校验
packages/contracts   ActionEnvelope / CardRecord / VivicState 共享 schema
docs                 模块说明；组件、包与模型许可另见根 LICENSES.md
evidence             原始 JSON、截图和录屏，合成数据与真实 provider 结果分别标明
Vivic_Kimi_Handoff_v0.6  产品与验收规格
```
