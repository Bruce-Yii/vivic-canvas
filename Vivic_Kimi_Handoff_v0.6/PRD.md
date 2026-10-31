# Vivic 产品需求文档（PRD v0.6）

**版本日期**：2026-10-14  
**定位**：Web First · 个人版 MVP · Kimi K3 实施交接  
**优先级**：本 PRD 与 `AGENTS.md`、`COMPONENT_LOCK.md`、`CARD_CONTRACT.md` 均为强制规范。  
**一句话**：用户动嘴或打字，Vivic 在一个具有呼吸感的无限画布上创建、理解、操作、保存极简卡片，必要时联网查询真实信息。

> **产品宪章：Expressive Environment, Minimal Information.** 灵动来自光、声音、响应、转场；信息卡片绝不堆砌说明。模型输出结构化数据和动作，不输出 HTML/CSS。

## 0. 冻结决策

2026-10-16 用户更新：纯计时器仍只显示数字；带事项提醒显示事项与时间，未固定项合并，一次性到时退出 Display、记录留 Control。阅读材质、Control 长内容详情和中文/拼音找卡已实现。当前按 [完整清单](../docs/FINAL_ACCEPTANCE_CHECKLIST.md) 验收；服务器、多用户、手机控制台和新增 Assistant UI 卡片仅记录为二期候选，测试完成后再逐项展开。

2026-10-15 用户更新：LLM 连接限定为 StepFun Coding Plan 与 GPT（复用 Pi 既有 OAuth），取代本文「Claude 等」及旧实施记录「OAuth 全部暂缓」描述。语音 STT/TTS 与 LLM 分开；GPT 未配语音时使用文字/卡片，不强制再填语音 Key。Sherpaw 本地 ASR/VAD/KWS 仍为待验证候选，TTS 不能从 Sherpa-ONNX 的整体能力推定已在 Sherpaw 可用。具体能力、事实来源和降级要求见 [模型与语音架构核查](../docs/provider-voice-architecture.md)。

| ID | 决策 | 必须落实的行为 |
|---|---|---|
| D01 | **Web First，不做桌面端** | 同一 React App 提供 `/control` 和 `/display`；两个同源网页窗口可放到主屏和扩展屏。macOS 原生端、系统级快捷键、屏幕截图放 Roadmap。 |
| D02 | **两个界面、同一份画布** | 控制端负责输入、API Key、连接与设置；Display 只有背景、卡片、短暂 Orb、短暂字幕/提醒。可提供单页内隐藏设置入口，但 Display 不显示入口。 |
| D03 | **Pi Web Access 是首选查询实现** | 首先验证不单独配置搜索 Key 的 `web_search` / `fetch_content`。无需让用户自己安装搜索 MCP；产品内部适配即可。不可保证任何网络环境 100% 可用。 |
| D04 | **Pi 不是 Coding Agent** | Pi 可作为模型调用/登录、受限工具容器；必须禁用默认 `read/write/edit/bash`，以及未经审查的扩展、插件与自动执行能力。 |
| D05 | **个人模型连接** | StepFun BYOK 是必做；Pi 登录 Codex/GPT、Claude 等做明确 PoC，能用则接入个人本地版本；不能稳定使用就标示暂不可用，不影响 StepFun 版本交付。未来会员和商业化不在本期。 |
| D06 | **Winnow 优先路由** | 用户实测优胜，作为首选快速策略模型；具体运行环境、接口、延迟需实测；简单确定指令规则优先。 |
| D07 | **语音为主，文字可用** | 先打通文字指令；实现浏览器麦克风 PTT；Sherpaw ASR/VAD 优先；KWS 唤醒为后续 PoC，语音失败可文字降级。 |
| D08 | **待机 Orb → Grainient** | 纯黑背景的呼吸球，唤醒时平滑扩散为工作背景。工作态通常没有球；需要反馈时短暂出现，随后融入环境（方案 C）。 |
| D09 | **背景组件固定方向** | 默认 React Bits Grainient；Vanta Clouds/Clouds2 是候选；上传 HTML 是烟雾运动参考。禁用鼠标引起的大幅流体变化。禁止以 Liquid Ether 偷换。 |
| D10 | **日夜自动** | 待机一律黑色；工作态根据用户可配置的时间段浅/深主题自动切换，手动覆盖优先。 |
| D11 | **Card = Minimal by default** | 倒计时默认只显示数字；天气只显示温度和必要图标；Todo 只显示任务+状态。禁止 AI 把口播解释塞进卡片。 |
| D12 | **画布即 Session** | 多画布持久化、切换、导出、导入；卡片 displayProps/sourceData 分开。轻量近期指代上下文，绝不做跨画布长期人格记忆。 |
| D13 | **权限最小化** | Vivic 只搜索/读取公开网页、查询用户明确连接的信息服务，管理自己的卡片/待办；不写代码、不执行命令、不操作本地项目文件。 |
| D14 | **资源整合优先** | UI、画布、动画、Orb、图表、搜索/网页读取优先用已批准成熟组件与项目。只有独特的体验编排与 adapter 允许自研。 |
| D15 | **先精致后扩展** | Phase 0 必须做真实视觉原型且通过验收；不因想加更多功能而牺牲视觉质量。 |

## 1. 产品定位、用户价值与非目标

### 1.1 产品定位

Vivic 是一个自然语言驱动的智能信息画布。用户问天气、查开源项目、整理 Vibe Coding 思路、列待办时，Vivic 不以聊天滚动文本为中心，而是把**有用的信息持续固定在屏幕上**，通过动作、视角和语音来强调重点。

用户可以按主题创建多个画布，如「生活」「Vivic 项目」「今天要做的事」。画布并非用户账户的长期记忆，而是当下 Session 的可视化状态。

### 1.2 典型任务

- **快速操作**：「创建一个十分钟倒计时」「放大左边的待办」「删掉天气」「恢复刚才的画面」。几乎不应耗费长模型推理。
- **查找资料**：「查查有哪些开源卡片库适合 React」「比较三个项目维护状态」。Pi Web Access 真实搜索/抓取，LLM 提炼，输出 SearchResultCard / TableCard，附来源。
- **梳理思路**：用户口述复杂计划，Vivic 在画布上创建 Todo/Note/Table/Chart 卡片，口播只强调一个重要点。
- **生活助手**：「今天天气」「明天有什么日程」「今晚几点提醒我」。天气与日历接入按 provider 能力与授权逐步开放；未连接时清晰提示，不虚构。
- **文字和图片**：控制页输入长文本、粘贴图片。图片先作为控制端附件保存；图片展示卡与多模态识别按能力逐步接入。只有在已启用可用多模态模型时才分析其内容。

### 1.3 非目标（明确禁止 MVP 开发）

- Electron、Tauri、macOS 系统截屏、左右 Option 截图、跨设备动画传输、系统悬浮输入窗口。
- 自动修改代码、安装依赖、操作 shell、读写任意电脑文件、复杂自主 Agent Loop。
- 复杂角色人格与长期个人记忆、会员支付、账户中心、第三方卡片商店、音乐平台授权播放。
- 自定义 WebGL 物理引擎、手写通用图表框架、重造 React Flow 或 shadcn 组件。

## 2. 页面结构与第二屏

### 2.1 `/control`（主控端）

允许正常的配置 UI，但风格仍需克制。包括：

- 主输入区：文本、粘贴/拖拽图片、麦克风 PTT；必要时可在一张表单中编辑转写内容。
- 画布管理：列表、创建、重命名、删除、切换、导入导出。
- AI Provider：StepFun API Key、当前模型、连接测试；Pi 登录实验开关/登录状态/断开。
- 搜索：Pi Web Access 搜索可用性检测、最近一次来源、失败与重试；**不要把搜索 API Key 设置成必填项**。
- 语音：麦克风权限、ASR 模型下载状态、TTS/预录短句、字幕开关。
- 视觉：Grainient/Clouds 选择、浅/深主题与自动切换时间、降低动态效果。
- 「打开 Vivic 展示窗口」：`window.open('/display?canvasId=...')`，由用户自行拖动到 HDMI/扩展屏并全屏。

### 2.2 `/display`（展示端）

平常**仅允许**：背景、画布卡片、按需出现的 Orb、动态字幕、相关提醒或歧义高亮。禁止固定工具栏、logo、模型名、token、调试文本、欢迎词、总标题、用户聊天记录和设置入口。不得出现为了填满屏幕而加的无用组件。初始无卡片时显示 Orb 待机。

卡片默认 Solid / 白色表面；Frosted 轻透明仅作为可读性通过后的主题选项，支持随白天夜晚切换。背景渲染固定在画布外层，不随 React Flow 缩放。

### 2.3 同机双窗口同步（P0）

- 同一 origin、同一浏览器存储分区内用 BroadcastChannel 同步；不能用于电视自带浏览器的跨设备连接。
- Controller 是唯一可写 state owner，Display 只读订阅。每个消息带 `canvasId / epoch / sequence / stateVersion / requestId`。
- Display 打开时请求 snapshot，之后消费 patch；发现丢失/版本不一致就重新请求 snapshot。
- 状态变更只执行一次（幂等 `requestId`），动画消息可以与状态补丁分离；窗口重连不重复触发 `card.create`。
- 主控关闭时保留现有画面，不清空；重新连接后自动恢复。无控制者时页面不执行有副作用的动作。
- **后续**另开 WebSocket 配对方案，可连接电视浏览器/另一台电脑；不属于 P0 必须实现。

## 3. 交互状态机与“活人感”

视觉主状态：

1. `STANDBY`：纯黑 + 缓慢呼吸 Orb，低功耗。
2. `AWAKENING`：Orb 微回弹、发光、球形遮罩向外扩散；露出 Grainient，**不可黑白硬切**。
3. `WORKSPACE`：连续缓慢烟雾/渐变背景 + 卡片，Orb 默认消失。
4. `FOCUS`：镜头平滑移动/放大目标卡；与字段显示密度独立。

AI 正交状态：`idle / listening / thinking / speaking / error`。Motion Director 根据状态协调 Orb（出现/消散）、卡片（生成/重排/聚焦）、字幕（语音同步短暂出现）和背景（呼吸/轻微脉冲）。

关键细节：

- **说话≠卡片文字**：Vivic 可说「我找到了，第二条你注意下」，卡片显示独立的精简资料，同时高亮第二条。
- 常见短语如「我看看」「稍等」优先用合法预录音；长短句可选 TTS。没有可用 TTS 不阻塞结构化 UI。
- 字幕是底部无气泡、无头像、无时间戳的轻盈文字，在语音播放时短暂弹出，结束后消失；能获得时间戳时按时间戳同步，否则按句同步。
- 动画需要可中断、可取消、可恢复；用户打断/再发指令时不堆积过时动作。
- 背景只按时间缓慢变化，默认不随鼠标大幅形变。背景不能遮挡卡片的文字可读性。
- 倒计时提醒可改变整个背景氛围（红色警示光晕），**避免高频闪烁**，提供可关闭、减少动态效果支持。

详细标准见 `MOTION_AND_VISUAL_QA.md`。

## 4. 卡片系统与极简规范

### 4.1 两层数据

`CardRecord = { id, type, variant, displayProps, sourceData, sources, layout, metadata }`。

- `displayProps`：唯一允许直接展示的字段，严格 schema 白名单；unknown 字段拒绝或报告，绝不当作「建议文案」展示。
- `sourceData`：完整查询依据、时间、数据、供后续语义引用的信息；默认不渲染，也不得包含 secrets。
- `sources`：来源 URL、名称、抓取时间与验证状态；检索卡可展示简短来源标签。
- `variant = minimal|standard|expanded`：控制信息密度；`canvas.focus` 只改变镜头，**不得默认改变 variant**。

### 4.2 MVP 七种卡片

| 卡片 | minimal 只显示 | 特别限制 |
|---|---|---|
| CountdownCard | 大号倒计时数字，例如 `12:45` | 不显示标题、鼓励语、说明、底部按钮；数据由本地计时而非模型逐秒更新 |
| TodoCard | 任务文本 + 勾选状态 | 默认有限条数；无 AI 建议、自动总结 |
| NoteCard | 简短重点或列表 | 必要时点击/语音展开，原文留 sourceData |
| SearchResultCard | 标题 + 一句话要点 + 来源 | 真实来源，不凭空生成已抓取网页声称 |
| WeatherCard | 温度 + 天气图标 | 地点等详细信息按需展开；未接入不显示假实时数据 |
| TableCard | 表头与最少必需数据 | 禁止强制说明段，防溢出、可缩放 |
| ChartCard | 图、必要坐标与单位 | 必须有可核验数据与空值处理 |

`WebPreviewCard` 与 `CalendarCard` 进入 P1；外部开发者卡片 manifest 协议预留，不做商店。卡片仅使用经过审批的 UI 组件、统一 design tokens。

### 4.3 实际视觉实现

- Assistant UI 的 `@assistant-ui/generative-ui` **styled library** 负责卡片内部结构，`renderGenerativeUI(spec, styledGenerativeUILibrary)` 可独立使用，不用加载聊天 Thread；卡片外框和独特计时视图可以用批准的 shadcn/Motion 组合，不强迫显示完整模板中多余的字段。
- React Flow 负责画布、坐标、pan/zoom、节点/边界；Motion 负责卡片入场/退场、强调与镜头编排。
- 卡片允许少量手动拖动和 Pin；自动布局不得覆盖用户已固定的卡片。未知卡片类型不得动态 import 任意用户 HTML。
- 标准场景录屏 + 实际截图必须验收；没有截图的“看起来不错”不能算通过。

详细规则见 `CARD_CONTRACT.md` 和 `COMPONENT_LOCK.md`。

## 5. 语音、快速路由和结构化 Action

统一链路：

`文字/Browser PTT → 本地规则 → Winnow 意图判定 → [Pi 模型调用或 StepFun] → [Pi Web Access 实际搜索/抓取] → 结构化 Action → Schema/权限/目标校验 → Reducer → CanvasStore → Broadcast → MotionDirector`。

- 本地规则：已明确目标的 `card.delete`、`card.focus`、`timer.start`、`canvas.fit` 等；不得错误猜测「这个卡片」。
- Winnow：用户验证表现较好，优先用于 `intent / targets / needsSearch / needsLLM / confidence`。若接口、模型权重或兼容性不可用，必须标为未完成并提供 adapter PoC；不得悄悄换成其他模型宣称 Winnow 可用。
- LLM：理解复杂语义、压缩信息、选择已注册卡片/动作，永远不生成代码或 HTML，输出 JSON 且验证失败可重试/澄清。
- 快速回复与搜索并行：只有在已启动真实工具请求后可播放「我看看」；实际失败时应说明失败，不展示假结果。
- 「删除那个卡片」无法判定：短暂高亮多个候选并问「你说的是左边的待办还是右边的资料？」；未确认不删除；所有破坏性卡片动作可撤销。
- 每轮需精简上下文，只送当前画布相关卡片的结构化 `sourceData` 摘要和最近指代，不送无关个人历史。

## 6. Pi 模型登录与零额外 Key 查询（MVP）

这是相对于旧版 PRD 的**核心更改**。

### 6.1 用户希望的体验

控制页「AI 连接」提供：

- **StepFun API Key（必做）**：用户自行输入、连接测试、选择已实测模型。
- **Pi Account Connection（实验功能）**：研究将已有 Pi 登录状态用于本机个人版本的 GPT/Codex、Claude 等模型调用；必须先检查提供商具体条款、个人使用边界、计费和真实可用性。**不得**将 ChatGPT 登录说成通用 OpenAI API 或商业化会员能力。
- **联网查询：默认无需单独搜索 Key（必做验证）**：复用 `pi-web-access` 的 `web_search`、`fetch_content`。它声称可使用 Exa MCP 零配置搜索；在 Pi 扩展模式且符合条件时可复用 Codex 登录查询。两条方式要分开测试。

### 6.2 两种可接受的集成实现

**A. 优先：受限 Pi 运行时 + pi-web-access Pi 扩展**

- Node 本地服务进程中创建专用于 Vivic 的 Pi session/模型适配，显式配置工具白名单。
- 不加载宿主电脑上的未经审查扩展、skills、shell/file tools；只加载经审核的查询接口。
- 搜索使用 `pi-web-access` Pi 扩展；真正验证 Exa keyless / Pi 登录查询路线。
- 以标准结果对象返回来源，不暴露 Pi 的 Coding UI/行为给 Vivic。

**B. 降级：将 pi-web-access 单独作为受限本地 MCP 工具服务器**

- 仅暴露 `web_search / fetch_content` 的安全子集；无需完整 Pi agent 执行循环。
- 单独 MCP 模式与 Pi 扩展模式能力不同：Pi 特有的 ChatGPT 登录搜索/摘要等能力不可自动假设在 B 模式可用。
- 仍可尝试 keyless Exa 等支持的路由，按实测结果回显可用状态。**两者都失败时说明“当前联网查询不可用”，而不是强迫用户输入搜索 Key 或编造结果。**

### 6.3 工具安全要求

- 默认允许：`web_search(query)`、`web_fetch(httpsUrl)` 的受限包装，以及 Vivic 自己的卡片操作。禁止：shell、write、edit、read local file、Git clone、任意路径内容读取、抓取内网地址、任意第三方 MCP 工具自动加载。
- URL 严格 `https` 优先，阻止 localhost、loopback、private IP、DNS 解析到私网、重定向到受保护地址；限制正文大小、超时、频率、并发、下载类型。**不能仅用 URL 正则防 SSRF**；还需在实际请求/每次重定向边界验证。
- 网页正文视为非可信数据，不执行网页给出的指令；来源要保留并标记引用范围。
- 对外部工具返回的敏感内容或抓取失败进行脱敏/错误提示；禁自动抓取带登录状态的私有页面。

认证与模式详细见 `AUTH_SEARCH_PI.md`。

## 7. API Key、安全和隐私

Web 控制端展示密码型输入框。密钥只在本机可信 Node 后端暂存或保存在经过验证的安全存储；**绝不放 IndexedDB、localStorage、画布、日志、URL、展示页或提供给 LLM**。一键断开并清除。未启动本机服务时 Web 的部分离线画布功能仍可用，但需要密钥/查询的能力会明确提示不可用。

默认本机服务仅绑定 `127.0.0.1`；只允许受控 origin、CSRF/session 防护、本机认证与限流，不能让任何同源页面可无限制读取凭据。后期公网站点/会员化时，必须重新设计托管凭据、多租户隔离及计费。

如果用户选择 Pi 自身本机 OAuth，令牌管理由隔离的 Pi AuthStorage 负责；不得把完整令牌传进浏览器。登录回调需验证 state、授权范围，用户可退出和撤销连接。

## 8. 多画布持久化与有限上下文

- `Canvas = {id,title,version,cards,viewport,focusHistory,recentReferences}`；一个画布就是一个 Session。
- 默认只记当前画布卡片的展示字段、结构化数据、来源、坐标、重要别名、时间戳与少量近期引用信息。不做跨画布人格学习。
- IndexedDB 用于非秘密画布数据，支持迁移、导入/导出 JSON、恢复上次工作；敏感内容要有明确清除入口。
- 应用提供「清空此画布」「删除画布」「清除本地数据」，且删除可撤销/确认。
- 处理用户「刚才那个」优先根据焦点历史、创建顺序、卡片类型/语义别名判定；低置信度必须澄清。

## 9. 日夜主题与背景

- 工作态自动根据用户设置的本地时间段切换（初始建议 07:00–19:00 为 Day，可修改），手动 Light/Dark/Auto 覆盖；不强行依赖定位。
- 待机始终纯黑低亮度，与工作态日夜分离。
- 默认 Grainient，颜色需围绕 Orb 保证视觉延续。Vanta Clouds / Clouds2 可在性能/许可验证后加入主题选项。参考 `reference/atmosphere_original.html` 的慢速云雾与微光，**不复制该 HTML 页面的按钮、排版或控件**。
- 背景与 React Flow 画布处于不同层，避免画布缩放使背景拉伸；低端设备动态降质与 `prefers-reduced-motion` 需有效。

## 10. 开发阶段（严禁越级加功能）

### P0 · Visual Prototype / 技术可行性（必须先完成）

- Grainient 真组件与 Orb 真组件，无鼠标干扰；黑屏待机、呼吸、连续唤醒转场、灵动字幕。
- Assistant UI styled library 与 React Flow 同屏渲染 3 张真正 Minimal 卡（Countdown、Todo、Search）；Motion 平滑聚焦、缩放、删除/重排。
- 测试 Mac Safari/Chrome 的 WebGL、canvas、音频策略；拍摄真实动效录屏和静态参考截图；校验许可证。

### P1 · 可用的两页面画布

- `/control` + `/display`、同机 BroadcastChannel snapshot/patch、主控唯一写入者、断开重连、多画布保存恢复。
- 支持文字输入；卡片 registry、schema、动作 reducer、歧义澄清、撤销、图表/天气的静态样例演示必须明确标注 DEMO。

### P2 · 真实 AI / 搜索 / 语音

- StepFun BYOK 真调用与错误处理；受限 Pi 查询集成，至少一个**无需单独搜索 Key**且实测可用的 Search 路由。
- Winnow 优先策略路由（真实适配/对照验证）；StepFun 或 Pi 已连接模型生成结构化卡片；source 引用可信。
- 浏览器 PTT → Sherpaw ASR（性能允许时），预制短反馈、短字幕；KWS 唤醒作为附加验证，不得阻塞 P2 交付。
- Pi ChatGPT/Codex、Claude 登录作为**实验性功能**：允许实现可用 PoC，没通过授权/技术验证不可伪装为已支持。

### P3 · 真实生活数据与稳定性

- Weather、Note、Table、Chart、Countdown、Todo、Search 七种完整可用卡片；数据源可连时返回真实数据，未连时不冒充。
- 日历只读连接（权限明确）、网页预览、音乐/歌词等为后续增强；没有必要第一版一口气全做。
- 浏览器崩溃恢复、弱机流畅度、卡片数量压力、持续运行、断网降级、语音中断和视觉回归。

## 11. 验收标准摘要

1. 双窗口状态一致，任一动作只执行一次；Display 绝无设置/调试/聊天冗余元素。
2. Orb→Grainient 非硬切；字幕短暂且与语音事件一致；工作态无常驻 Orb。
3. Countdown `minimal` **只有数字**；所有卡片遵守字段白名单；镜头放大不会擅自显示描述。
4. React Flow 自动布局和聚焦不中断背景，卡片不会严重重叠；不确定目标先高亮并询问。
5. 有真实联网查询且无需**额外搜索 API Key**的实测路径，展示来源 URL 和抓取时间；失效时明确错误。
6. Pi `read/write/edit/bash` 等默认工具无法通过任何模型间接执行；外部 URL 输入受审计。
7. StepFun Key 和可选 OAuth Token 从不暴露到 Display/IndexedDB/日志；可以断开。
8. 多画布可导入导出及恢复，不丢失隐藏 sourceData。
9. 真正用指定开源组件，提供版本/许可证、真实截图和录屏；不凭口头声称「好看」过关。
10. `pnpm dev` 或一条等价命令启动 Web + 本地 API，首次安装说明清楚，未配置凭据时画布仍可使用。

逐项场景脚本和详细测试标准见 `ACCEPTANCE.md`。

## 12. 未来 Roadmap（不可偷跑）

- macOS 桌面宿主：双 Option 截图、系统级弹窗、跨屏传输动效。
- 电视浏览器 LAN 配对/WebSocket、原生 AirPlay / Chromecast 研究。
- 自定义卡片 SDK、经过许可的音乐/歌词接入、更多只读 MCP。
- 会员/公有云托管、账户和统一计费；Pi 订阅/OAuth 能否商用须单独法务和提供商协议确认。

## 13. 参考资料

- 用户视觉参考：`reference/atmosphere_original.html`（仅用作背景运动/配色参考）。
- `https://www.assistant-ui.com/elements/generative-ui`
- `https://reactbits.dev/backgrounds/grainient`
- `https://reactflow.dev/`
- `https://smoothui.dev/docs/components/siri-orb`
- `https://github.com/moeru-ai/sherpaw`
- `https://github.com/badlogic/pi-mono`
- `https://github.com/nicobailon/pi-web-access`

**此文档取代旧版 v0.5 中「Pi 仅研究、资料搜索必须配置独立 SearchProvider」的决策。** 旧版本仅作历史记录，不应出现在 Kimi 的实施上下文中。
