# 维护者计划：PR 处理、PLAT-01/02 与底层优化

2026-10-21，程佳锐（维护者）用。本文给方向、决策和拆分，细节由执行 Agent（Codex）按每个子任务完成。基线 `main` = `ea9fbe8`。执行时仍遵循 [AGENTS.md](../../AGENTS.md) 与 [WORKFLOW](../team/WORKFLOW.md)。

## 0. 先清前置（今天）

| 顺序 | 动作 | 原因 |
| --- | --- | --- |
| 0.1 | 把本机 `feat/pre-model-settings` 的 46 个未提交改动（删除 VoiceClone、主题默认 `auto`、AvailableCards、全屏提示、启动权限）跑完检查后单独提 PR 合入 | 它改了 `app.ts`、`ControlApp.tsx`、`protocol.ts` 等核心文件，拖得越久越容易与 #15 及 PLAT 冲突 |
| 0.2 | 按第 1 节处理 mzy 的 3 个 PR | 让主线基线稳定后再开 PLAT 分支 |
| 0.3 | 清理远端过期分支（`feature/*`、`fix/*`、`wip/*`、`agent/next-iteration` 等十余个） | 降低伙伴找错基线的概率 |

## 1. mzy（Shenbeijc）的 PR

三个 PR 均基于当前 `main`，与 `main` 无合并冲突。审查在独立 worktree 中完成，PR 均未在 GitHub 上做任何操作。

| PR | 内容 | 结论 | 必须修改 |
| --- | --- | --- | --- |
| #15 DEC-01 决策服务接入 | HTTP 决策 provider（adapter / local-chat）、主备路由、请求代次、设置页开关、评测文档 | **小改后合并（优先）** | ① provider 配置非法（局域网 URL、`PROTOCOL=local-chat` 未设 `KIND=local`、缺 MODEL）时 `createApp` 抛错，后端无法启动 → 改为记录告警并降级到 Kev/禁用，status 报配置错误，补测试 |
| #13 RUN-01 本地启动器原型 | `contrib/local-connector` Python 标准库服务，127.0.0.1 + Bearer，start/stop/status/decide | **小改后合并** | ① `decide` 持锁同步写子进程 stdin，子进程不读则整个启动器（含 stop/health）卡死；② 子进程环境变量白名单缺 `SYSTEMROOT/TEMP/USERPROFILE/APPDATA`，Windows 上联网即 `WinError 10106`；③ 测试第 154 行路径未 `resolve()`，短文件名机器上失败；④ 文档改正"一次性 token"、写明浏览器经本地后端访问 |
| #14 手机控制台 + 公网中继 | `contrib/mobile-console` WS 中继 + `apps/web/src/control/mobile` UI | **不合并，转 Draft** | 不在任何工单内，超出"本地单人优先"；且 web 通过相对路径引用 contrib 内 `zod`，**CI 按根目录安装时 typecheck/test/build 全部失败**；验证文档数字与 PR head 不符（文档 584 项，实测 529 项）；中继限流按 remoteAddress 计数，在 nginx 后可被一人打满 |

#15 的范围问题需要你拍板：DEC-01 工单写明不改 `app.ts`/`pipeline.ts`，但实际改了（约 +20 行，默认关闭）。建议**接受**这次最小接线，因为 L04 本来就要接入，而且改动可审；但要在 PR 里注明这是你授权的。
次要建议（不阻断）：`pipeline.ts:163` 应改成 `if (result && 会话已切换)`；服务挂掉时每条指令多等约 4s，可以加 30s 失败冷却。

给 mzy 的统一要求（写进 WORKFLOW）：
- 验证数字必须来自 **PR head 的干净 clone + 根目录 `pnpm install --frozen-lockfile`**，不能来自带其他未提交工作的个人目录。
- `contrib/` 下的代码要么完全自包含（主应用不 import），要么升级为 workspace 包并用根 lockfile。
- 无工单的方向性工作（如手机/中继）先开 Issue 讨论，不直接提 PR。

## 2. PLAT-01：卡片接入协议（目标：10/23 前让 xlz 能接入）

### 2.1 核心原则：LLM 抽参数，适配器取事实，builder 映射

现有链路只有一种事实来源：用户文字或网页组成的 `sceneCorpus`，模型输出的数字要能在 corpus 里找到。外部服务（飞猪 MCP）的结果如果塞进 corpus，既脆弱也不安全。新增一条**结构化数据通道**：

```mermaid
flowchart LR
  T[用户文字] --> L[LLM：选 scene + 抽取查询参数]
  L --> Q[查询参数校验 + grounding（日期/城市须出自用户文字）]
  Q --> A[Provider 适配器：调用服务 → Zod 校验原始响应 → 标准化]
  A --> B[确定性 builder：ProviderResult → CardRecord，不经 LLM]
  B --> V[CardRecord / ActionEnvelope 校验] --> H[owner 保存/同步]
```

价格、库存、评分、链接**只**来自适配器结果，LLM 不碰。LLM 只负责意图和参数，参数照旧走 grounding。

### 2.2 要固定的协议（packages/contracts）

| 名称 | 内容 | 说明 |
| --- | --- | --- |
| `ProviderResult<T>` | `provider`, `tool`, `requestId`, `fetchedAt`, `expiresAt?`, `mode: "demo" \| "live"`, `query`, `items: T[]`, `status: ok/empty/error` | 适配器的唯一输出形状，xlz 的 contrib 适配器与前端 fixture 都对齐它 |
| `TravelOffersCard`（首个参考卡，v0） | `displayProps = { query, items[{id, kind: hotel/flight/poi, title, subtitle?, price?{amount,currency}, rating?, imageUrl?, detailUrl?, tags[]}], fetchedAt, mode }`；`sourceData = { provider, tool, requestId, expiresAt? }`（严格对象，不用 OpenSourceData）；用户状态 `selectedIds`、`notes` | 一张"旅游结果列表"卡，以 `kind` 区分品类，避免每个接口一种卡。字段名是草案，TRAVEL-01 拿到真实响应后经 PR 小改 |
| `CARD_FIELD_POLICY` | 每个 cardType 声明 `query` / `result` / `userState` 三类字段路径 | **在 owner 的 `card.update` 校验中强制执行**：result 字段只能由 provider 刷新动作改写，不能只靠 UI 隐藏。旧卡不声明，等于全可编辑，保持兼容 |
| `EvidenceRef.kind?` | 新增可选 `"web" \| "service"`；service 类型允许无 URL | 向后兼容，旧数据照常读取 |
| `card.refresh`（可放 v0.2） | 按卡片保存的 query 重新调用适配器；带 `requestSeq`，迟到结果丢弃 | 为过期/刷新做准备 |

### 2.3 拆成 4 个 PR（每个都可独立验证）

| PR | 范围 | 验收 |
| --- | --- | --- |
| PLAT-01a 协议 | contracts：`ProviderResult`、`TravelOffersCard` schema、`CARD_FIELD_POLICY`、`EvidenceRef.kind`；DEMO/合法/非法 fixture；`contracts:generate` | 契约检查通过；旧画布 fixture 可读；非法样例被拒 |
| PLAT-01b 后端 | `local-api/src/providers/`：适配器接口 + **DEMO 适配器**（读 fixture，不联网）；scene `travel_offers` 的 payload（只含查询参数）、prompt、确定性 builder；pipeline 接线 | 一句"下周去杭州住两晚，预算 500"→ DEMO 卡；参数缺失时走 clarify；适配器返回 empty/error/超时都有对应结果；builder 不读 LLM 给的价格 |
| PLAT-01c 前端 | 最小 `TravelOffersCardView`（复用 SceneCardShell，列表 + DEMO 标记 + 来源/获取时间），注册到 registry 和 sceneMeta；owner 端执行字段策略 | User/Display 两种模式、深浅色可读；改 result 字段被宿主拒绝；刷新后恢复正常。**正式视觉由 xlz 的 TRAVEL-02 替换** |
| PLAT-01d 文档 | 更新 CARD_DEVELOPMENT 第 4、6.1、7 节与 Skill；在 `docs/cards/fliggy/spec.md` 写下给 xlz 的字段映射模板 | xlz 只需实现 `contrib/fliggy-travel` 中"飞猪响应 → ProviderResult"这一步，再交给你接成 live 适配器 |

真实飞猪接入作为 PLAT-01e（你来集成）：把 xlz 的映射放进 `providers/fliggy`，凭据只存后端，`mode: "live"`。没有拿到 live 证据前，界面一律显示 DEMO。

## 3. PLAT-02：导入卡片包 + Test Space（旅游演示之后）

### 3.1 关键决策

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| v0.1 渲染路径 | **只支持声明式**：`ui.json` 由受控组件目录组合（Header、KeyValue、Metric、List、Image、Badge、Link、Table、Progress），以 JSON Pointer 绑定数据，不允许表达式 | 可静态校验、天然继承主题、无代码执行风险；iframe / MCP Apps 推到 v0.2 再评估 |
| 包格式 | `.vivicard`（zip）：`manifest.json`、`config/data/state.schema.json`、`ui.json`、`examples/*.json` | 限制文件数、单文件/解压总量，拒绝越界路径 |
| Schema 语言 | JSON Schema 子集（object/array/string/number/integer/boolean/enum、min/max、required、`additionalProperties:false`） | 先评估 Zod 4 能否把 JSON Schema 转成 Zod；不行再用 ajv。子集外的关键字一律拒绝 |
| 内容身份 | 对规范化后的包内容做 sha256 | 校验结果、试跑会话、安装都绑定 hash；换包后全部失效 |
| 卡片实例 | 在 CardRecord 联合里新增一个通用类型 `ExtensionCard`：`displayProps = { def: {id, version, hash}, config, data, state }` | 外层由 Zod 校验结构，内层按已安装定义校验。缺包时显示占位卡，原始数据保留 |
| 存储 | IndexedDB 新增 `definitions` store | **依赖 O-3（持久化版本与迁移）先完成** |
| Test Space | 用同一 reducer 新建一个内存 store：无 owner、无 BroadcastChannel、无 IndexedDB；放在 Radix Dialog 中，带 session token | 关闭时丢弃所有状态；迟到响应按 token 丢弃 |
| LLM 使用 | 已安装且启用的定义生成动态 scene `ext.<id>`，按需注入 prompt | 放在最后一个子 PR；与 O-5 的 prompt 瘦身一起做 |

### 3.2 拆分

| PR | 交付 |
| --- | --- |
| PLAT-02a | 包解析/校验库（纯 TS，不依赖 React），外加 CLI `pnpm card:check <dir\|zip>`；把现有目标进度卡改写成参考包 |
| PLAT-02b | `ExtensionCard` 类型、定义仓库（IndexedDB）、占位卡、禁用/卸载/恢复 |
| PLAT-02c | 声明式渲染器 + 组件目录，双模式、主题、参数编辑（复用 `CARD_FIELD_POLICY`） |
| PLAT-02d | 设置页"卡片管理 → 导入"，Test Space 弹窗（DEMO 试跑、参数、模式/配色切换），确认安装 |
| PLAT-02e | 已安装卡片进入 LLM 场景选择 |

最终验收：在仓库外的空目录里，让 Agent 按 Skill 做出一个包；不改源码、不重新构建就能导入并使用；重启后恢复正常。

## 4. 底层优化（按收益/成本排序）

| ID | 问题（证据） | 做法 | 量级 |
| --- | --- | --- | --- |
| O-1 | 画布超过 64 张卡后**所有指令返回 400**：`local-api/src/schemas.ts:26` 限 64 张，`web/src/ai/api.ts:94` 却发送全部卡片 | 前端按聚焦 > 固定 > 最近挑选至多 N 张，`displayProps` 只发摘要；后端超限时给出明确提示 | S |
| O-2 | 服务端几乎没有日志与计时（`app.ts:101` 吞掉异常，全仓只有 3 处 console） | 每个请求带 requestId，记录各阶段耗时（规则/数据/搜索/决策/LLM/校验），不记录正文和凭据 | S |
| O-3 | 契约一收紧，旧画布就**静默消失**：`persistence/db.ts:92` 整条记录用 strictObject 校验，失败即过滤；`controlHost.ts:922` 随后新建空画布；`DB_VERSION=1`，没有迁移 | 逐张卡宽容解析，无效卡隔离；记录加 `schemaVersion` 与迁移链；给用户可见的提示。**这是 PLAT-02 的前置** | M |
| O-4 | 首屏 JS 共享 chunk 3.1MB（gzip 954KB），包含 recharts、mermaid，landing 也会预加载它；`App.tsx` 静态 import Control/Display | 路由级 `lazy()`；图表/mermaid 卡按类型懒加载；landing 拆出独立 chunk | M |
| O-5 | 延迟：`runIntent` 各阶段串行 await；StepFun 不流式；system prompt 约 6.8k 字符；校验失败要整轮重生成（预算 90s） | 用 SSE 推送进度并先播 spokenText；重试只修复出错的那张卡；决策打分与组装 prompt 并行。**有 O-2 的数据后再动** | M–L |
| O-6 | `scripts/dev.mjs` 在 Windows 上 `spawn("pnpm")` 不带 shell，且杀不掉孙进程，导致端口被占 | 改用 `npm_execpath` 或 `shell: true`；Windows 上用 `taskkill /T /F` | S |
| O-7 | CI 只跑类型/单测/构建：oxlint 有 55 条 warning 未接入，25 个 e2e 不在 CI | 根目录加 `pnpm lint` 进 CI；CI 跑一组 e2e 冒烟 | S |
| O-8 | 拖动时 `CanvasView.tsx:120-145` 为所有节点重建 data，图表/地图卡每次 pointermove 都重渲染 | 稳定每张卡的 data 引用，视图加 `memo` | S–M |
| O-9 | 大文件：`controlHost.ts` 997 行（持久化/广播/提醒/导入导出/撤销全在一起），`ControlApp.tsx` 708 行，`runIntent` 约 200 行；`intent/rules.ts` 注明是 web commands 的"临时镜像" | `controlHost` 拆成写队列 + 发布器 + 提醒调度；`runIntent` 改成阶段数组；commands 抽成共享包 | L，穿插进行，不单独立项大重构 |
| O-10 | 单测约 57s 串行（web 28.5s，其中 56% 是环境初始化） | vitest projects 并行；纯 node 测试用 `isolate:false` | S |

已确认不需要改的：后端只绑定 127.0.0.1，token 比较为恒定时间，Origin/Sec-Fetch-Site 校验可以防本地 CSRF；同步走 patch + 版本号；autosave 有防抖；TS 为 strict。

## 5. 宏观建议

1. **把"卡片可扩展"定为核心战略。** 现在每加一种卡要改约 13 个文件，卡片类型是封闭的 TS 联合。PLAT-01（数据通道）和 PLAT-02（声明式包）一起解锁"Agent 做卡、用户导入"，这是 Vivic 区别于普通 AI 对话的护城河。其他功能都排在它之后。
2. **建立"一句话 → 卡片"的质量评测集。** 核心体验靠 LLM 输出质量，但目前只有决策模型有评测。建议做 100–200 条中文真实指令的 golden set，记录场景是否命中、字段是否正确、延迟；每次改 prompt 或模型都要跑。mzy 的决策评测框架可以复用。
3. **降低首次使用门槛。** 当前必须先连接 StepFun 或 GPT OAuth 才能体验。建议提供"无模型演示模式"：内置示例指令 + 预制结果，并把"连接模型"做成第一步引导。这与 UI-01 的新用户原型一起做。
4. **体感速度优先于真实速度。** 先有进度反馈和先出的语音/占位卡（O-5），再谈压缩模型耗时。
5. **数据安全底线。** 用户画布绝不能因升级丢失（O-3），这一条优先级高于新功能。
6. **流程减重。** 文档量已经超过三人团队的消化能力（AGENTS.md 很密，docs 有 40+ 篇）。建议以 GitHub Issue 和 Project 作为任务状态的唯一来源，交接文档只保留"当前状态一页纸"，历史资料都放进 archive。
7. **团队规则补两条**：PR 的验证必须基于干净 clone 和 PR head；`contrib/` 要么自包含，要么成为 workspace 包。语言上，要进产品的代码统一用 TS；Python 只用于评测/离线工具，并在 README 注明运行版本（维护者本机目前没有 Python）。
8. **比赛日期（约 10/25）尚未核实**，尽快确认。如果属实，旅游 DEMO 只需要 PLAT-01a–c + DEMO 适配器 + xlz 的视图；live 接入能做成就加分，做不成也不阻塞演示。

## 6. 时间线（建议）

| 日期 | 维护者（交 Codex 执行） | 伙伴 |
| --- | --- | --- |
| 10/21–22 | 0.1 提交 pre-model-settings；#15、#13 退回修改后合并；PLAT-01a；O-1、O-6 | mzy 修 #15/#13；#14 转 Draft |
| 10/22–23 | PLAT-01b/c/d；O-2 | xlz 按 spec 模板做飞猪映射与视图 |
| 10/23–24 | 集成 xlz 视图与 live 适配器（PLAT-01e），录制 DEMO | xlz：TRAVEL-01/02、DEMO-01 |
| 10/25 后 | O-3 → PLAT-02a–e；O-4、O-7、O-8 | mzy：真正可用的决策评分服务、RUN-01 正式接入；xlz：UI-01 |

## 7. 给 Codex 的通用开工指令

> 读取 AGENTS.md、docs/plans/MAINTAINER_PLAN_20261021.md 与对应的工单/契约文档，执行【子任务 ID】。从最新 `main` 新建分支，只改该子任务列出的范围。协议变更须保持旧画布可读，并运行 `pnpm contracts:generate`。完成后运行 `pnpm typecheck`、`pnpm test`、`pnpm contracts:check`、`pnpm build`；涉及界面的另跑相关 e2e（5174/8788，串行，静音）。逐项报告实际结果、未测项和兼容性影响；不使用类型强转、mock 成功或跳过检查来掩盖问题；不推送，除非我说"提交 PR"。
