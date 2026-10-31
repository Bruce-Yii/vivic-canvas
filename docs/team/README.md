# Vivic 三人开发：2026-10-20 执行入口

已核对 10/19 的 PDF/Excel 和两场飞书原始文字记录。用户已确认 GitHub 账号：xlz 为 `franzkotkowski330-collab`，马泽瑜为 `Shenbeijc`，程佳锐为 `ECdison6227`。工单正文已可交接，线上 Issue/Project/assignee 尚未创建。数据索引：[iteration-20261020.json](iteration-20261020.json)。

材料和交付验证见 [核对记录](../verification/team-assignment-20261020.md)。

## 先给谁发什么

| 人员 | 先读/先做 | 后续 |
| --- | --- | --- |
| 程佳锐 · `ECdison6227` | [PLAT-01](../tasks/20261020/PLAT-01.md)：发布共同规范、固定最小接入接口 | [PLAT-02](../tasks/20261020/PLAT-02.md)：Test Space 宿主；核对参考、官方赛期并验收集成 |
| xlz · `franzkotkowski330-collab` | [个人任务说明](XLZ.md)，先 [TRAVEL-01](../tasks/20261020/TRAVEL-01.md)：旅游场景/MCP 独立试跑 | [TRAVEL-02](../tasks/20261020/TRAVEL-02.md)：卡片 UI；[DEMO-01](../tasks/20261020/DEMO-01.md)：录屏；[UI-01](../tasks/20261020/UI-01.md)：新用户/设置 HTML |
| 马泽瑜 · `Shenbeijc` | [个人任务说明](MA_ZEYU.md)，先 [DEC-01](../tasks/20261020/DEC-01.md)：已有成果盘点、决策评测/适配 | [RUN-01](../tasks/20261020/RUN-01.md)：本地启动器 |

两位伙伴可以独立做 PoC/原型；正式源码接线使用合入后的协议与 fixture。每个任务只一位主要负责人，集成由程佳锐统筹。Grok Bot 是程佳锐可接力的开发环境，不是额外抢占队友目录的并行负责人。

## 工单总表

| 代号 | 责任人 | 优先级 | 交付 | 依赖 |
| --- | --- | --- | --- | --- |
| PLAT-01 | 程佳锐 | P0 | 卡片接入契约、参考样例、最小接口 | 无 |
| TRAVEL-01 | xlz | P0 | 一个旅游场景的独立数据链路 | 无硬前置；真实服务能力需核对 |
| TRAVEL-02 | xlz | P0 | 参数/视觉/深浅色与独立卡片预览 | 字段与 fixture 固定；最终接 PLAT-01 |
| DEMO-01 | xlz，程佳锐验收 | P0 | 旅游演示、录屏和复现材料 | 数据与视图稳定，集成状态明确 |
| DEC-01 | 马泽瑜 | P0 | API/本地决策评估与独立适配 | 先盘点本人已有成果 |
| RUN-01 | 马泽瑜 | P1 | 一种本地服务启动/状态/停止闭环 | DEC-01 的服务选择；可先设计协议 |
| UI-01 | xlz | P1 | 引导/设置/个性化/Store HTML 原型 | 可先读参考，旅游优先 |
| PLAT-02 | 程佳锐 | P1 | 设置导入/校验/Test Space/安装 | PLAT-01，不阻塞旅游独立 PoC |

P0/P1 是本轮建议优先级，非会议承诺时长。xlz 23–24 日集中开发是会议安排；比赛“约10/25”仍待官方确认。不要用推测日期当正式截止。

## 如何放进 GitHub

1. 先将当前文档/Skill 分支经 PR 合入 main，记录新的基线 SHA。不要让其他人找不到工单引用的文件。
2. 建一个 Projects 看板（建议名 `Vivic · 本地版与旅游演示`），状态按 [WORKFLOW](WORKFLOW.md)；若暂不建看板，Issues 列表也能开工。
3. 将 `docs/tasks/20261020/` 每个文件的正文建成一个 Issue，标题保留任务代号。分阶段先发 PLAT-01、TRAVEL-01、DEC-01，后续任务可留 Backlog。
4. 填实际负责人/assignee、基线 SHA、依赖 Issue 链接和必要参考；若成员不可选为 assignee，正文注明负责人，不为此直接授予写权限。
5. 队员从最新主仓库 main 建自己的分支，按个人任务说明和 [AI 开工提示词](WORKFLOW.md) 开发。
6. 验收本机成果后，把 [提交 PR 提示词](WORKFLOW.md) 发给 Agent；检查当前 head 的 CI 和真实行为，再由程佳锐 Squash 合入。

**没有自动创建 Issue、发消息或邀请。** 用户明确说“做好分工我给他们”，所以本轮交付可转发文件与工单正文；GitHub 上是否已发布必须以实际链接为准，不能把本页代号当 Issue 编号。

## 参考与未定项

- [会议核对与范围](MEETING_ALIGNMENT.md)：保留事实、更新、待确认的区别。
- [按人领取参考资料](REFERENCES.md)：哪些已有，哪些需要程佳锐补。
- [Hark 风格参考](../references/hark-for-vivic.md)：公开库已可读，设置页证据不完整，不复制私人原始材料。
- [AI 开发、Git 与 PR 规则](WORKFLOW.md)：工单级执行边界和可直接复制的提示词。
