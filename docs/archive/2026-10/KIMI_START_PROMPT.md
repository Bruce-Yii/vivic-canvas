> 历史归档：原路径 `Vivic_Kimi_Handoff_v0.6/KIMI_START_PROMPT.md`。记录当时的需求与验证，不作为当前操作指令。当前入口：[README_FIRST](../../../README_FIRST.md)。

# 交给 Kimi K3 的启动指令（可直接复制）

你现在是 Vivic 的主开发 Agent。请首先读取本项目目录中的：

1. `README_FIRST.md`
2. `AGENTS.md`
3. `PRD.md`
4. `COMPONENT_LOCK.md`
5. `ARCHITECTURE.md`
6. `AUTH_SEARCH_PI.md`
7. `CARD_CONTRACT.md`
8. `MOTION_AND_VISUAL_QA.md`
9. `ACCEPTANCE.md`
10. `contracts/*.json`
11. `reference/atmosphere_original.html`

**所有旧版 v0.1–v0.5 决策已被 v0.6 替代。** 开发严格遵守文档，不自行扩大范围。

你的任务是开发一款 Web First 的智能画布 Vivic，界面核心是黑屏 Orb → Grainient 扩散 → 极简卡片组成的无限画布，用户用文字/语音操作，双窗口 `/control` 和 `/display` 同步。AI 查询使用 StepFun 与**受限 Pi + pi-web-access**（优先零额外搜索 API Key），**完全禁止 Pi 的 Coding 工具**。

先做 Phase 0：真实导入 SmoothUI Siri Orb、React Bits Grainient、Assistant UI styled Generative UI、React Flow、Motion，完成可运行视觉原型并提供真实截图和动效录屏。若现成组件不兼容，要提供明确证据与替代品比较，禁止自己重画 Orb、卡片、背景或画布引擎。视觉合格后才继续两页状态同步，再接真实 Pi 搜索、StepFun、Winnow 和 Sherpaw。

卡片必须极简，尤其 Countdown 默认**只有时间数字**；Display 不出现任何聊天框、设置按钮、导航栏、品牌说明和其他多余元素。不要用 lorem ipsum 或编造的联网数据证明功能完成，演示数据必须标注 DEMO。

请把每个阶段的工作拆成具体可验证任务，逐项实现并运行自动化测试；提供依赖库链接、固定版本、许可证和已完成/待开发的真实报告。不得跳过视觉验收，也不得因为“AI 自动生成 HTML 更方便”而放弃结构化 Action。

用户主要在 macOS 用浏览器；不做原生系统功能。演示端第二窗口由用户自己拖到 HDMI 扩展屏。用户个人使用，未来 OAuth 会员商业化只是待验证研究，不应在第一版假设授权可用。

如果某项外部模型登录、Winnow 接口或零 Key Search 路由由于授权/环境/配额无法通过验证，请准确报告 BLOCKED，并继续完成其余不依赖的功能，不允许伪造成功状态。
