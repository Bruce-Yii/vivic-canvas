# 当前实施状态

2026-10-22 集成分支更新：本地 Windows 分发包、固定 Qwen 决策运行器、手机正式 owner 接线与本人服务器扫码中继已实现并通过隔离浏览器闭环。详见 [本轮更新](updates/2026-10-22-local-runtime-mobile.md)；尚未合并主分支。下面 10/19 基线保留作历史，不能再将「Kev 是唯一决策」「尚无手机接线」视作此分支现状。真实模型覆盖有限，实体安卓与原生 App 尚未验收。

更新：2026-10-19。以当前源码和实际测试结果区分“已实现”“已验收”“待开发”；历史报告不自动代表本机新版本通过。

## 已有源码实现

| 模块 | 当前能力 | 入口 |
| --- | --- | --- |
| 用户与展示 | `/` 输入与操作，`/control` 设置，`/display` 展示；用户页/设置共享 owner | [用户页说明](user-page-20261017.md) |
| 外观 | 现有 SmoothUI Orb、Assistant UI、React Flow、Motion、Radix/shadcn；三页共用流光以太、6 深 + 6 浅配色 | `apps/web/src/components/` |
| 画布 | 多画布、IndexedDB、导入导出、同浏览器双窗同步、拖动/固定、布局、删除/撤销 | [画布交互](canvas-interaction.md) |
| 卡片 | 20 种场景与基础便笺/天气/搜索/表格等；数据由共享契约校验 | [场景卡片](scene-cards-20261017.md) |
| 模型 | StepFun Coding Plan、GPT/Pi OAuth；连接探测、选择、取消和错误恢复 | [连接稳定性](llm-connection-stability-20261017.md) |
| 信息来源 | 天气、搜索和受限网页正文；结构化数据与来源校验 | [数据适配](data-providers.md)、[搜索回退](search-fallback-20261016.md) |
| 提醒 | 纯计时、事项、日期/重复/有限条件、到期退场与历史；由 Control 运行时调度 | `apps/web/src/reminders/` |
| 图片 | 当次显式发送的图片分析；卡片媒体按已有场景能力处理 | [输入图片](image-input.md)、场景卡片说明 |
| 语音 | 独立 STT/TTS 配置、预录短反馈、本地 ASR/VAD/KWS 自动下载；默认唤醒词 `vivic`，监听需手动开启 | [语音架构](provider-voice-architecture.md)、[本地语音](local-speech.md) |
| 官网 | 本地演示源码和线上 HTML 补丁工具保留；本轮不改发布来源 | [官网当前说明](website-beta-only.md) |

## 本轮验证及限制

Windows 自动化基线：1,590 项通过，3 项外部条件测试跳过；契约、类型检查和构建通过。详见 [2026-10-19 验证](verification/local-development-20261019.md)。新建的 CI 配置尚未在 GitHub 运行。

真实模型账号/额度、麦克风/听感、中文输入法、外接屏与实际 GPU 体验需按任务实测；旧记录不能替代本机结果。当前提醒不承诺所有浏览器关闭或系统睡眠时准点执行。BroadcastChannel 不提供跨设备同步。

当前代码中的 Kev 决策仍是默认关闭的实验，相关准备/评测脚本保留。用户最新目标已改为 API/本地决策模型的正式接入，默认优先配置并使用、允许显式关闭；该目标尚未实现，见路线 L04 和 [JevHarness 评估](research/jev-harness-assessment.md)。2026-10-21 按用户要求移除音色复刻设置及接口，忽略旧偏好中的复刻音色；普通音色选择、试听和输出设备设置保留。历史评测结果保留，不自动开展新下载、录音或试音。

## 尚待开发

统一模型连接及通用自带服务、外部 Card 的安装宿主与 SDK/开发 Skill、空间模板、通用 MCP、持续刷新、有限联动与空间快照见 [本地路线](LOCAL_ROADMAP.md)。已有 JSON 导入导出和内置 Card 不等于外部插件生态已完成。

这些新功能按 [核心依赖与任务边界](TEAM_TASKS.md) 分配：维护者重点优化核心流程，伙伴可承担 Landing、新卡片和独立功能，维护者也可做新功能。部署、多账号、配额与收费留在本地版验收之后。
