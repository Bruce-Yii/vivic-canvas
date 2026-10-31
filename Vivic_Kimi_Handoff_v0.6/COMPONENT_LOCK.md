# Vivic v0.6 — UI / Engine 组件锁定表

定义：**LOCKED** 必须使用该生态/组件能力；**PREFERRED-POC** 优先采用，真机/许可/兼容验证后锁具体版本；**RESEARCH** 仅备用或后期实验。**不代表已测试通过**。

| 模块 | 指定项目/实际入口 | 状态 | 必须验证的事情 |
|---|---|---|---|
| 结构化卡片（内部） | [Assistant UI Generative UI](https://www.assistant-ui.com/elements/generative-ui) `@assistant-ui/generative-ui` | LOCKED | **必须安装 styled registry**；建议 standalone `renderGenerativeUI(spec, styledGenerativeUILibrary)`，无需渲染 Chat Thread。自定义倒计时数字组件仅可用批准的展示容器。 |
| UI 基础/配置页 | [shadcn/ui](https://ui.shadcn.com/) + [Radix UI](https://www.radix-ui.com/) | LOCKED | 用已有 Sheet/Dialog/Input/Tabs/Select/Tooltip，禁止自画。 |
| 基础交互动效 | [Motion](https://motion.dev/) | LOCKED | 入场、退场、布局过渡、focus、字幕、动画取消/减少运动。 |
| 图标 | [Lucide](https://lucide.dev/) | LOCKED | 不画自定义基础 SVG icon。 |
| 默认工作背景 | [React Bits Grainient](https://reactbits.dev/backgrounds/grainient) | PREFERRED-POC / DEFAULT LOOK | 验证包/源码、实际 props、配色、WebGL 兼容与许可；关闭指针主导动效；不允许用 Liquid Ether 替代。 |
| 云雾背景 | [Vanta.js Clouds / Clouds2](https://github.com/tengbao/vanta) | RESEARCH | 对比用户 HTML 烟雾节奏与真实性能；不能提前叠加多个背景实例。 |
| 待机 Orb | [SmoothUI Siri Orb](https://smoothui.dev/docs/components/siri-orb) `npx smoothui-cli add siri-orb` | PREFERRED-POC | 核实 npm/CLI 安装、API/AI 状态、音量驱动、依赖许可证和造型是否符合参考；禁止自绘 Orb。 |
| Orb 备选 | [VoiceOrbs](https://github.com/amunozdev/voiceorbs)、[React Bits Orb](https://reactbits.dev/backgrounds/orb) | RESEARCH | 比较 Idle/Listening/Thinking/Done 状态及黑底外观，未获批准不自行换。 |
| 无限画布 | [React Flow](https://reactflow.dev/) `@xyflow/react` | PREFERRED-POC | 动态卡片尺寸、Node Collision、smooth fitView、缩放、拖拽、pin 与 backdrop 性能。失败须先 ADR。 |
| 自动布局 | [ELK.js](https://github.com/kieler/elkjs) + React Flow layout 示例 | PREFERRED-POC | 自动避让不保证物理“挤压”；使用规则/已有布局计算即可；不能引入通用物理引擎。 |
| 图表 | [Recharts](https://recharts.org/) 或 Assistant UI 支持的已样式化 chart | LOCKED CATEGORY | 图表样式统一、数据正确，不手绘 SVG 曲线/图例。 |
| 本地 ASR/VAD/KWS | [Sherpaw](https://github.com/moeru-ai/sherpaw) | PREFERRED-POC | WASM bundle、模型下载、Safari/Chrome、CPU/Worker；没有稳定结果时文字/PTT降级。 |
| 结构化校验 | [Zod](https://zod.dev/) + JSON Schema | LOCKED | Action / Card payload 白名单，不执行不认识的字段。 |
| Web 双窗口状态 | 原生 `BroadcastChannel` + IndexedDB | LOCKED ARCHITECTURE | 控制者独占写入、快照/补丁、掉线重同步；同源同存储分区才可用。 |
| 图像/网页缩略预览 | 后期研究 Microlink / metascraper / screenshot service | RESEARCH | P1，不可绕过第三方页面权限抓私有网页。 |

## 必须真正安装 Assistant UI 的样式

官方文档指出仅安装 `npm install @assistant-ui/generative-ui zod` 得到的是**未加视觉样式的语义 HTML**。必须在项目中安装对应的 shadcn registry 项，如：

```bash
npx shadcn@latest add @assistant-ui/generative-ui
```

在所选 Radix/Base UI 风格配置下确认生成的 `styledGenerativeUILibrary` 文件和 CSS tokens，再实测 standalone `renderGenerativeUI`。

注意：Assistant UI 提供结构化内容词汇表，**不是**无限画布引擎，也**不意味着**现成 Todo/Countdown 视觉一定符合 Minimal。本项目可组合其已批准的 Card/Text/List/Table 组件，但不得为了“丰富”自行加提示文本。

## Render 与动画分层

- 背景：Viewport 底层独立 Canvas/WebGL，**不在 React Flow transform 里**。
- 画布：React Flow 节点位置、pan/zoom；卡片用已批准 Assistant UI/shadcn 实现。
- Overlay：字幕、轻量通知、偶发 Orb，画布移动时保持视口锚定。
- Motion Director 只编排现成组件 API，不重复实现动画底层。

## 许可和依赖要求

Kimi 必须为每项列出锁定 git SHA/package version、源 URL、许可证文本、商业和素材再分发限制。尤其 React Bits 许可证可能带额外条款；SmoothUI 组件许可证应核实组件源码；Sherpaw WASM 和所选 ONNX 模型权重许可证单独核实。现成组件**许可未经确认，不能视为无限制商业可用**。

用户上传 `reference/atmosphere_original.html` 只作为**运动与配色基准**，不是规定必须把它的整个页面嵌入产品。
