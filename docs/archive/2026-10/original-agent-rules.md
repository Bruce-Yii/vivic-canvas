> 历史归档：原路径 `Vivic_Kimi_Handoff_v0.6/AGENTS.md`。记录当时的需求与验证，不作为当前操作指令。当前入口：[README_FIRST](../../../README_FIRST.md)。

# AGENTS.md — Vivic v0.6 最高优先级开发规约

> 本文件对 Kimi、DeepSeek、Codex、Claude 等所有开发 Agent 同样适用。**不得因功能能跑而降低视觉标准，也不得因为现成组件 API 不熟就直接手写替代。** 先读 `README_FIRST.md` 与 `PRD.md`。

## 1. 产品和范围红线

1. 只做**Web 应用**；一个代码库包含 `/control` / `/display`，可选 `/` 单页模式。禁止 MVP 自发开发 Electron、Tauri、原生 macOS、全局快捷键、屏幕截图服务、会员支付。
2. 产品是**生活/思路整理助手**，不是 Coding Agent。禁止文件系统工具、终端、代码自动修改、依赖安装代理、浏览器自动控制用户电脑。
3. 画布是 Session，卡片是上下文。**不做长期个人记忆**。
4. Display 不允许聊天主窗、调试控制台、固定菜单、持续显示的 Assistant 名称、模型/Token 标识或提示文案。`/control` 的配置入口不能流入 Display。
5. 模型输出只允许 `ActionEnvelope` + 受控 props / sources；禁止运行模型生成 HTML、JavaScript、CSS、任意 React 代码、动态 import、eval。
6. 不得在 Demo 中把虚构天气、搜索结果、数据图表伪称为实时数据。演示数据须清晰标注 DEMO，仅用于视觉原型。

## 2. “只能用现成组件”的执行细则

- 查 `COMPONENT_LOCK.md` 中 **LOCKED / PREFERRED-POC / RESEARCH** 等级；选定的库需**真实安装和使用**，不可声称安装却手工模仿。
- UI 基础：shadcn/ui + Radix；卡片主体：Assistant UI Generative UI **Styled**；动画：Motion；图标：Lucide；默认背景：React Bits Grainient；待机 Orb 优先 SmoothUI Siri Orb；画布优先 React Flow；图表复用现成图库。
- **禁止自绘**：Siri 球、眼睛、通用卡片框架、基础按钮/开关/输入、主画布 pan/zoom、常见图表、背景流体 Shader、基础图标。
- 如果某个组件难以匹配极简规范，可通过**既有组件的公开 API、主题 Tokens、局部包装层/受控字段**进行微调；不允许换成另一个独立设计系统。
- 产品特有的 Orb→Grainient 扩散、跨层 Motion Director、Card Registry、Action Reducer、Pi/Web 适配器可**少量自研胶水代码**；禁止藉此重造动画/画布框架。
- 更换批准组件前，必须有 ADR：原组件截图/录屏、确切问题、现成替代品、license、性能与方案选择；不得静默替换。

## 3. 卡片必须极简（不可商量）

- Countdown Minimal 默认只有数字，例如 `12:45`。无「距离结束」「你还有」「继续加油」「开始/暂停按钮」「AI提示」等额外内容。交互可通过用户语音、鼠标悬浮或 Control 进行。
- Weather Minimal 仅温度/天气 icon；Todo Minimal 仅任务文本/完成状态；图表仅必要刻度/坐标和数据。
- `displayProps` Schema 严格拒绝未知字段；`description/footer/advice/motivation` 不能从模型响应进入 Minimal 卡片。`sourceData` 保留供后续引用但不自动显示。
- `canvas.focus` 不能擅自变更卡片数据密度。语音说「第二条值得注意」→ 高亮第二条，而不是添加长篇解释。

## 4. 动效与视觉验收红线

- Standby 黑底 Orb → Awakening 连续 reveal → Workspace Grainient → Focus 平滑镜头运动；无硬切、突然闪屏和廉价 CSS 乱动。
- Orb 工作态 C 方案：通常融合/消失，仅说话或表达状态短暂出现。
- 背景时间驱动、默认无明显鼠标交互；不能替换成 Liquid Ether。
- 字幕仅语音需要时浮现，不是聊天气泡。设置、模型名、debug 必须隐藏。
- 所有视觉里程碑交付真实浏览器截图与录屏，且与参考截图做差异审查。打开 devtools 表明真实库已挂载，不能截图伪装。
- 必须支持 `prefers-reduced-motion`、较弱 GPU 降级，紧急提醒禁高频闪烁。

## 5. Pi 和资料查询安全规则

- `pi-web-access` 搜索/抓取是 **P2 首选实现**；优先验证 Exa 无 Key 及 Pi 模型已有授权可用的查询方式，不能说“任何模型账号登录都有搜索服务”。
- 禁止启用 Pi 默认 `read/write/edit/bash`。显式传递 `tools: []` 或仅批准 Vivic Tool Adapter；禁止未经批准的 extensions/skills 自动加载，按 SDK 最新 API 真正隔离。
- 必须审查 `pi-web-access` 的 fetch 功能；对外只开放经过包装的 `web_search`、`fetch_content` 安全子集。尤其禁止本地路径/内网地址、Git clone 等扩展功能。
- Pi Extension 与独立 MCP server 是**不同模式**，Codex 登录搜索能力不通用。若 Pi 扩展失败，可降级单独 MCP 搜索，但不对用户强制索取搜索 Key。
- API/OAuth 凭据只保存在受控本机后端（或授权安全存储），不能进浏览器 storage、Display、日志、画布、聊天上下文。工具返回网页必须按非可信数据处理。
- 实际权限/条款及计费需实测；个人使用可 PoC，不对未来会员作商业化承诺。

## 6. 质量门禁（每阶段必须）

- **Phase 0**：真实 Orb/Grainient/Assistant UI/React Flow 集成演示、截图、录屏、许可证、性能记录。
- **Phase 1**：双窗口状态同步，极简卡片/动作/schema 单测，导出导入与恢复。
- **Phase 2**：真实 Pi 搜索 + 来源 + StepFun 模型 + Winnow 优先路由 + 浏览器语音/短反馈；没有服务时清晰报错。
- **Phase 3**：真实天气/图表等扩展，压力/断网/长时间测试。
- 不得在任何 Phase 通过之前增加音乐、复杂 MCP、会员、桌面端来“充实产品”。

## 7. 文档和提交要求

每个里程碑必须给出：`(1)` 已完成 / 未完成 / 实验项清单，`(2)` 组件来源+锁定版本与许可证，`(3)` 浏览器截图与交互录屏，`(4)` 安全/性能事实，`(5)` 可重现测试命令，`(6)` 与验收条款的对应关系。

出现不符合用户审美的默认样式，先调整经批准组件的 Tokens 和排版，不得添加大段文案或独立原创装饰。Kimi 必须在开始编写重大 UI 前明确展示所采用的 Orb、背景和三种卡片样例。
