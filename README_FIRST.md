# 从这里开始

2026-10-23 追加：用户已启动手机线上接入、隔离服务器验收、跨平台本地运行三条线。手机新线上链路和StartLux/动态TTS已实现，服务器验证结果与具体限制见 [手机线上接入](docs/updates/2026-10-23-online-mobile.md)、[服务器验收](docs/updates/2026-10-23-online-server.md)、[本地运行](docs/updates/2026-10-23-local-runtime-next.md)。Mac按用户选择先交安装与自动验收，暂不实机；微调为小档开发候选，不自动替换正式模型。仍不正式发布或推送。

当前目标（2026-10-23）：先完善 Vivic 线上端的三步引导与隔离会话 API，交付可部署版本，本轮不发布。启动器/本地模型后续再做，已有成果保留；线上部署入口见 [部署说明](docs/online-deployment.md)。源码主仓库为 `ECdison6227/vivic-canvas`，集成分支为 `main`。

## 只读与你有关的入口

| 你要做什么 | 阅读 |
| --- | --- |
| 安装、启动、用 GitHub Desktop 提交 | [贡献指南](CONTRIBUTING.md) |
| 查看产品与运行地址 | [README](README.md) |
| 接手任务，使用 AI 编程 | [AGENTS](AGENTS.md) → [当前交接](docs/AGENT_HANDOFF.md) → 自己的任务单 |
| 确认已有能力与未完成项 | [实施现状](docs/implementation-status.md) |
| 看分工、范围和交付条件 | [团队任务边界](docs/TEAM_TASKS.md) |
| 决定后续功能顺序 | [本地路线](docs/LOCAL_ROADMAP.md)，按依赖程度分配 |
| 查某个模块的实现说明 | [文档目录](docs/README.md) |

## 当前约定

- 你重点优化核心流程、统筹接口与合并，也可以做新功能；两位伙伴可做 Landing、新卡片和依赖较少的新功能。
- 伙伴默认通过 fork 提 PR；每张任务单明确代码范围、接口和验收条件。中等依赖先定接口，高依赖由你牵头，避免互相等待。
- 用户页 `/`，设置 `/control`，展示 `/display`；本机使用 `5175/8787`，隔离浏览器测试使用 `5174/8788`。
- 模型凭据只在受控本机后端；自动化静音，不触碰个人画布。已有服务无需因切换 Agent 重启。
- 当前规则看根 [AGENTS.md](AGENTS.md) 和 [Git 约定](docs/GIT_WORKFLOW.md)。历史报告只供查证，不用于重做已完成阶段。

历史计划、旧交接和旧验收清单已收进 [归档](docs/archive/README.md)。原 v0.6 产品规格、生成契约及示例仍保留在 `Vivic_Kimi_Handoff_v0.6/`，其中旧设计须以现有代码和当前约定核对。
