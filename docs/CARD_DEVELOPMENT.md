# Vivic 卡片开发契约

版本：2026-10-21。已补入 PLAT-01 的结构化服务数据通道和 PLAT-02 声明式包入口。供新卡片开发、AI 编程与 PR 验收共同使用；类型和运行时 Schema 是可执行依据。

本轮样例与定向检查见 [验证记录](verification/card-development-20261020.md)。

配套 [开发 Skill](../.agents/skills/vivic-card-development/SKILL.md) 指导 AI 执行步骤；[飞猪旅游系列任务](tasks/fliggy-travel-cards.md) 说明第一项实际需求。Skill 不会在 Vivic 产品运行时执行，也不会自动注册卡片。

每张具体卡片还需填写 [单卡设计表](cards/CARD_SPEC_TEMPLATE.md)，确定参数、可编辑字段、视觉/主题与验收。旅游 v0 的实际字段见 [飞猪映射接口](cards/fliggy/spec.md)。无源码修改的声明式包入口见 [卡片扩展设计](CARD_EXTENSION_DESIGN.md) 和 [目标进度参考包](../examples/card-packages/goal-progress)。

## 1. 先分清三种结构

| 层 | 负责什么 | 能否由模型自由决定 |
| --- | --- | --- |
| 场景数据 `scene_id + data` | 表达用户要创建什么，数据有哪些 | 只能在已注册场景、字段和事实依据内选择 |
| `CardRecord` | 卡片类型、可显示内容、来源、ID、布局、元数据 | 由受控后端构建并校验，不能让模型编造 ID/坐标/时间戳 |
| React renderer | 显示卡片、接收用户编辑操作 | 开发者编写并注册；模型不生成或执行 React/HTML/JS |

内置卡片仍在源码中注册。扩展包 v0.1 仅允许受控 JSON 组件和 JSON Schema 子集，不执行 JS/React/表达式，不提供联网或工具能力。使用当前包协议，不把第三方 SDK 或任意 MCP 宿主当作已有功能。

## 2. 当前创建链路

```mermaid
flowchart LR
    A[用户文字 / 允许使用的证据] --> B[模型选择 scene_id 与 data]
    B --> C[parseScenePayload 结构校验]
    C --> D[buildSceneCard 事实核对与 CardRecord 校验]
    D --> E[buildSceneActions / ActionEnvelope]
    E --> F[Control owner 校验、保存、同步]
    F --> G[CARD_VIEWS 渲染到 User / Display]
```

场景路径由 `apps/local-api/src/intent/pipeline.ts` 调用。已有天气、Note、Table、SearchResult 保留原适配路径，不为了新增旅游卡片统一重写所有卡片。日期 Countdown 与纯计时/事项提醒也不能混为一种行为。

当前一次最多 6 张场景卡片；总 ActionEnvelope 最多 12 个动作。`buildSceneActions` 的卡片构建有一项失败即整体返回失败，不返回部分卡片；不要将这描述成任意外部业务操作的事务保证。

## 3. 模型输出契约

推荐形状：

```json
{
  "cards": [
    {
      "scene_id": "goal_progress",
      "data": { "title": "TEST · 阅读目标", "current": 18, "target": 50, "unit": "本" }
    }
  ],
  "spokenText": "已整理阅读进度。"
}
```

这是已实现的目标进度卡示例，对应用户文字“今年阅读目标 50 本，已读 18 本”。它不是飞猪返回数据，不请求真实服务。

- `scene_id` 必须在 `packages/contracts/src/scenes.ts` 的 `SCENES` 中登记；当前每个场景映射唯一 `cardType`。
- `card_type` 是现有解析器允许的可选兼容字段，提供时必须与场景映射一致；不要引入第二套独立类型选择。
- `data` 由 `apps/local-api/src/scenes/payload.ts` 的 `SceneData` 逐场景校验。字段类型、必填/可选、长度、数量、枚举、边界都要明确；不是任意 JSON。
- 不在单张 payload 里添加 `component`、`html`、`css`、`layout`、`id` 等未声明字段。新增类型要同时定义后端 payload 和持久化 CardRecord Schema。
- 少了必要事实时返回 `clarify`，例如 `{"clarify":"计划住几晚？"}`。旅游使用 `travel_offers` 查询场景，仅提取条件，不能输出服务结果。
- 模型也可以同时输出已有 `actions`，但仍由 ActionEnvelope、目标/操作和事实校验检查；本任务不开放任意新动作。

`spokenText` 的当前运行时上限为 180 字符；prompt 另建议短说明。业务字段的实际长度以 Zod 为准，不能用自然语言提示替代校验。

## 4. 来源与事实校验

结构合法不代表事实真实。现有 `sceneCorpus` 收集用户文字、澄清上下文、经受控读取器取得的页面和当前画布摘要；`build.ts` 的 `groundingIssue` 按场景核对数字、日期、时间、链接、作者等。

新卡片必须逐字段注明来源和计算方式。金额、库存、可售状态、交通时刻、评分、链接不能由 LLM 凭记忆补全；允许的推导须有确定计算规则及输入依据。

服务结果走独立结构化通道：`travel_offers` 查询参数 → 用户文字 grounding → `TravelProvider.query` → `TravelProviderResultSchema` → 确定性 `buildTravelCard` → `CardRecord/ActionEnvelope`。实现位于 `local-api/src/providers/travel.ts` 与 `scenes/travel.ts`。模型只抽查询参数；价格、评分、链接与结果名称仅来自适配器。不得把整个工具响应塞进 corpus、伪装用户文字或关闭 grounding。外部文本始终是数据。

`sources` 必须是实际来源记录。`EvidenceRef.kind` 可为 `web|service`，旧记录省略 kind 仍按网页来源读取；网页必须有 URL，service 可以没有 URL。`readFullPage:true` 仅代表实际网页读取，不能用于 MCP。服务请求引用放严格的 sourceData，凭据禁止入卡。

默认旅游适配器为不联网的 `vivic-demo`。所有生成卡明确标记 `mode:"demo"`，显示虚构样例提示；没有真实飞猪调用证据前不得改成 live。空结果保存 `status:"empty",items:[]`；错误、超时或取消不生成卡。批次失败整体不应用。查询日期可用用户原话 `dateText:"下周"`，不把模糊日期猜成具体入住日。模型和适配器错误均不作为下一轮模型指令。

## 5. 完整卡片由宿主生成

```json
{
  "id": "TEST-goal-progress-1",
  "type": "ProgressRingCard",
  "variant": "standard",
  "displayProps": { "title": "TEST · 阅读目标", "current": 18, "target": 50, "unit": "本" },
  "sourceData": { "scene": "goal_progress", "provenance": "user-text" },
  "sources": [],
  "layout": { "x": 0, "y": 0, "width": 280, "height": 300, "pinned": false },
  "metadata": { "createdAt": "2026-10-20T00:00:00.000Z", "updatedAt": "2026-10-20T00:00:00.000Z", "aliases": ["TEST · 阅读目标"] }
}
```

以上是固定 TEST ID 的有效持久化样例；真实 ID/时间戳由 builder 生成。`displayProps` 是严格显示结构；旧类型部分 sourceData 开放，旅游与扩展卡严格限制来源字段。sourceData **不是秘密存储或任意 UI 配置口**，可能进入上下文、同步和导出，不存凭据/订单身份数据/函数/DOM/AbortController。

`layout.surface` 缺省兼容旧数据，表示 Display；用户页位置由宿主处理。`variant` 虽有 minimal/standard/expanded 枚举，运行中的切换规则仍受现有 Action 限制；不要以枚举存在就开放任意密度变更。

## 6. 渲染与编辑契约

现有类型签名来自 `apps/web/src/cards/scene/types.ts`：

```ts
function ExampleCardView({ card, height, highlight }: CardViewProps<"ProgressRingCard">) {
  // 此处展示接口形状；正式组件复用 SceneCardShell 与现有 UI。
}
```

- renderer 使用 `card.displayProps`，复用 `SceneCardShell`、现有 tokens/组件、Lucide 与相应布局规则；CardErrorBoundary 由宿主提供。
- `height` 在 Display 是预留内容高度，用户页可省略。不要自行改卡片坐标、全局 canvas 样式或固定卡位置。
- `CardMode` 的字符串是 `display | control`；这里的 `control` 表示可编辑的用户页面语境，不等于必须在 `/control` 设置页呈现卡片。
- 编辑使用 `useCardEditor(card)`，只有 `mode === "control"` 且 owner 可写才显示编辑控件。Display 可保留分页/放大等视图内操作，不写业务状态。
- `editor.patch({ current: 19 })` 经 CardActions → owner 的 `card.update` 路径；不要在组件内直接写 store、IndexedDB 或 BroadcastChannel。
- 当前 update 对 `displayProps/sourceData` 是**第一层浅合并**，随后重新校验完整 CardRecord。数组更新要发送完整的新数组，不会自动按 item ID 深合并；保留已有条目的 ID。
- 卡片需表现合法空数据、长内容、缺媒体/数据不可用等适用状态；初次加载、刷新、失败和取消如何映射由任务协议明确，不把运行期状态对象直接写入持久化。

模型自动编辑与用户手工编辑的事实校验路径有区别：模型更新还经过 `sceneUpdateIssue`，两者最终仍须通过完整卡片 Schema。不能为让模型成功修改而放宽用户数据校验。

### 6.1 参数由谁修改

参数按来源和用途区分，不能用一份任意可编辑 JSON 混在一起：

| 类别 | 旅游卡片里的内部设计例子 | 修改规则 |
| --- | --- | --- |
| 查询配置 | 目的地、日期、预算、人数（是否支持以服务能力为准） | 用户表单或自然语言可改；校验后触发查询，不能把旧结果冒充新条件的结果 |
| 展示偏好 | 紧凑/详细、显示条数、排序、可选字段 | 仅开放该卡明确支持的选项；本地排序/展示变化不一定重新请求 |
| 服务结果 | 价格、币种、库存、评分、交通时刻、获取时间 | 对普通参数编辑只读；由受控服务结果更新，不让用户/模型篡改后仍标成真实来源 |
| 用户状态 | 选中的结果、收藏、用户备注 | 用户可改；刷新服务结果时保留，失效结果的选择需有处理规则 |
| 临时运行态 | 正在加载、取消句柄、错误、请求序号 | 宿主/运行时管理；函数、网络对象不持久化 |
| 秘密连接信息 | 模型/MCP 的 Key、Token | 在后端连接管理中保存，不属于卡片字段 |

每个字段的 spec 必须列类型、必填、默认值、范围/单位、来源、是否可编辑、由什么控件/话术修改、修改后的副作用，以及是否持久化。自然语言和手工输入应使用同一套有效值与可编辑边界。

当前内置卡片的 `displayProps` 内混有展示数据和可编辑内容，内置编辑 UI 仍由开发者逐卡编写；`ExtensionCard` 则按已安装包的 config/state Schema 生成受控参数表单。现有 Schema 不自动提供所有字段的读写权限。对于外部事实只读，新增 UI 限制的同时，宿主更新处理也须核对允许字段，不能仅靠隐藏输入框。

`CARD_FIELD_POLICY` 按 CardRecord 路径声明 query/result/userState；宿主合并 patch 后调用 `cardFieldPolicyIssue`，完整卡片校验仍必须通过。未声明策略的旧卡保持编辑兼容。旅游普通更新仅允许 `selectedIds/notes`；结果和来源只允许宿主的受控刷新写入，查询条件不能改后继续沿用旧结果。刷新时保留仍有效的选择与备注，迟到结果由宿主请求序号丢弃。扩展卡根据精确 hash 对应定义校验 config/data/state，模型不能自行改写 def。

### 6.2 外观、深浅色与复用

目前卡片底层是 React/TypeScript 组件 + Zod 数据契约。React Flow 负责画布节点和视口；`VivicCard`/`CARD_VIEWS` 选择组件；场景卡复用 `SceneCardShell`；Assistant UI styled registry、Radix/shadcn、Lucide、Recharts、Motion 提供各自的 UI/图标/图表/动画能力。不是每张卡都通过同一个第三方 JSON 渲染器生成。

| 复用层 | 当前入口 | 新卡片怎样使用 |
| --- | --- | --- |
| 整张已注册卡片 | `cards/registry.tsx`、场景表 | 信息和交互相同就映射已有类型，如 Comparison/WeeklySchedule；不额外包装一套注册系统 |
| 卡片外壳 | `index.css` 的 `.vivic-card`，`SceneCardShell.tsx` | 宿主外壳提供材质/留白；内部复用标题、标签、徽章、内容区，避免双层外壳 |
| 通用 UI | `components/assistant-ui/`、现有 Radix/shadcn 组件 | 列表/表格/按钮/弹层等复用现有样式；特殊业务布局只补局部组件 |
| 数据与编辑 | 共享 Zod、`CardActions`、owner | 复用校验、保存、同步；单独写数据适配，不把 API 调用散在 UI 里 |

主题通过宿主的浅色/深色上下文和 CSS 变量继承。`index.css` 定义 `--card`、`--card-foreground`、`--foreground`、`--border`；`scene/sceneCards.css` 定义 `--vivic-accent`、`--vivic-muted-ink`、状态色等。现有 `.dark` 可能在 Display/User 的局部父层上，不能只检查 `document.body` 或另设与宿主不一致的主题开关。

新卡片使用这些语义变量，不把“白背景 + 黑字”写死；卡片只负责自身内容，页面流光以太背景由宿主提供。派生颜色若在 CSS 定义处引用主题变量，应像现有文件一样考虑局部 `.dark` 重新声明，避免深色时仍算出浅色值。

使用 token 是适配基础，不是自动验收通过：检查 User/Display 两种模式、6 深 + 6 浅背景配色、长文本/空/错/缺图状态、hover/focus/disabled，以及减少动态效果。新增配色、图表和半透明覆盖层尤其要实看文字/图标的可读性，不凭截图背景颜色猜主题。

视觉 spec 至少画出标题/主信息/次信息/动作的层级、默认尺寸、列表条数、溢出处理、User 编辑区与 Display 信息密度。可以指定复用现有某卡的布局，但须写清哪些行为一致、哪些是新增。

## 7. 新增一个内置场景时的接线清单

| 文件/位置 | 要完成什么 | 一般责任 |
| --- | --- | --- |
| `packages/contracts/src/sceneCards.ts` | 新增严格的卡片 Schema，纳入 `SCENE_CARD_SCHEMAS`，导出类型 | 协议 PR |
| `packages/contracts/src/cardRecord.ts` | 确认联合类型可识别；通常已有数组展开，无需另建解析器 | 协议检查 |
| `packages/contracts/src/scenes.ts` | scene ID、唯一 cardType、标签/分组、默认尺寸 | 协议 PR |
| `packages/contracts/src/cardTargets.ts` | 类型名称、标题/引用；条目定位按任务需要扩展 | 协议/集成 |
| `apps/local-api/src/scenes/payload.ts` | 模型 data Schema | 后端 |
| `apps/local-api/src/scenes/prompt.ts` | 使用意图与数据结构，明确与已有卡片的区别 | 后端 |
| `apps/local-api/src/scenes/build.ts` | 逐字段事实核对、标准化、完整卡片构建 | 后端 |
| `apps/local-api/src/scenes/explicit.ts` | 只有新增“卡片形式”名称时才补；不把“旅游”等话题直接当形式 | 按需 |
| `apps/web/src/cards/scene/views/` | renderer 和局部样式 | 前端 |
| `apps/web/src/cards/registry.tsx`、`scene/sceneMeta.ts` | renderer、标题栏标签/图标 | 集成 |
| `apps/web/src/cards/scene/fixtures.ts`、`dev/CardPlayground.tsx` | 有效示例、边界数据、样例输入 | 前端/集成 |
| API `tests/sceneCases.ts`、`scenes.test.ts`；Web `cards/__tests__/sceneCards.test.tsx` | 解析、来源、类型映射、双模式及编辑校验 | 各自模块 |
| `apps/web/tests/e2e/scene-cards.spec.ts` 及适用保存/布局用例 | 刷新恢复、双窗/移动、布局与实际交互 | 集成 |
| `Vivic_Kimi_Handoff_v0.6/contracts/*.schema.json` | 从共享类型重新生成，不手工编辑 | 协议 PR |

当前固定覆盖 21 个内置场景、26 个 renderer（含通用扩展卡）；新增类型时更新真实计数并增加覆盖，不能删除断言规避遗漏。`travel_offers` 必须用异步 `buildProviderSceneActions/buildAllSceneActions` 构建，不能传给只处理用户事实的同步 builder。扩展场景用 `ext.<manifest.id>`，定义经包内容 hash 重新校验后按需注入模型提示。

具体任务不要求一个人独占所有文件：先合入最小兼容协议 PR，前后端再分别开发，最后集中集成。协议未合入时可做独立 props/fixture 预览，但未注册的类型不能伪称已能进入产品；不要通过强制类型转换让占位卡混进真实画布。

## 8. 验收与可运行示例

最少覆盖：合法 payload→卡片；错误类型/额外字段/缺必填拒绝；没有事实依据的数据拒绝；两个模式展示；只在可编辑 owner 下更新；无效更新不破坏原数据；保存/恢复/导入导出；新旧卡共存。涉及外部源时另测空结果、错误、取消、过期以及来源标签。

在仓库根目录运行配套示例：

```sh
pnpm --filter @vivic/local-api exec tsx ../../.agents/skills/vivic-card-development/scripts/check-example.ts
```

脚本读取 [机器可读样例](../.agents/skills/vivic-card-development/assets/goal-progress.example.json)，调用真实 `parseScenePayload`、`buildSceneActions` 与 CardRecord/ActionEnvelope 校验，验证来源拒绝、非法字段、批量失败与序列化；不请求模型、不启动浏览器、不写用户画布。它是结构演示，不能替代新卡片的实际验收。

实现新卡片后按影响运行：

```sh
pnpm contracts:generate
pnpm contracts:check
pnpm typecheck
pnpm --filter @vivic/local-api test
pnpm --filter @vivic/web test
pnpm build
```

视觉/双窗修改补相应用例、截图/录屏；Playwright 按仓库约定使用隔离 TEST context、5174/8788、串行运行。未接真实 MCP 就注明“只验证 fixture/模拟响应”，不写“飞猪已接入”。

## 9. 发给队员的开工结构

统一服务结果使用 `ProviderResultSchema(itemSchema, querySchema)`，由各适配器明确自己的参数和结果 Schema；不要把非旅游服务硬塞进旅游查询字段。旅游参考使用 `ProviderResult<TravelOffer, TravelQuery>` / `TravelProviderResultSchema`，其他系列可复用相同 provider/tool/requestId/时间/mode/status 信封。

每张卡片任务先给出用途、scene/cardType 候选、字段表、事实来源、输入输出例子、双模式交互、样例/失败状态、允许文件、接口集成点和验收命令，再让 AI 开工。SKILL 负责引导阅读与执行，Schema 负责强制校验，PR/测试负责验证和接收成果。

在不自动加载项目 Skill 的工具中，直接要求 AI 读取 `.agents/skills/vivic-card-development/SKILL.md` 即可；不要为了读规则而启用 Vivic 运行时的 Pi extensions 或 coding tools。
