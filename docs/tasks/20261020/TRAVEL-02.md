# [TRAVEL-02] 飞猪旅游系列：实现卡片视图、参数编辑与独立预览

- 负责人：xlz；GitHub：`franzkotkowski330-collab`（用户已确认；线上 Issue 分配尚未执行）
- 优先级：P0；状态：工单草稿，未创建线上 Issue
- 建议分支：`feat/fliggy-travel-cards`
- 时间：与 23–24 日旅游计划配合；先交一个场景，勿一次铺全旅游品类
- 来源：PDF p3/p7–8；表格 r6/r18；用户本会话的参数/主题要求
- 依赖：[TRAVEL-01](TRAVEL-01.md)、[PLAT-01](PLAT-01.md)

## 目标

按已固定数据结构做用户能看懂、可操作的旅游卡片，兼容 User/Display 和深浅色。

## 修改范围

apps/web/src/cards/scene/travel/ 下的新 renderer、局部样式、测试和独立 fixture；contrib/fliggy-travel/preview/ 的隔离预览；docs/cards/fliggy/spec.md 的视图章节与 docs/verification/fliggy-cards-ui.md。spec 字段由 TRAVEL-01 统一，不同时重写；共享 registry/Schema/global CSS 由集成协调。

任务内代码与必要测试可以修改；范围外先列清原因和最小接线方案，不顺手重构。所有操作还遵循 [AI 开发与 PR 规则](../../team/WORKFLOW.md)。

## 交付

填写单卡设计表；优先复用现有 Comparison/日程/列表/图片组件和 SceneCardShell；查询配置、服务事实、用户状态分开；参数改动发约定事件，不直接改后端或 store。

## 现在可做与最终集成

- 现在：可先画布局和做组件骨架；字段草案固定后，用 fixture 并行，真实 Key 不阻挡 UI。
- 集成：真实场景数据来自 TRAVEL-01，正式画布/注册来自 PLAT-01；两者没接完时保留 Draft 或只关闭视图子任务。

## 验收

- [ ] 固定 props/事件后可用 DEMO fixture 开发；字段/接口变化有版本记录。
- [ ] 目的地/日期/预算等只在约定范围可改；价格、库存等服务事实只读；刷新保留选中/备注的规则明确。
- [ ] User 可写/只读与 Display 行为正确，深浅色及 12 配色下可读，长文、缺图、空/错/过期可预览。
- [ ] 相关单测、类型/构建和实际浏览器截图/录屏提供；mock 与 live 分别标注。
- [ ] 独立视图不假称插件安装完成；与 PLAT-01 接线后再验收保存、恢复、旧卡共存。

## 参考

- [参考 1](../../CARD_DEVELOPMENT.md)
- [参考 2](../../cards/CARD_SPEC_TEMPLATE.md)
- [参考 3](../fliggy-travel-cards.md)

## 给 AI 的任务指令

> 完成 TRAVEL-02，负责人为xlz。先读本工单、AGENTS.md 与 docs/team/WORKFLOW.md，核对个人账号/remote、干净基线和任务分支。先完成上面的独立部分，再按确定接口集成；仅改工单允许文件，保留旧行为/必要测试，凭据与个人数据不入 Git。逐项记录实际验证、失败和未测，提供预览/复现方式。需要跨核心范围时明确说明，不用类型强转、mock 成功或跳过检查假装打通。完成后按负责人单独发出的“提交 PR 提示词”提交，不自动合并或部署。

## PR 正文必须包含

任务 TRAVEL-02 与真实 Issue 链接、最终行为变化、修改文件/范围、实际命令结果、预览/脱敏证据、兼容性与待集成项。这里只是任务代号，未生成真实 Issue 前不能写 `Closes #TRAVEL-02`。未完成验收的成果按阶段写清或用 Draft PR。

