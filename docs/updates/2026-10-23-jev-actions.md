# Jev 多阶段决策与动作回执接线

2026-10-23。本轮在已有工作区实现协议、原生适配、任务编排和 API 接线，没有发布、推送或修改用户真实画布。两份用户附件作为业务要求和格式参考；其中 12 条 JSONL 不用于证明模型效果。

## 实际接通

- `/api/intent` 保留旧调用，新增可选 `task:{id,receipt?,cancel?}`。首请求可由前端生成任务 ID；同任务的执行提案带唯一 `executionId` 和输入画布 `canvasVersion`。只有宿主完成执行与保存后才提交成功回执，服务端随后决定继续或结束。
- 新共享 `packages/contracts/src/decisionTask.ts` 定义 `DecisionTaskRequestSchema`、`DecisionExecutionReceiptSchema`、`DecisionTaskStatusSchema`、`HostOperationSchema`。`kind:"host-operation"` 与原 `envelope` 二选一；完成、取消使用 `kind:"task"`。
- 原 ActionEnvelope 不变。移动、固定、传送、撤销、整理布局、普通计时暂停/恢复通过独立宿主操作交给前端 owner 的真实能力。坐标、暂停时间、保存、撤销均由宿主完成。计时日期/重复/条件模式不开放暂停恢复；固定状态未确认或已固定时拒绝移动。
- CanvasContext 新增可选 `version`、`selectedCardIds`、卡片 `surface`、布局宽高/固定信息。沿用既有完整性约定：未提供 `totalCardCount` 表示完整快照，提供总数且大于实际列表时表示截断。全部删除仍必须有明确模型范围选择与肯定授权；截断上下文不能把已加载候选当全部。
- 任务保留原始目标、最新补充、原文参数及位置、动态目录、冻结澄清编号、真实执行/工具/LLM观察、已完成/待办步骤。执行失败、错误回执、新建 ID 未确认、旧版本、取消、超时、无进展不会被标成完成。重复执行提案/回执返回同一结果，前端仍须按 executionId 去重。

## 原生模型与旧路径

`nativeV2.ts` 使用 StartLux 原生 `state/questions/answers`，保留完整候选概率及 `none_probability`，校验候选集合、概率和、winner 一致性。没有要求 StartLux 生成 JSON 动作，没有将 v2 标签塞进旧七分类，也没有把生成模型自报置信度当概率。

`catalogV2.ts` 从实际内置 SCENES、已重新校验的扩展定义和宿主能力构建动态目录。扩展定义的 ID/version/hash 保留；扩展正文不能声明执行权限。决策每阶段只发送摘要，选中/聚焦目标保留必要正文和来源状态；扩展完整参数 Schema 在已有内容规划器中验证。

原生直接路径支持聚焦/总览/恢复、便笺展开收起/原文创建编辑、单张删除、明确全范围删除、宿主操作、纯计时/一次性提醒。参数由模型在原始 Unicode code point 边界候选中分层选择，程序拼回半开区间原文并换算时长。没有语义关键词抽取器；候选边界最多 22 个一组，连同未解决信号和 native none 保持在固定 metadata 的 26-letter 读出内；HTTP协议硬上限为 32。无原文参数时补问；复杂内容、任意卡片创建/编辑仍调用主 LLM。

LLM 子任务区分 content/explain/plan。规划结果作为 observation 回到决策，模型再选执行；收到新建卡片实际 ID 后可以继续移动。天气/搜索仅调用注册的已有真实服务，失败终止并保留原因，不生成天气事实。

旧接口和旧七标签保持兼容。未配置 v2 或质量门控未开启时明确 `task.decision:"legacy-fallback"` 与 `reason`，复用既有规则/StepFun/GPT流程。完整句式的“撤销/整理布局”是明确标记为 `rules` 的兼容规则，未冒充模型推断。现有 StepFun/GPT 规划器新增严格独立 `hostOperation` 输出，服务端与前端均验证前置条件。

真实 StepFun 抽查另发现完整 NoteCard 被放在场景 `cards` 数组。通用提示已明确两种外层形状；兼容层只将完整通过 CardRecordSchema 的 Note/Todo/普通 Countdown 转回既有 `card.create`，仍经过完整动作校验，场景卡/天气等不能借此绕过 builder。根任务采集的原响应为 `.cache/simple-assistant-live/synthetic-note-13.json`、`-14.json`。通用产品事实已明确删除可撤销、批量只针对当前Space、引用不授权执行。

## 配置与实际门控

部署可设置 `VIVIC_DECISION_V2_URL`（原生 StartLux 服务的完整 HTTPS endpoint；loopback 允许 HTTP）、`VIVIC_DECISION_V2_TOKEN`、`VIVIC_DECISION_V2_TIMEOUT_MS`。在线会话只读取部署端配置，不启动或依赖本地启动器。该 URL 不是普通聊天端点，也不是 llama.cpp 的 `/v1/chat/completions`。

`VIVIC_DECISION_V2_EXECUTION_ENABLED` 默认关闭，显式 `true` 才允许原生自动执行。当前概率阈值仅是保守工程门控，**没有经过 Vivic calibration 集校准**；`/api/decision/status.v2.calibration` 明确为 `unverified`。本轮没有部署或默认启用特调 Jev，没有将已有 0.8B 小实验、12 条样例或模拟测试等同于模型可用质量。

本地 `ManagedStartluxRuntime.decideNative(state,questions,signal)` 复用同一官方 worker 和原生读出，独立解析新问题。旧 `decide(text)`、默认 2048 上下文和默认模型启动行为不变。测试可显式构造 `{contextLength:8192}`，worker/guardian 受控 JSONL 上限调至 128 KiB，单题最多 32 候选，超时会停止当前托管实例。

## 验证与边界

新增 `apps/local-api/tests/decision-v2.test.ts` 覆盖原生协议/none 信号、HTTP超时、无LLM原文提醒、缺参续问、冻结目标、否定/引用路由、LLM后执行及移动、真实服务失败、执行失败/旧回执/新ID、取消/重复/预算、固定与计时前置条件、在线API真实路由。模型回答为显式合成 fixtures，用于验证宿主行为，不能报告为真实模型准确率。

已执行：

```powershell
# 工作目录 apps/local-api
node node_modules/vitest/vitest.mjs run tests/decision-v2.test.ts tests/decision-provider.test.ts tests/decision-provider-http.test.ts tests/startlux-provider.test.ts tests/startlux-runtime-next.test.ts tests/intent-golden.test.ts tests/intent-progress.test.ts
node node_modules/typescript/bin/tsc -b
```

原生/provider/runtime 兼容回归 **7 文件 101 项通过**。随后修复真实便笺格式并扩展检查，planning/assistant-reply/clarification/intent-golden/intent-progress/v2 **6 文件 126 项全部通过**，其中新 v2 专项 28 项；这些集合有重叠，不累加为独立样例数。API TypeScript、定向 oxlint、`git diff --check` 通过。真实模型探针为 `scripts/decision-model/native-v2-probe.ts`：

最后补充旧上下文发送端兼容：缺省 totalCardCount 的完整快照可以进入明确范围判断；已知截断的列表仍禁止全部删除，范围含糊也不执行。更新后的 v2 专项 **30 项通过**，API TypeScript、定向 lint 和 diff 检查通过。旧 legacy-fallback 的普通 clarify 目前只保留问题、不自动推测候选；前端若需要恢复原本点选澄清，可仅对未执行的 legacy unknown/clarify 复用现有 parseCommand 的 `kind:"clarify"`，不借此再次自动执行本地 envelope。

```powershell
node apps/local-api/node_modules/tsx/dist/cli.mjs scripts/decision-model/native-v2-probe.ts <已有runtime-root> .cache/decision-v2-live/probe.json
```

探针先核对固定模型 metadata 的上下文支持，只启动已有 0.8B 缓存，不下载、不接触画布、不修改部署门控。每次题目真实走官方原生读出；执行回执明确是内存模拟，分布、延迟、降级及失败写在本地证据中。

本机真实执行结果：

- 固定 0.8B Instant metadata 允许上下文 262144；本轮显式使用 8192，CPU 4 threads。上游 `backends/llamacpp.py` 要求 Instant 非因果 prompt 在单个 microbatch 中读取，故显式 8192 模式同时使用 `-b 8192 -ub 8192`，默认模式仍为 2048。
- 首轮完整目录 state 约 9,960 字节，5 次均触发 worker 的 20 秒传输超时。补充安全错误分类后确认 `readout_failed:TimeoutError`；小原生问题 1.908 秒成功，证明并非 questions 接口完全不通。原始证据为 `.cache/decision-v2-live/probe.json` 和 `probe-batch-fixed.json`。
- 按阶段发送可用 ID/卡片名称、去除重复说明及无关 Schema 后，route state 为 2,283–2,328 字节。`.cache/decision-v2-live/probe-compact.json` 中小基线 0.632 秒；五条真实请求均返回有效原生概率，耗时 10.886 / 10.965 / 15.915 / 19.696 / 12.065 秒。
- 五条请求依次选择 resolve / resolve / resolve / resolve / llm，最高候选概率为 0.407 / 0.448 / 0.462 / 0.359 / 0.549，均未达到未改动的执行门控。实际 **0/5 自动执行、0/5 无主LLM完整任务成功**；探针故意未连接主 LLM，五项均明确降级并返回未完成。不能将“原生接口有效”写成“Jev效果达标”或“完整任务已跑通”。

真实复跑后的托管进程已经停止。延迟与基础模型置信度仍不满足低延迟默认能力要求；门控保持关闭，正式训练与校准独立推进。

剩余限制：完整的 4B 训练、独立参数质量/候选召回评测、概率校准和低延迟验收仍为后续工作。当前原生边界选择可能需要多轮，时长归一化支持明确的秒/分/小时；任意绝对日期、重复/条件语义不通过此简化直接路径。完整多步保证依赖模型正确列出/判断剩余目标，并由宿主回执约束实际完成；需要真实分布的完整轨迹评测才能提高门控。任务仅存本次 API 会话内存，重启丢失；恢复后旧 receipt 拒绝，重放去重窗口为会话任务生命周期。
