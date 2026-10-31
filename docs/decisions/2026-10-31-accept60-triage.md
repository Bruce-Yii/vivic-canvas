# 60 条验收失败分类（2026-10-31，HEAD e250a3d）

基线：`work/real-browser/accept60/`（51 过 / 8 挂 + sc-03 驱动失败），主仓库 `7b1d433`（已含 PR4
target 修复）。本轮只修**决策 bug**；产品有意澄清的保留并在此记录；驱动问题不改产品代码。

| 用例 | 分类 | 结论 |
|---|---|---|
| sc-12 / sc-54 | 决策 bug | 已修：倒计时契约确定性拆分「和」枚举，每事项一张 CountdownCard |
| sc-16 | 决策 bug | 已修：周计划允许模型提议星期，钟点仍受 groundedTime 约束；「下周」决定 weekStart |
| sc-21 | 产品澄清（有意） | 不修：南京在 GeoNames 有 3 个同名地点，按既定同名策略澄清 |
| sc-39 | 决策 bug | 已修：天气适配器不再把「把上海天气那张卡拖到左上角」当成天气查询 |
| sc-40 | 决策 bug | 已修：移动关系同时解析被移卡与参照卡，card.move 带上 relativeTo |
| sc-51 | 决策 bug | 已修：省略目标的后续子句继承上一子句的聚焦卡 |
| sc-58 | 已由 main 的 PR4 修复 | 复测通过：显式缺失卡返回 0 候选，不再列全画布 |
| sc-03 | 驱动 | 不修：命令输入框在 90s 内未出现，未发出意图请求 |

## 产品澄清：天气同名地点（sc-21）

`docs/data-providers.md` 已写明：地名匹配要求精确同名 + populated-place/administrative
feature code，多个候选时澄清，**不按顺序、人口或 GPS 猜坐标**；只有直辖市（上海/北京/天津/重庆）
用行政名消歧。真实 Open-Meteo geocoding 对「南京」返回：

- 南京 / 江苏 / 中国（PPLA，GeoNames 1799962）
- 南京 / 云南 / 中国（PPL，临沧市，GeoNames 9924292）
- 南京 / 云南 / 中国（PPL，思茅市，GeoNames 9931976）

因此 sc-21 的澄清是既定身份策略的结果，不是决策层 bug。补充省州（「南京,江苏天气」）即可得到
WeatherCard。若产品要改为「省会城市优先」，那是策略变更，需要同时修改 `docs/data-providers.md`
和验收预期；本轮不硬改。

## 本轮改动

- `apps/local-api/src/cards/countdown.ts`：`slots` 增加 `{reminders:[…]}`；单触发器的显式枚举
  （顿号/和/以及）由 `parseEnumeratedReminders` 确定性拆分，每事项一张 CountdownCard。
- `apps/local-api/src/intent/pipeline.ts`：默认（非 on-mode）的 `reminderMode` 也走同一确定性拆分，
  单触发器且无混合/条件/否定时才本地建卡；多触发器仍交给模型与 R2 覆盖校验。
- `apps/local-api/src/data/weatherInput.ts`：含移动/编辑/聚焦等卡片操作动词的句子不再被当成
  「当前位置天气」。
- `apps/local-api/src/decision/target.ts`：移动关系拆成「被移卡 / 参照卡 / 方向」；焦点后续子句
  可用 `hasExplicitCardReference` 判断是否继承。
- `apps/local-api/src/decision/trace.ts`、`intent/slotPlanner.ts`：上一子句聚焦的卡在同一轮内被
  无目标子句继承。
- `apps/local-api/src/cards/{types,operations}.ts`：宿主解析的 `relativeTo` 进入 `card.move`。
- `apps/local-api/src/scenes/build.ts`：周计划在用户未点名星期时允许模型给出计划日；钟点仍必须
  grounded；「下周/本周」决定 `weekStart`。
- 回归测试：`apps/local-api/tests/accept60-regressions.test.ts`（9 条，固定输入 + 假 provider）。

## 验证

- `pnpm --filter @vivic/local-api test`：**2337 passed / 3 skipped（2340）**，95 文件通过 + 2 跳过
  （本轮 main 基线 2327/3；新增 10 条断言）。
- `pnpm typecheck`：仅既有 2 个错误（`src/space/executor.ts` 的 `stage.sleep`、
  `tests/helpers.ts` 的 `modelApiBaseUrl`），无新增。
- `pnpm lint`：0 errors（150 条既有 warning）。

## 验收预期与现状的差异（供后续裁决）

- `scenarios-20261031.json` 的 sc-12 允许「一条含『喝水和吃药』的提醒」，但 main 的 R2 覆盖
  （commit 165724b）明确拒绝折叠枚举；本轮按用户要求与 R2 语义统一为**每事项一张卡**。
- sc-58 的「至多一个近义确认」当前实现为直接说明没有该卡（0 候选），符合验收主句要求。
- sc-21 的候选文案只拼 `name / admin1 / country`，两个云南同名村的 admin2 不同但显示相同；
  这是候选文案的残余缺陷（不影响本轮分类），可在天气澄清 UI 中补 admin2。
- `work/real-browser/accept60/summarize.mjs` 仍按 `expected_card_types` 的数量精确匹配：
  sc-12 期望恰好 1 张、sc-54 期望恰好 2 张。按本轮的「每事项一张卡」语义，sc-12 产出 2 张
  CountdownCard、sc-54 产出 2 张 CountdownCard + 1 张 NoteCard，复跑会报 `field` 数量不符。
  这是验收口径问题：应把 sc-12/54 加入 `COUNT_FREE`，或把场景的期望卡数改为 2 / 3。
  不建议为了迁就该计数改回折叠单卡（与 R2 及「两张卡」要求冲突）。
