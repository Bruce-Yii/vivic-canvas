# LICENSES.md — Vivic 组件、运行包、模型与数据归属

2026-10-23 最新本地运行增量（优先于下方历史阶段说明）：可选启动器现在会按需下载真正的 StartLux Instant 与动态本地 TTS。Windows/线上源码包不捆绑这些模型权重或 Python 环境；Hark 资源沿用文末所列独立权利条件。

| 新增运行 / 训练来源 | 固定版本 / revision | 许可与分发说明 |
| --- | --- | --- |
| StartLux 官方推理源码 | `StartLuxLabs/StartLux-Decision@83fe6c7d61a687a6e17f118b4f7d8f429f5d3a01` | Apache-2.0，按需准备时附原 LICENSE；只提取运行必需源码 |
| StartLux Instant 0.8B / 2B / 4B / 9B | `apps/local-api/src/runtime/startluxProfiles.ts` 固定仓库、revision、SHA256 | **CC BY-NC 4.0**；基础权重、衍生适配器与代码许可分别记录，本轮不声明商业授权，不捆绑权重 |
| llama.cpp | 固定官方 `b11550` Windows x64 / macOS arm64 / x64，见 `platform-artifacts.json` | MIT，下载的引擎保留上游许可；旧 Qwen / b9660 记录为历史兼容实现 |
| uv / CPython | uv 0.12.24；CPython 3.12.15，独立运行目录 | uv Apache-2.0 / MIT；Python PSF-2.0 及发行包自带通知，不改系统 Python |
| 动态 Sherpa-ONNX / Kokoro TTS | Sherpa-ONNX 1.12.32；`csukuangfj/kokoro-multi-lang-v1_1@914313412b607d95400bcd12446233fbd1248801` | Sherpa-ONNX 与 Kokoro 模型 Apache-2.0；内含 eSpeak 数据 **GPL-3.0-or-later**，按固定 manifest 下载 COPYING / 来源，不能把整条链统称 Apache |
| 开发训练环境 | PyTorch 2.9.1+cu128、Transformers 5.8.0、PEFT 0.21.0、NumPy 2.5.4 | BSD-3-Clause / Apache-2.0 / Apache-2.0 / BSD-3-Clause；独立开发环境，不随安装器捆绑 |

本地运行详见 `docs/updates/2026-10-23-local-runtime-next.md`，训练来源、合成数据与候选边界见 `training/startlux/README.md`。动态合成已实际执行为文件，尚未进行用户扬声器听感验收；下方“Sherpa仅开发/未新增推理引擎”只描述此前固定短句阶段。

2026-10-22 新增分发：Node 24.21.0 Windows x64 使用官方固定 SHA-256 发行包并随包保留完整 Node LICENSE；llama.cpp b9660（MIT）与 Qwen2.5-0.5B-Instruct-GGUF 固定 revision（Apache-2.0）在用户准备时从各自官方发行源下载，清单/哈希见 `apps/local-api/src/runtime/artifacts.ts`。`qrcode@1.5.4`（MIT）用于二维码，`ws`（MIT）用于独立中继，`fflate`（MIT）用于固定 ZIP 解压；精确解析版本由锁文件固定。本次没有再分发 Hark 字体、APK 或反编译实现。

更新：2026-10-15。本轮新增包的 exact 版本与许可核对了 workspace package.json、`pnpm-lock.yaml` 及本机安装包 package.json；Recharts、Sherpaw、Sharp 同时读取了包内 LICENSE。Pi 1.2.0 的 MIT 依据安装包 license 元数据和本地 provenance，不声称其 npm 包根目录附带了本轮未找到的 LICENSE 文件。
三种 registry 组件（Grainient / Siri Orb / styled Generative UI）以 shadcn CLI 复制源码方式安装，
**无 npm 包版本**，源码即本仓库内文件；其余为 npm 依赖。

## 视觉核心组件（spec 锁定项）

| 组件 | 用途 | 来源 URL | 安装形式 | 版本 / Commit | 许可证 |
|---|---|---|---|---|---|
| React Bits **Grainient** | 默认工作背景（WebGL 渐变+颗粒） | https://reactbits.dev/backgrounds/grainient | shadcn registry 复制源码 `npx shadcn add @react-bits/Grainient-TS-TW` → `apps/web/src/components/Grainient.tsx` | copied source, no package version（registry item `Grainient-TS-TW`，React Bits v1.x 代） | **MIT + Commons Clause**（保留既有复制源许可记录及附加条款，不据此作任意商业转售许可承诺） |
| SmoothUI **Siri Orb** | 待机/反馈 Orb | https://smoothui.dev/docs/components/siri-orb | shadcn registry 复制源码 `npx shadcn add @smoothui/siri-orb` → `apps/web/src/components/smoothui/{siri-orb,ai-core}/index.tsx` | copied source, no package version（registry item `@smoothui/siri-orb`） | **MIT**（SmoothUI） |
| Assistant UI **styled Generative UI registry** | 卡片内部结构化渲染（Text/Col/Caption 等白名单） | https://www.assistant-ui.com/elements/generative-ui | shadcn registry 复制源码 `npx shadcn add @assistant-ui/generative-ui` → `apps/web/src/components/assistant-ui/elements/generative-ui.tsx`（含 surfaces / geo-map / mermaid-diagram / utils） | copied source, no package version（registry item `@assistant-ui/generative-ui`） | **MIT**（assistant-ui registry 源码与包一致） |
| **@assistant-ui/generative-ui**（runtime 包） | `renderGenerativeUI(spec, library)` 引擎 | https://github.com/assistant-ui/assistant-ui | npm 依赖 | **0.0.4**（lock: `sha512-czBFWSxcRv6hA78eSq/ImEkRqurEgte6U5GS+ZSHAAfoBOW9wI2gQzwdVKs8vkYBKvbNmvni8sN5g5FEiZqKug==`） | **MIT**（包内 LICENSE 与 package.json 明示） |
| **@xyflow/react**（React Flow） | 无限画布 pan/zoom/focus/拖动 | https://reactflow.dev/ | npm 依赖 | **12.12.0** | **MIT**（包内 LICENSE；分发保留版权与许可） |
| **Motion** | Orb/遮罩/字幕/布局动效 | https://motion.dev/ | npm 依赖 | **14.2.0**（motion-dom 14.2.0, motion-utils 14.1.1） | **MIT** |

## 本轮体验增量（2026-10-16）

一期收尾新增开发测试依赖 `ajv@8.20.0`、`ajv-formats@3.0.1`，安装包元数据均为 MIT，仅用于 JSON Schema/运行时契约回归，不新增产品运行组件。JSON Schema 由既有 Zod 的 `toJSONSchema` 生成，未接入另一套卡片渲染器。

`cmdk@1.1.1`（https://github.com/pacocoursey/cmdk）和 `pinyin-match@1.2.10`（https://github.com/xmflswood/pinyin-match）均来自 npm 精确版本，包内 MIT 许可全文保留在 [第三方许可](docs/third-party/experience/)。shadcn radix-nova Command registry 源码（2026-10-16）接入现有 Radix Dialog、Lucide 和主题，MIT 全文同目录保留。原始 registry 与所用发行文件 SHA256、适配范围见 [本次说明](docs/archive/2026-10/experience-20261016.md)。未复用 HARK 私有实现或字体。

## UI 基础与支撑依赖

| 组件 | 用途 | 来源 | 版本 | 许可证 |
|---|---|---|---|---|
| **tailwindcss** (+ @tailwindcss/vite 4.3.3) | 样式系统 v4 | https://tailwindcss.com/ | **4.3.3** | **MIT** |
| **shadcn**（CLI）+ shadcn/tailwind.css 预设 | registry 安装与基础 tokens | https://ui.shadcn.com/ | **4.21.4** | **MIT** |
| **radix-ui** | 基础交互原语（components.json style: radix-nova） | https://www.radix-ui.com/ | **1.8.1** | **MIT** |
| **zod** | Action/Card schema 白名单校验 | https://zod.dev/ | **4.6.7**（直接依赖；shadcn 内部锁 3.25.76） | **MIT** |
| **lucide-react** | 图标 | https://lucide.dev/ | **1.56.0** | **ISC**（图标字体部分 SIL OFL） |
| **react** / react-dom | 框架 | https://react.dev/ | **19.3.0** | **MIT** |
| class-variance-authority | shadcn 变体工具 | npm | 0.7.1 | Apache-2.0 |
| cn / clsx 系 | class 合并工具 | npm | 0.4.0 | MIT |
| tw-animate-css | 动画工具类 | npm | 1.4.0 | MIT |
| tw-shimmer | 微光效果工具类 | npm | 0.4.13 | MIT |
| @fontsource-variable/geist | 字体 | npm | 5.3.0 | MIT（字体 OFL-1.1） |
| react-markdown + remark-gfm | styled registry 内 Markdown 渲染 | npm | 10.1.0 / 4.0.1 | MIT |
| beautiful-mermaid | styled registry 内 Mermaid 渲染（Phase 0 未挂载到卡片） | npm | 1.1.3 | MIT |
| leaflet | styled registry 内 GeoMap（Phase 0 未挂载到卡片） | npm | 1.9.4 | BSD-2-Clause |

## 本轮已安装的运行包

| 包 | 实际版本 | 本地核实的许可/来源 | 当前用途 |
| --- | --- | --- | --- |
| `@earendil-works/pi-ai` | **1.2.0** | **MIT**；安装包 license/repository 元数据，仓库 `earendil-works/pi`；[本地 provenance](apps/local-api/src/gpt/PROVENANCE.md)记录核查源码 SHA `9a3ca68bda4db67efc506ec114bffe64635e8569` | GPT OAuth、refresh、模型/provider 与真实推理；Node >=22.19.0 |
| `@earendil-works/pi-coding-agent` | **1.2.0** | **MIT**；同上，固定发行包 | 仅单独加载 AuthStorage；没有 agent session、coding tools、extensions/skills 或 CLI 自动执行 |
| `recharts` | **3.10.1** | **MIT**，包内 LICENSE：© 2015-present recharts；仓库 `recharts/recharts` | 真实 line/bar/pie renderer，不是手绘仿制；见 [data-cards](docs/data-cards.md) |
| `@sherpaw/asr`、`@sherpaw/kws`、`@sherpaw/vad`、`@sherpaw/preloader` | **各 0.3.0** | **Apache-2.0**，四包 package.json 与 LICENSE；npm repository 为 `sumimakito/sherpaw`，本地上游核查记录 `moeru-ai/sherpaw` SHA `2b12da09ab0cf45894e9565c386bf003cf44a106` | 按需本地 ASR/KWS/VAD 与模型缓存，不包含已验证的 Sherpaw TTS |
| `sharp` | **0.35.5** | **Apache-2.0**，包内 LICENSE；仓库 `lovell/sharp` | 当次图片的完整本机像素解码；见 [image-input](docs/image-input.md) |

Pi 是实际 npm 运行依赖，不能再写成「尚未安装任何 Pi runtime」；安装这些包也不等于启用了完整 coding agent。新 OAuth 交互未实测，既有 Pi OAuth 推理/搜索成功见 [真实记录](evidence/phase3-gpt/live.json)。

Sharp JavaScript 包许可不能覆盖全部 native 二进制依赖：本机安装的 `@img/sharp-libvips-darwin-arm64@1.3.4` package.json 声明 **LGPL-3.0-or-later**；真实 decoder 记录 libvips 8.18.7。二进制分发还需随实际平台产物保留相应第三方许可/通知，不能把整条 native 依赖链统称 Apache-2.0。本次没有重新审计全部平台二进制。

## 按需语音模型与上游通知

模型与 Sherpaw 代码分别记录许可。以下为当前 [manifest](apps/web/src/ai/localSpeech/manifest.json)及[归档副本](evidence/phase3-local-speech/models-manifest.json)中的实际模型，包含下载 URL、精确字节数、SHA-256 和 licenseUrl；权重不放入仓库 public。

| 模型 | 固定仓库 / revision | 字节数 | 模型许可 |
| --- | --- | ---: | --- |
| X-ASR zh-en 480ms INT8 | `moeru-ai/sherpaw-x-asr-zh-en-480ms-int8` / `d9ab70a45493b97ae76e08574fcbc5ad0c5d0039` | 169,227,953 | **Apache-2.0**；manifest 指向固定 HF LICENSE；原模型为 GilgameshWind/X-ASR-zh-en，经上游 release 打包 |
| KWS Zipformer zh-en 3M | `moeru-ai/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20` / `1770a4b22db32184c110ac43c601db17cc9c93f8` | 13,076,183 | **Apache-2.0**；模型卡/固定 HF LICENSE，原模型归属 pkufool/k2-fsa release |
| Silero VAD v5 | `csukuangfj/vad` / `fba88cd2e921609e7675c3aaf51e0b9b295da4bc` | 2,313,101 | **MIT**，不能以 Sherpaw Apache-2.0 替代；SHA `6b99cbfd39246b6706f98ec13c7c50c6b299181f2474fa05cbc8046acc274396` 与原 release 记录一致 |

[Sherpaw 本地核查](docs/sherpaw-poc-plan.md)记录上游根 NOTICE 和 Sherpa-ONNX SHA `917bed95c8e5c7c18aa4d69fea42e9ef8ef0a60e`（Apache-2.0）。分发对应源码/WASM/权重时应保留各自 LICENSE、版权、适用 NOTICE 和固定模型归属；这些记录不是训练语料权利或全部 WASM 第三方依赖的完整审计。文件实际下载/校验及 WASM 运行见 [本地语音证据](evidence/phase3-local-speech/REPORT.md)。

浏览器 `speechSynthesis` / `localService` 音色来自浏览器/系统，不是上述模型包，也不随本仓库分发；不能由 Sherpaw 许可推导音色许可或离线保证。最新测试静音/TTS 关闭，本地音色尚无实际发声验收。

## 随应用提供的固定短反馈

三个自编短句「我看看」「稍等」「好的」由 [Kokoro-82M-v1.1-zh](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh/tree/01e7505bd6a7a2ac4975463114c3a7650a9f7218) 开放权重离线合成；原模型 Apache-2.0，中文数据授权来源见原模型说明。使用 ONNX 转换 `csukuangfj/kokoro-multi-lang-v1_1` revision `914313412b607d95400bcd12446233fbd1248801`，原许可全文、文件散列和生成说明随 [voice-feedback](apps/web/public/voice-feedback/PROVENANCE.md) 保留。三个 MP3 共 19,911 字节，没有分发权重或新增应用推理引擎。

仅开发时使用 sherpa-onnx 1.12.32（Apache-2.0）、NumPy 2.3.3 和 FFmpeg，模型附带 eSpeak NG 字典（GPL-3.0）用于预处理；这些工具/权重/字典保留在忽略的 `.cache/`，未复制进 Web 产物。没有使用许可 Unknown 的 Piper huayan、系统音色录制或用户麦克风录音。生成未发声，真实听感待验收。

## 天气与地名数据归属

Open-Meteo 是调用公共 HTTPS API 的数据服务，未安装或复制其 AGPL 服务端源码。既有本地研究记录其 API 数据为 **CC BY 4.0**，公共无 Key 服务仅用于非商业场景；不能把数据许可等同于托管 API 的无限免费商业使用权。天气来自模型当前条件，不伪称现场观测。

地名数据库归属 **GeoNames**；本地许可核查记录 CC BY 归属要求，数据卡保留 Open-Meteo/GeoNames 名称和链接、CC BY 4.0 链接、字段选择及 WMO→图标变换说明。当前 [WeatherCardView](apps/web/src/cards/WeatherCardView.tsx) 已将最简温度/图标整体作为来源链接，并以既有 Radix HoverCard 按需展示 Open-Meteo、GeoNames、CC BY 4.0 和转换说明；默认不添加 footer，归属不再仅存于 sourceData。该组件复用已安装的 `radix-ui`，没有另引一套 UI。上游归属依据及 API 记录见 [data-providers](docs/data-providers.md)、[真实天气证据](evidence/data-providers/open-meteo-live.json)。用户手填数值标记 `user-input`，sources 为空，不伪造外部数据许可/URL。

## 开发工具链

Vite 8.3.4、TypeScript 6.0.3、Vitest 5.0.4、@playwright/test 1.64.0、oxlint 1.81.x，均 MIT / Apache-2.0。

## 备注

- **pi-web-access 安全子集**：代码级复用 `pi-web-access@0.41.0` 的 Exa MCP 请求/解析及 GPT OAuth search/citation 提取，固定 commit `d47dc040552505e3b135d0136a0b15eaf4bdba52`，MIT ©2025 Nico Bailon。全文保留于 [LICENSE.pi-web-access](apps/local-api/src/search/upstream/LICENSE.pi-web-access)，来源和改动见 [Exa provenance](apps/local-api/src/search/upstream/PROVENANCE.md) 与 [GPT provenance](apps/local-api/src/gpt/PROVENANCE.md)。没有安装完整 pi-web-access 包，不声称所有 fetch/仓库/文件工具均已集成；Pi 发行包已按上表实际安装，范围仅认证和模型传输。
- **Laya实验缓存**：固定源码commit `432312b36714d8889eba405507b37eda25257d9c`及`convaiinnovations/laya-multilingual`模型revision `1720e3e3357cfe1e281542e223f8273b0890ca34`，来源声明Apache-2.0；模型卡/源码/哈希与具体复跑说明见 `docs/laya-poc.md`、`scripts/laya-poc/artifacts.lock.json`。模型、固定源码和隔离Python环境位于忽略的`.cache/laya-poc`，不是当前应用运行依赖或Web发布资产；若另行分发须保留相应许可与归属。未下载Winnow。

- **当前未使用**：Vanta Clouds/Clouds2（RESEARCH）、Liquid Ether（spec 禁用）、ELK.js。Recharts、Sherpaw 现已实际安装使用，不能再沿用 Phase 0 的未安装清单。Laya 当前组合 **NO_GO**；Winnow **BLOCKED**，未下载/运行，不作为已交付运行依赖。
- `Vivic_Kimi_Handoff_v0.6/reference/atmosphere_original.html` 为用户上传的视觉参考文件，仅用作运动/配色基准，未嵌入产物。
- 截图对比件 `evidence/phase0/reference/` 为该参考的浏览器渲染记录，非产物 UI。

## 本轮本地决策、日程与正文解析

| 包 / 模型 | 固定版本或来源 | 许可 | 用途 |
| --- | --- | --- | --- |
| `@js-temporal/polyfill` | 0.5.1 | ISC | 时区、日期及夏令时计算 |
| `@mozilla/readability` | 0.6.0 | Apache-2.0 | 已抓取 HTML 的正文提取 |
| `jsdom` | 30.1.2 | MIT | 惰性 DOM 解析，不执行脚本/加载资源 |
| Kev 源码与 Kev-0.8B 适配器 | [固定 manifest](scripts/decision-model/manifest.json)、[上游许可](scripts/decision-model/LICENSE.kev) | Apache-2.0 | 可选的固定选项评分器 |
| Qwen3.5-0.8B-Base | `dc7cdfe2ee4154fa7e30f5b51ca41bfa40174e68` | Apache-2.0 | Kev 固定基础权重，按需下载，不随源码提交 |
| MLX / mlx-lm | 0.32.4 / 0.31.3 | MIT | Apple Silicon 本地推理 |
| PyTorch / Transformers / PEFT | 2.8.0 / 5.19.0 / 0.21.2 | BSD-3-Clause / Apache-2.0 / Apache-2.0 | 固定离线加载及张量接口；完整环境锁见 `requirements.lock` |

默认唤醒词合成验收复用上述「固定短反馈」中同一套 Kokoro 固定权重与许可，仅生成本机 TEST 文件，不随产品新增用户音频。Winnow 只核对公开元数据，未下载/分发其权重。

## 2026-10-22 手机与演讲体验增量（历史）

- Android 原生二维码解码复用 ZXing core 3.5.3（Apache-2.0）；固定工件散列、完整许可与 NOTICE 见 `apps/android/README.md` 和 `apps/android/licenses/`，许可同时随 APK 打包。
- `apps/web/public/voice-feedback/stepfun/` 为本轮经用户授权，用 StepFun Plan 官方温柔女声音色生成的 16 段自编通用短句；模型/音色/日期/文件散列见同目录 PROVENANCE 与 manifest。没有克隆真人音色，不分发模型权重或凭据。
- Hark/Mirasim/TODAY 的设计与交互研究用于 Vivic 适配，来源固定提交与差异见 `docs/mobile-design-transfer-20261022.md`、`docs/research/today-office-planner-mapping.md`、`docs/settings-design-transfer-20261022.md`。本轮未随产品加入其原 APK、私有字体、账户资料或反编译实现。
- Travel Vivic Space 复用主产品既有组件；独立构建生成 `THIRD-PARTY-NOTICES.txt` 并纳入部署包。其 DEMO 行程、住宿偏好画像和规划文字为本项目自编内容。
- 后续按用户要求复用 TODAY 研究的原始任务模板、认证参考 CSS 与选定内容卡属性，并组合 Hark 排版角色和 Lucide 图标映射；来源文件、固定提交与散列见 `apps/web/src/components/today/SOURCE.json`，目标差异见 `docs/updates/2026-10-22-today-hark-ui.md`。TODAY 合作与复用由用户在本会话明确授权；未使用私有账户原图或 withheld 原字体。Android 包同时附带实际 UI 依赖的 Lucide、Geist、React、React DOM 与 Radix 许可原文。

## 2026-10-23 Hark 全面替换

最新活动实现为 `apps/web/src/components/hark/`，固定 library `26ac2724`。七份原字体、74 命名 SVG 几何、连续圆角 helper 与离线渲染的天空静帧实际进入本地预览/测试包；原始路径与 SHA-256 见 `SOURCE.json`。上述历史段落的「未加入原字体」只描述旧版本。TODAY 视觉源码已退出活动产品，模板业务内容继续保留。

原 Hark 字体、图标和代码片段保留各自原权利条件；研究公开不等于授予开源或商业分发许可，不将它们声明为本项目 MIT 依赖。归属说明随 Web 的 `HARK-SOURCE-NOTICE.txt` 与 Android `licenses/HARK-SOURCE-NOTICE.txt` 提供。本轮未加入 Hark 原 APK、服务端、账户资料或私密研究截图。React/Radix/Lucide/Geist/ZXing 等现有依赖许可继续随包保留。
