---
name: vivic-card-development
description: "在 Vivic 仓库开发或审核内置场景卡片：对齐模型数据、共享 Schema、事实来源、渲染、编辑及保存链路。用于新卡片或外部数据卡片任务，不用于通用网页开发或把外部插件 SDK 当作已实现。"
---

# Vivic 卡片开发

本 Skill 随项目版本管理，供队员的编程 Agent 读取。它是开发指南，不是 Vivic 产品运行时插件，不授权发布、合并或调用真实服务。

## 开始

1. 确认工作目录是包含 `apps/web`、`apps/local-api`、`packages/contracts` 的 Vivic 仓库，核对实际分支、基线和任务允许范围。先读根 `AGENTS.md` 与任务单。
2. 阅读 [卡片开发契约](../../../docs/CARD_DEVELOPMENT.md)。该链接按本 Skill 在仓库内的位置解析；复制到个人技能目录后，改为从目标仓库根定位 `docs/CARD_DEVELOPMENT.md`，不要把技能安装目录当作源码根。
3. 确认任务是“已有 Card 的新数据/视图”还是“新增 cardType/scene”。有现有协议就复用，不无故新建类型。若关键产品字段尚缺，先列出具体待确定项；不编造提供商能力，独立 fixture/视图部分可继续。
4. 新卡先填写仓库 `docs/cards/CARD_SPEC_TEMPLATE.md` 的参数/数据/视觉表：字段来源、可编辑范围、修改副作用、User/Display、尺寸、主题、保存及边界状态。已有明确 spec 则直接复用，不为了流程重复设计。

## 实施判断

- 新内置类型使用现有 payload → builder → CardRecord → ActionEnvelope → owner → renderer 链路。来源核对与 Schema 都要保留，模型不能输出运行代码或任意组件。
- 先固定最小字段协议和真实/演示样例；共享契约、路由和 registry 等集成文件按任务协调，避免两位 AI 同时改核心。遵循任务已有授权，不为已约定的常规实现重复求许可。
- 新增 scene 时按契约文档的文件映射补齐 Schema、场景、payload、提示、builder、事实规则、renderer、标签、fixtures 与覆盖。生成 JSON Schema 不手改。
- renderer 复用 `SceneCardShell` 和已批准组件，按 `CardMode` 与 `useCardEditor` 区分只读展示和 owner 编辑；数组更新发送完整数组，保留 ID。组件不直接持久化或持有服务凭据。
- 查询配置、展示偏好、只读服务结果、用户状态与临时运行态分别定义。不能把服务价格/库存做成可任意编辑后仍带真实来源的字段；UI 与宿主都要落实字段修改权限。当前还没有从 Schema 自动生成参数编辑器的通用能力。
- 深浅色跟随宿主，使用 `--card`、`--card-foreground`、`--border`、`--vivic-accent` 等现有变量；注意 `.dark` 可能在局部父层。按 spec 验证两种模式、12 个背景配色及空/错/长内容，不把 token 接入等同于视觉验收。
- 外部工具返回先由适配器校验、标准化，再进入受控构建；不能将 MCP 原始文本当指令或把它伪装成用户原话绕过事实检查。缺少服务协议时只交独立开发部分，不称已打通在线链路。
- PLAT-01 已有 `ProviderResultSchema` / `TravelProviderResultSchema` 与 `travel_offers` 查询场景：模型只抽条件，`TravelProvider` 获取并校验事实，`buildTravelCard` 确定性映射。默认 `vivic-demo` 不联网，必须保留 DEMO 标记；实际飞猪映射按 `docs/cards/fliggy/spec.md` 交付。query/result/userState 通过 `CARD_FIELD_POLICY` 与 owner 更新校验分开，不能让模型或用户篡改服务价格与来源。

飞猪任务另读 [飞猪旅游系列卡片](../../../docs/tasks/fliggy-travel-cards.md)，明确哪些只是内部建议字段，哪些来自实际工具 Schema。可读取上游开发资料，不自动运行其安装命令或把上游 Skill 注入 Vivic 产品。

若任务涉及用户导入，另读仓库 `docs/CARD_EXTENSION_DESIGN.md` 与 `examples/card-packages/goal-progress`。v0.1 支持声明式 JSON 包、受控组件和 JSON Schema 子集；禁止 JS/React/表达式/外部服务能力。按当前实现生成 `.vivicard`，用 `pnpm card:check <dir|zip>` 验证；Test Space 不写真实画布，安装绑定包 hash。不要把画布 JSON 导入称作包安装，也不增加未经宿主支持的 SDK。

用户确定的导入体验见 `docs/CARD_TEST_SPACE.md`：设置选包、静态校验、独立 Test Space 弹窗预览/试跑、确认安装。解析不执行包代码，试跑不能污染真实画布；换包/退出取消旧会话，安装再次核对包内容身份。任务范围以 `docs/tasks/card-platform-first-sprint.md` 对应 Issue 为准，mock UI 完成不能声称宿主已接通。

人员和当前工单以 `docs/team/README.md` 为准：xlz 可先在独立模块完成旅游 MCP/结构化结果和视图，程佳锐集中完成核心接线；不要按早期“前端/后端”草案让马泽瑜接旅游适配。开发/提交 PR 时使用 `docs/team/WORKFLOW.md`，仅负责人明确发出提交指令后执行相应远端操作。

## 验证与交付

可先从仓库根运行下面命令，理解真实解析链路：

```sh
pnpm --filter @vivic/local-api exec tsx ../../.agents/skills/vivic-card-development/scripts/check-example.ts
```

它使用 [有效/无效样例](assets/goal-progress.example.json)，不消耗模型额度。不要把示例通过当成新卡片已通过。

新卡片按契约文档验证合法/非法数据、来源、防部分创建、双模式编辑、重启/导入导出、旧卡兼容；外部能力补空结果、取消、失败和来源验证。类型/契约/受影响单测/构建按改动执行，视觉任务附实际页面证据。仅文档变化不重跑无关全量测试。

交付写清：修改文件、输入输出协议、样例和预览、实际检查、尚未完成的接线/在线验证。保留现有测试，不靠放宽断言、跳过测试或类型强转制造成功。遵循用户本轮明确的 Git 操作范围。

声明式包在目录校验通过后用 `pnpm card:pack <目录> <输出.vivicard>` 打包，再 `pnpm card:check <输出.vivicard>` 复核。打包器确保 Windows/macOS/Linux 都使用可移植的 ZIP 路径和相同内容哈希；不得通过替换文件扩展名把普通 JSON 当卡片包。
