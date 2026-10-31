# 卡片开发契约与 Skill 验证

日期：2026-10-20。基线 `c20a217`，分支 `docs/card-development-contract`。本轮只新增开发说明、Skill/样例与飞猪任务交接，更新文档入口；没有修改产品运行代码、依赖、工作流或生成契约。

## 实际检查

| 检查 | 结果 |
| --- | --- |
| skill-creator `quick_validate.py .agents/skills/vivic-card-development` | 通过；名称、frontmatter 与必要字段合法 |
| Skill 配套 `check-example.ts` | 通过；实际 payload 解析、映射、事实校验、CardRecord/ActionEnvelope、序列化、更新形状与批量拒绝 |
| 文档中的两段 JSON | 与机器样例和真实 builder 一致（ID 使用固定 TEST 值），完整 CardRecord 通过运行时 Schema |
| API `tests/scenes.test.ts`、`tests/wire-json-schema.test.ts` | 93 项通过 |
| Web `src/cards/__tests__/sceneCards.test.tsx` | 67 项通过 |
| `pnpm contracts:check` | 两份生成契约一致，无需重新生成 |
| 文档/Skill 相对链接、`git diff --check` | 通过；忽略目录内历史证据引用仍按原约定保留 |

本轮定向单测合计 160 项通过。未重跑无关全量测试/构建，未做真实浏览器验收，也未创建卡片写入用户画布。前端检查仍有既有 Vite `__dirname` 的未来兼容提示，未因本轮解决。

Python 验证器使用机器已有的 3.12.15；PyYAML 6.0.3 只装到忽略的 `.cache/skill-validation-deps`，没有更改项目依赖。测试日志保存在 `.cache/card-dev-api-check.log`、`.cache/card-dev-web-check.log`。

## 能证明什么

交接文档示例符合当前真实解析/构建契约，Skill 格式有效，所引用的已有场景行为通过定向回归。它不证明 Skill 在任何 AI 上都能自动发现，也不证明任何未来新卡片能直接导入。

飞猪相关结论仅来自 [官方概览](https://flyai.open.fliggy.com/docs/overview)、[快速开始](https://flyai.open.fliggy.com/docs/quickstart) 与 [官方链接的 Skill 仓库](https://github.com/alibaba-flyai/flyai-skill)。未安装 FlyAI、未调用真实 MCP；工具 Schema、传输/鉴权、实际响应及账户能力仍需按任务单核对。

当前尚未提交或推送。开发规范须经 PR 合入后，队员再从共同基线领取任务；具体飞猪卡片类型和负责人仍待任务分配。

## 参数、视觉与导入方向补充

同日用户追问后，新增单卡设计表与扩展设计，补入字段归属/编辑副作用、现有 UI 层次与主题变量、12 配色/双模式验收、已有卡复用和未来导入路径。证据来自 `index.css`、`SceneCardShell`、`sceneCards.css`、`VivicCard`、`vivicGUILibrary`、`CardActions` 与实际宿主容器。

这次追加仅改文档/Skill，复核格式与链接，没有重新运行上述 160 项测试或新增视觉实测。未来包目录只是候选格式；自动表单、卡片导入宿主、SDK/主题桥与迁移能力未实现。MCP Apps 只核对了官方协议说明，不是本轮已选定或安装的方案。

随后按用户确认的设置导入 → 校验 → Test Space 弹窗预览/试跑 → 安装流程，补产品规格与 CORE-01/FE-01/FE-02/BE-01 任务草稿。此次同样仅做文档、链接与 Skill 格式验证；没有创建 GitHub Issue、分配真实账号或实现界面/宿主功能。
