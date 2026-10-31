# 给 xlz：本轮怎么做、怎么交

用户确认你的 GitHub 账号是 `franzkotkowski330-collab`。创建任务 PR 时使用自己的账号和实际 fork/任务分支，目标是 `ECdison6227/vivic-canvas:main`；账号已记录不代表线上 Issue 已分配。

你的主任务是**飞猪旅游系列卡片与演示**，新用户流程和 Hark 风格设置的 HTML 原型作为独立后续任务。你可以独立做卡片及 MCP 试跑，不用等完整 SDK，但不要同时改 Vivic 后端主流程。

## 工作顺序

1. [TRAVEL-01](../tasks/20261020/TRAVEL-01.md)：先选一个旅游场景，核对飞猪能力，输入需求后得到正确结构化结果。用独立目录提供适配/脚本/fixture，不改全局认证或 intent pipeline。
2. [TRAVEL-02](../tasks/20261020/TRAVEL-02.md)：按字段表做卡片视觉和参数编辑，用 DEMO 数据独立预览。User/Display、浅深色、来源/过期/错误都要能说明。
3. [DEMO-01](../tasks/20261020/DEMO-01.md)：与程佳锐把场景接到真实 Vivic，准备演示与录屏。独立原型/DEMO 与真实接入分别标记。
4. [UI-01](../tasks/20261020/UI-01.md)：新手、订阅/自有配置、个性化、Store 和设置页 HTML 原型。旅游先完成，不把它们都塞进同一个 PR。

会议里说 22 日答辩、23–24 日集中做；按这个可用时间控制工作量。比赛截止“约25日”尚未确认，以程佳锐提供的官方链接为准。

## 先拿这些资料

- [卡片开发契约](../CARD_DEVELOPMENT.md)、[单卡设计表](../cards/CARD_SPEC_TEMPLATE.md)、[项目 Skill](../../.agents/skills/vivic-card-development/SKILL.md)。这三份规定字段、来源、编辑与主题，不是已实现的外部安装 SDK。
- [飞猪任务](../tasks/fliggy-travel-cards.md)：官方资料、字段来源和独立开发边界。
- [Hark 参考](../references/hark-for-vivic.md)：用于 UI-01；Hark 设置完整证据尚缺，不需要等待它才做旅游。
- 如果手里有已经跑过的决策模型结果，把模型/设备/输入/原始结果交给马泽瑜；不要继续与其重复跑同一评测，也不要把没有记录的数值补成成绩。

## 可直接给 AI 的第一条指令

```text
我是 xlz，GitHub账号是franzkotkowski330-collab，现在做Vivic的TRAVEL-01。
读取 AGENTS.md、docs/team/WORKFLOW.md、docs/tasks/20261020/TRAVEL-01.md，按其中范围完成独立旅游 MCP 结构化试跑。
先核对我的 GitHub 身份、origin/upstream、基线和工作区，不覆盖已有修改，从最新主仓库 main 新建 feat/fliggy-travel-poc。
先选一条场景、确认实际工具/输入返回，再做独立适配、脱敏 fixture、失败/取消测试和复现步骤。
允许目录以工单为准；不要改 app.ts、核心路由、共享契约、全局认证/样式或别人的模块。接口需要核心配合时写出最小接入要求。
真实服务和 mock 分别标记，不能编造机票/酒店价格或调用成功。没有凭据时完成能做的独立部分并说明缺口，不索取或输出别人的 Token。
最后列修改文件、实际测试、预览/复现、未完成集成项。先本地交付；我发“提交PR”指令后再推送创建PR。
```

## 交付时再给 AI

复制 [WORKFLOW 的提交 PR 提示词](WORKFLOW.md)，把任务和真实 Issue 链接填好。标题如 `feat: add isolated Fliggy travel query adapter`，对应实际改动，不用“完成所有旅游卡片”夸大阶段。

完整完成当前 Issue 才用 `Closes #实际编号`；只交 PoC/视图时写 `Refs #实际编号` 或关联对应阶段工单。CI 通过后仍等程佳锐验收，不自己合并、不自动部署、不通过放宽断言让测试变绿。

你的参考文件和规则应跟随同一 main 基线。压缩包是交接快照；如果 Issue 后续变更范围，先同步工单与代码，不用旧压缩包覆盖新文件。
