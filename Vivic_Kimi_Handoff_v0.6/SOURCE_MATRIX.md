# Vivic v0.6 — 核实资源和未验证假设

本清单区别 **「上游文档确实提供」**、**「用户已经确定偏好」** 和 **「项目内尚未证明可用」**。开发 Agent 不得把三者混同。

| 项目/引用 | 上游明确描述 | 本项目需要实测的点 | MVP 选用等级 |
|---|---|---|---|
| [Assistant UI Generative UI](https://www.assistant-ui.com/elements/generative-ui) | 可直接调用 `renderGenerativeUI(spec, styledGenerativeUILibrary)`；样式需要 shadcn registry 安装 | Minimal props、真实外观与 React Flow 节点尺寸 | LOCKED |
| [React Bits Grainient](https://reactbits.dev/backgrounds/grainient) | 动态背景组件与视觉预设 | 禁鼠标交互、白天夜晚配色、GPU 质量与许可证 | PREFERRED-POC |
| [SmoothUI Siri Orb](https://smoothui.dev/docs/components/siri-orb) | conic gradient Orb，AI 状态与 audio amplitude | 各状态是否适配 Vivic、实际许可与动画扩散 | PREFERRED-POC |
| [React Flow](https://reactflow.dev/) | 缩放、平移、节点操作；官方有 layout/focus/position animation 实例 | 动态尺寸、极简卡容器、layout、性能 | PREFERRED-POC |
| [Motion](https://motion.dev/) | React 动画和布局转场 | 大量节点与 backdrop 混合时性能 | LOCKED |
| [Sherpaw](https://github.com/moeru-ai/sherpaw) | ASR、VAD、KWS 的 Sherpa-ONNX WASM 包 | ASR 中文准确率、KWS 唤醒/浏览器权限、模型加载性能 | PREFERRED-POC |
| [Pi SDK](https://github.com/badlogic/pi-mono) | AgentSession、AuthStorage、模型注册和工具接口；默认 Coding CLI 提供读写/终端 | 彻底隔离默认工具、资源/扩展加载与授权 | PREFERRED-POC |
| [Pi Web Access](https://github.com/nicobailon/pi-web-access) | `web_search` 与 `fetch_content`；自述通过 Exa MCP 零 Key 搜索；Pi 扩展下可尝试 Codex 登录搜索 | 用户网络上是否成功、有无额度/隐私限制、恶意 URL 防护 | **MVP 优先接入** |
| [Pi Web Access Standalone MCP](https://github.com/nicobailon/pi-web-access#use-from-other-agents-mcp) | 单独 stdio 工具服务，提供搜索抓取能力 | 与 Pi 扩展**不同**；Pi 特有的订阅 Auth 查询不可直接继承 | FALLBACK |
| [Vanta.js](https://github.com/tengbao/vanta) | Clouds/Clouds2/FOG 等动态背景 | 是否比 Grainient 更符合视觉与性能要求 | RESEARCH |
| [StepFun 平台](https://platform.stepfun.com/) | 模型 API 平台 | 用户现有 Plan/API 具体模型、额度、JSON/多模态能力 | REQUIRED BYOK, capabilities POC |
| **Winnow（用户选型）** | 用户根据实际测试认为最优 | 模型/源码的准确项目名、API、部署方式与性能未在本交接中独立验证 | DEFAULT INTENT CANDIDATE |
| `reference/atmosphere_original.html` | 用户提供的 WebGL 雾与柔光示例，时间驱动、包含六种模式 | 只作美术和运动参考，不直接搬入展示页 | USER REFERENCE |

## 特别说明

1. **Pi Web Access 上游称“zero config”不等于我们已完成用户机器上的验证**。如果 Exa 等服务不可用，前端应有清楚、诚实的失败状态。
2. **不接受**“Pi 账号登录自动等于任何 GPT/Claude API 搜索”的假设；认证、模型调用、Web Search 是三个能力，可用性逐一探测。
3. Pi 原生 Coding 工具的禁用不能只靠 system prompt：必须在进程/SDK 工具注册层阻断。
4. 搜索 MCP 虽在 Pi Web Access 内部使用，但用户端**无需自行安装和配置额外 MCP**，这是期望体验；内部供应链的许可证/依赖照常审计。
5. 包版本、LICENSE、模型权重许可证和单独素材条款必须由实现 Agent 在安装时锁定，并记录在 `DEPENDENCIES.lock.md` 或等价文件。
