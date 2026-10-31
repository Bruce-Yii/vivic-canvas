# 按任务领取参考资料

## 共用必读

先读根 [AGENTS](../../AGENTS.md)、[贡献指南](../../CONTRIBUTING.md)、[工单/PR 流程与提示词](WORKFLOW.md)，再读自己的 Issue，不要求每个 Agent 一次加载全部历史资料。

| 任务 | 必要资料 | 已有/仍缺 |
| --- | --- | --- |
| 飞猪卡片 | [开发契约](../CARD_DEVELOPMENT.md)、[单卡表](../cards/CARD_SPEC_TEMPLATE.md)、[Skill](../../.agents/skills/vivic-card-development/SKILL.md)、[飞猪任务](../tasks/fliggy-travel-cards.md) | 规则/运行样例已有；首个场景的真实工具/字段、连接权限还需核对 |
| 旅游视图参考 | `apps/web/src/cards/scene/views/ComparisonCardView.tsx`、`WeeklyScheduleCardView.tsx`、`SceneCardShell.tsx`、`sceneCards.css`、`fixtures.ts` | 可复用布局/主题/组件，实际数据不自动适配 |
| 新用户/设置 HTML | [Hark 适配说明](../references/hark-for-vivic.md)、当前 `ControlApp`、`BackgroundSettings`、`LocalDecisionSettings`；会议范围见 [核对表](MEETING_ALIGNMENT.md) | 聊天/卡片风格研究已有；完整 Hark 设置/引导样例仍缺，不能编造原站行为 |
| 决策模型 | [本地决策现状](../local-decision.md)、[JevHarness 评估](../research/jev-harness-assessment.md)、[便携评测包](../../scripts/decision-model/portable-benchmark/README.md)、`apps/local-api/src/decision/` | 现有代码与283条合成评测已有；马泽瑜新结果/分支、xlz测试结果尚需交接 |
| 本地启动器 | `scripts/dev.mjs`、`apps/local-api/src/config.ts`、`decision/manager.ts`、[语音职责](../provider-voice-architecture.md)、[本地语音](../local-speech.md) | 开发启动与本地模型入口已有；面向用户的可选模型服务启动器仍需定义，不把二者混为一物 |
| 包宿主/试跑 | [包设计](../CARD_EXTENSION_DESIGN.md)、[Test Space](../CARD_TEST_SPACE.md)、`packages/contracts`、`cards/scene/cardContext.ts` | 设计草案已有，运行协议/导入安装未完成 |

## 飞猪参考

优先核对 [官方概览](https://flyai.open.fliggy.com/docs/overview)、[快速开始](https://flyai.open.fliggy.com/docs/quickstart)、[官方 Skill 仓库](https://github.com/alibaba-flyai/flyai-skill)。开发者工具调用成功不等于 Vivic 已接入；CLI 子命令不应被猜成 MCP 工具名。

不要把 API Key 发到任务评论、截图、代码或群聊。用本人/团队授权的连接做验证，只提供脱敏样例与请求依据。没有真实权限时可交 mock 适配与失败记录，不能写“真实机票/酒店已查通”。

## 需要程佳锐提供的交接项

| 资料/决定 | 给谁 | 状态与用途 |
| --- | --- | --- |
| 合入后的规则/Skill 基线 SHA、实际 Issue 链接 | 两人 | 当前本地草案已准备，尚未合入；发布后从同一 main 开任务分支 |
| Hark 资料索引与可分享设计摘要 | xlz | 本轮已找到公开研究仓库并整理摘要；不打包原始聊天 DOM/截图或字体文件 |
| 选定旅游场景、官方赛道与截止链接 | xlz | 会议截止存在歧义；作为演示范围与排期依据，不能猜官方日期 |
| 首张卡片字段与接入方式 | xlz | 可先交独立 PoC，集成前由程佳锐固定最小契约，不需等整个 SDK |
| 教程与设置顺序、模型配置 UI 的真实支持范围 | xlz | 原型可比较方案，产品接入前需确定；订阅只展示“待订阅” |
| xlz 已有模型测试结果、配置和设备信息 | 马泽瑜 | 本轮未找到或收到真实结果文件；不要让其重新猜测/重造结果，现成评测包先可用 |
| 马泽瑜当前分支/模型进度 | 程佳锐 | 会议只说“进行中”，本轮不能核实；开始任务先盘点已有工作 |
| 两位成员 GitHub 用户名 | 工单维护者 | 用户已确认：xlz=`franzkotkowski330-collab`，马泽瑜=`Shenbeijc`；线上 assignee 仍待创建 Issue 时选择 |

压缩包只包含本轮可用任务资料、Skill/样例和必要评测文件。完整会议原件、私有研究原件、账号凭据、缓存与模型权重不需要发给开发 Agent。
