# 决策核心阈值

本文记录 2026-10-31 `codex/core-tests` 基线（私有 main `7b1d433`）上决策核心的四组数字阈值：它们分别位于直执、整句直执、候选契约和目标分类。本轮只做文档化与注释，没有改阈值、没有改 trace schema，也没有改任何执行逻辑。所有数值都是保守的工程门控，**没有在 Vivic calibration 集上校准**；不要用它们推断模型准确率。

## 一览

| 阈值 | 位置 | 管什么 | 超过/未达时的行为 |
|---|---|---|---|
| 0.8（逐子句直执） | `decision/on.ts` `hybridProposal` | hybrid 下单个子句能否由规则契约直接构建 | 达到且解析出动作 → 规则构建；否则该子句交给主 planner |
| 0.8（directRows 整句直执） | `decision/on.ts` `runDecisionOn` | 非 hybrid 的逐子句路径是否允许规则构建整句 | 每个子句都 ≥0.8 且都是白名单契约 → 逐子句规则构建；任一行不满足 → 整句交 planner |
| 0.8（目标追问） | `decision/on.ts`（ambiguous target）、`decision/target.ts`（分类器目标） | 是否用分类器给出的歧义/目标直接追问 | 达到才采纳；否则继续走 planner 或追问 |
| 0.8 + 0.25（本地决策直执） | `decision/intent.ts` `acceptedDecision` | 本地决策模型（Kev/Jev 评分）能否直接执行一个视图/聚焦动作 | 最高概率 ≥0.8 且领先第二名 ≥0.25 才可能执行；否则放弃 |
| 0.5（单一候选契约） | `intent/slotPlanner.ts` | 路由结果是否足以把某个契约作为唯一候选交给 planner | 达到 → 只给一个契约；未达 → 给 3 个（main-only 5 个）候选 |
| 0.5（建卡契约） | `intent/slotPlanner.ts` `creationRoute` | 高置信建卡路由必须给出 slots，不能只回 say/text | 达到且属于建卡契约 → 缺 slots 视为校验失败 |
| 3 / 5（候选数量） | `intent/slotPlanner.ts` | 候选契约条数上限，不是置信度 | full 3 条，main-only 5 条；compact 提示再压到 3 条 |

## 0.8：逐子句直执（hybrid）

位置：`apps/local-api/src/decision/on.ts` 的 `hybridProposal`（`row.probability < .8`）。

含义：一句话被切成多个子句后，只有“路由置信度 ≥0.8 + 路由在内置白名单 + 契约解析出至少一个动作”的子句才在本地构建；其余子句合并后只付一次 planner 调用。规则只形成待校验提案，任何一段不确定都整句澄清，不提交部分结果。

风险：

- 阈值偏低或分类器过度自信 → 错误契约被本地直接构建（例如把“提醒我”误当倒计时），用户看到错误卡片。
- 阈值偏高 → 本来可本地完成的子句被送去 planner，增加一次模型调用与延迟。
- 该数字只看路由概率，不衡量契约解析质量；真正的安全网是契约解析、`actionExecutionIssue` 与整句原子校验。

测试锚点：`tests/multi-card-hybrid.test.ts`（literal/mixed/顺序/原子性），`tests/decision-on.test.ts`（.79 与 .3 不直执）。

## 0.8：directRows 整句直执（非 hybrid）

位置：`apps/local-api/src/decision/on.ts` 的 `runDecisionOn`（`directRows`）。

含义：在 `off`/`plans` 的逐子句旧路径里，只有**每个**子句都满足 `!failed && route && probability ≥ .8 && !none && 白名单 && 内置契约` 时，才允许逐子句规则构建。任一行不达标就整句交 planner。

风险：

- 这是“全有或全无”的批处理门：一句里有一个弱子句，其余本来可本地完成的子句也会一起交给 planner（hybrid 正是为这个场景存在）。
- 0.8 与 0.5 不可混用：0.5 只决定“给模型看哪些候选”，不授权执行；0.8 才进入本地构建。

测试锚点：`tests/decision-on.test.ts`（.79/.3）、`tests/multi-card-hybrid.test.ts` 的 `off` 对照。

## 0.8：目标分类与歧义追问

位置：`apps/local-api/src/decision/on.ts`（`row.target` 为 ambiguous 且 ≥0.8 才提前追问）、`apps/local-api/src/decision/target.ts`（`chooseTarget` 的 `choice`/`missing` 概率 ≥0.8 才采纳）。

含义：目标解析优先用标题、别名、焦点、方位、序数等确定性线索；只有分类器有足够把握时才用它的选择，或把它的“歧义”直接变成编号追问。

风险：

- 假阳性 → 改/删/聚焦到错误卡片；这是最贵的错误，因此 0.8 之上仍要求 `pool.some(id)` 且整批校验通过。
- 假阴性 → 多问一次“哪一张”或交 planner；成本是交互，不是数据错误。
- main-only 没有目标分类器：目标只能来自用户原话或编号回复，0.8 不参与该策略。

测试锚点：`tests/decision-target-clarification.test.ts`、`tests/decision-main-only.test.ts`。

## 0.8 + 0.25：本地决策模型直执

位置：`apps/local-api/src/decision/intent.ts` 的 `acceptedDecision`。

含义：本地决策模型只对 7 个受限动作打分；最高分 ≥0.8 且领先第二名 ≥0.25，才可能执行视图/聚焦/展开/收起。删除、`other`、否定/引用/复合句、以及目标不唯一都会放弃。该路径与上文的 0.8 是**不同**的门，不能互相替代。

风险：概率来自模型 logits，不是校准后的置信度；0.25 的间隔用来挡住“两个动作打平”的猜测。该门控的产品启用状态另由配置决定，阈值本身没有 env 开关。

## 0.5：单一候选契约 vs 候选列表

位置：`apps/local-api/src/intent/slotPlanner.ts`（`selected`、`dateCountdown`、`creationRoute`）。

含义：路由概率 ≥0.5 且不是多子句/日期倒数时，planner 只看到该契约（`selected`），提示词形如“本次契约为 X”；低于 0.5 时把路由排名、关键词回退和 main-only 操作线索合成候选列表交给模型选择。0.5 只影响“模型看到几个候选”，不授权执行；真正落地仍要过契约 slots、目标解析和整批校验。

风险：

- 0.5 以上误选 → 模型被限制在错误契约里，可能澄清或产出语义偏差的卡；但不会绕过校验。
- 0.5 以下候选过多 → 模型选错契约的概率上升；main-only 放宽到 5 条正是为了弥补没有路由提示，代价是候选歧义更多。
- 日期倒数是特例：`<0.5` 或没有路由时才倾向 `generate` 日期场景，避免把“距离某天”误建为普通倒计时。

## 不变式与观测

- `directClauses` 只有一个口径：**规则实际构建出动作的子句数**。hybrid 用 `ruleByClause.size`，逐子句路径只在 `built.length > 0` 时计数；planner 填的子句一律不计。
- hybrid 提交后，`trace.plans` 覆盖每个子句且 `source` 非 rules 即 planner；`directClauses + planner 子句数 = clauses 数`。
- `plannerCalls` 是真实 planner 调用次数，不由响应耗时或 provider 名字推断。
- 目标歧义只在“确定线索缺失”或“分类器 ≥0.8 判为 ambiguous”时出现；main-only 只用原话/编号回复。

## 调整规则

1. 先补失败样本与可复现测试，再动数字；不要为了放过某个样例单独调阈值。
2. 任何阈值改动都必须同时更新本文与对应测试，并在 `docs/decisions/` 记录依据；本轮没有校准数据，因此不调。
3. 0.8 与 0.5 的语义不可互换；0.5 永远不授权执行。
4. 删除/清空/撤销等危险动作另有确认与白名单，不能靠提高置信度绕过。

## 未覆盖

- 本文没有给出各阈值在真实流量上的命中率、误判率或延迟分布；这些需要单独评测。
- `compact` 提示的 3 条候选上限、`0.25` 领先间隔、以及 Kev/Jev 配置开关没有新增测试。
- 阈值是代码常量，没有运行时配置或灰度开关；调整需要改代码并重新验证。
