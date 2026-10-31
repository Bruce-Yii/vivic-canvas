# Vivic 简单命令规则系统性扫描报告

日期：2026-10-31  
Worktree：`work/vivic-rule-sweep`（分支 `codex/rule-sweep`，基于 `78a9a36`）  
状态：未 commit、未 push、未部署；未改动其他 worktree 的源码。

## 结论

倒计时慢不是单条正则的问题，而是**两层规则各有一套解析**：

- `intent/rules.ts`：legacy / off / shadow 模式的快速规则；
- `cards/*.ts` 的 `CARD_CONTRACTS.parse`：decision-on 模式的 `directClauses` 来源。

上一轮只修了 `rules.ts`，所以 `帮我创建一个倒计时 30 分钟。` 在 on 模式仍然 `directClauses=0`，继续走 4B + 主模型。本轮把两层归一化到同一套“命令外壳”语法，并补了行为矩阵。

## 矩阵与数字

新增 `apps/local-api/tests/command-matrix.test.ts`，同时跑 `matchRules` 和 decision 契约：

| 类别 | 生成变体 | 修复后命中 | 修复后漏 |
|---|---:|---:|---:|
| countdown（两种词序/前缀/动词/量词/中文数字/标点/的） | 1,422 | 1,422 | 0 |
| todo（前缀/动词/量词/冒号/多行/标点） | 851 | 851 | 0 |
| note（契约全量；规则仅显式冒号） | 1,212（规则 605） | 1,212（规则 605） | 0 |
| overview / restore / awaken | 390（契约 330） | 390 | 0 |
| delete-all（前缀/词序/标点/空画布） | 540 | 540 | 0 |
| **合计去重变体** | **4,415** | **4,415** | **0** |
| 反例（应 defer / 不应吞） | 124 | 0 误吞 | — |

基线探针（修复前，同一探针）：

| 类别 | 变体 | 修复前漏 | 修复前命中 |
|---|---:|---:|---:|
| countdown | 1,124 | 1,059 | 65 |
| todo | 487 | 461 | 26 |
| note | 389 | 317 | 72 |
| overview/restore | 216 | 207 | 9 |

修复前反例探针：125 条中 63 条误吞（todo 29、note 25、delete 9、countdown 0、simple 0）；修复后 124 条反例 0 误吞。

## 修复的类

1. **共享命令外壳归一化**（新文件 `intent/commandText.ts`）
   - 礼貌前缀：帮我/请/请帮我/给我/请给我/麻烦/麻烦帮我/请你/麻烦你/劳驾/替我/帮忙（可叠加）。
   - 创建动词：创建/新建/添加/新增/设/设置/定/来/搞/弄/建/加 等。
   - 量词：一个/个/一张/张/一条/条/一份/份/一下/下；`一个半小时` 不被误当量词。
   - 句末标点：。！!，,；;、；`？` 保留（疑问不执行）。
   - 固定短语命令去掉全部空白后匹配。

2. **countdown**
   - 两种词序：`30分钟倒计时` / `倒计时30分钟`；`30分钟的倒计时`；空格。
   - 前缀、动词、量词组合；中文数字；`一个半小时`、`两个半小时`、`一刻钟`、`一个钟头`、`钟头`。
   - 规则层和 decision 契约共用 `parseCountdownDuration`。
   - 端到端测试确认用户原句在 on 模式 `directClauses=1`、`plannerCalls=0`。

3. **todo**
   - 前缀、动词（含记录/安排/写/来/搞/弄/建/记）、量词、冒号可省、多行/分号/顿号/逗号列表。
   - 句末标点剥离；空列表/超限/数量不符仍 defer。
   - 不再把后续操作吞成条目：显示全部、取消/恢复/删除/移动/固定/打开/搜索/查天气/提醒/倒计时/设计时器/创建卡片等。

4. **note**
   - 契约层支持完整 note 语法（含 给我/请你/麻烦你、写/建/来/搞/弄/加/记录、一张/张）。
   - legacy 快速规则只认显式 `便笺/便签/笔记：…`（保留既有 planner/cache 行为；无冒号口语仍由契约或 planner 处理）。
   - 增加后续操作/查询守卫（放大/缩小/天气/新闻/讲个笑话等），不再吞掉第二请求。

5. **overview / restore / undo**
   - 礼貌前缀、句末标点、空白、英文别名大小写（FIT/RESTORE）。

6. **delete-all**
   - 帮我/给我/麻烦你/请你 前缀；`删除所有卡片` / `把所有卡片都删掉` / `把卡片全部删除` / `清空所有卡片` / `把当前画布清空` 等词序；标点。
   - 空画布仍 defer，不谎报成功。

7. **reminders**
   - 给我/麻烦你 等前缀；`一个半小时`、`两个半小时`、`一刻钟`、`钟头` 时长。
   - 仍只对显式、无歧义的提醒做确定性解析。

8. **split.ts**
   - `。`/`！`/`!` 在后续是独立操作时作为子句边界；边界标点从产出子句两端剥离。
   - 修复“然后 + 便笺内容”被误切（`记个便签，然后明天交周报` 保持一句）。
   - 修复“设个倒计时，然后十分钟后叫我”被误切。
   - 修复 `再见` / `再快一点` 被 `再` 误切。
   - `，顺便提醒我…` 由 `顺便` 消费，不把“顺便”留在右侧子句。
   - 对 `然后明天北京天气`、`然后讲个笑话`、`十分钟后提醒我…` 等真实第二请求仍会切分。
   - `加待办：买牛奶；显示全部` 等列表后接操作会切开，不被 todo 吞掉。

## 验证

- 定点：`command-matrix`、`split`、`routing-rules-first`、`direct-contract-parsing`、`planning`、`card-contracts` 全过。
- local-api 全量：**102 passed / 2 skipped；2512 passed / 3 skipped**。
- 类型：`pnpm --filter @vivic/local-api typecheck` 仅剩既有 2 错（`src/space/executor.ts` 的 `stage.sleep`、`tests/helpers.ts` 的 `modelApiBaseUrl`），与 `work/vivic-combined` 基线一致。
- `pnpm lint`：0 errors（既有 web warnings 未动）。

## 未覆盖 / 有意不覆盖

- **单张删除、arrange（move/pin/surface/organize）、edit、focus、highlight**：依赖宿主目标选择/画布状态，文本本身不足以唯一确定目标；仍由 planner + host target 处理，不硬猜。
- **awaken**：只在 `rules.ts` 有快速规则，没有 `CARD_CONTRACT`。
- **无冒号便笺（`记一下明天交周报`）在 legacy 快速规则中仍走 planner**：这是为保持既有 plan-cache/planner 测试行为；decision 契约矩阵已覆盖 1,212 条（含无冒号）。
- **不确定口语**：`整一个`、`俩小时`、`一百分钟` 等未扩展；按“不确定 defer”保留。
- 未部署、未 commit、未 push。
