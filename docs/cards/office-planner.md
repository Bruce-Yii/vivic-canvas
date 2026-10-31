# 办公与个人计划卡片

2026-10-22。基于 Vivic `8655a524f618d8a3d5fa0280cb1e6f87eeaf0c51` 的声明式包宿主扩展；不新增 cardType、不执行包代码。TODAY 参考和独立实现的边界见 [迁移映射](../research/today-office-planner-mapping.md)。

## 卡片范围与入口

| 卡片 | 包 ID / 场景 | 用途 | 与已有能力的区别 |
| --- | --- | --- | --- |
| 工作推进卡 | `vivic.office-tasks` / `ext.vivic.office-tasks` | 工作事项、负责人、原文截止说明、优先级、受阻和完成 | 不替代数值目标进度；补全每项行动的责任与状态 |
| 会议行动卡 | `vivic.office-meeting` / `ext.vivic.office-meeting` | 用户提供的会议结论与后续行动 | 不创建会议，不查询真实日程 |
| 每周重点卡 | `vivic.office-week` / `ext.vivic.office-week` | 按星期分组的个人重点行动 | 不替代带时间轴的 WeeklySchedule；未安排项目保留在“待安排” |

设置 `/control` → 扩展卡片管理 → 对应办公卡片 → Test Space 预览/试跑 → 安装。安装只加入定义；选择“从 DEMO 创建卡片”才会将虚构样例写入当前画布。也可安装后在用户页输入以下文字，调用已经连接的模型：

- `用工作推进卡整理发布准备：我负责整理评审材料，周四下午截止，正在进行；确认反馈清单，待办；检查发布说明，周五截止。`
- `用会议行动卡整理这些笔记：结论是先完善新手引导。我负责补全文案，下周一截止；同事甲核对截图，下周二截止，正在等待新版页面。`
- `用每周重点卡整理本周：周一完成方案大纲，已经完成；周三评审交互稿，正在进行；周五整理周回顾，待办。`

动态场景使用现有 `enabledPlannerDefinitions` → `extensionScenePrompt` → `buildAllSceneActions`。只有已安装且启用的定义进入请求；按确切卡名/ID 注入对应 Schema。模型输出 `config/data/state`，由后端生成外层 ID、时间、布局与 Action；缺信息时留空或澄清。不宣称所有不带卡名的泛化话术都已命中。

## 数据与编辑合同

三个包都是 `formatVersion:0.1`、`renderer:declarative`、`capabilities:[]`、版本 `1.0.0`。JSON Schema 是范围的执行依据：[工作推进](../../examples/card-packages/office-tasks)、[会议行动](../../examples/card-packages/office-meeting)、[每周重点](../../examples/card-packages/office-week)。所有对象 `additionalProperties:false`，没有 HTML、表达式或工具权限。

| 路径 | 类型、范围与默认 | 来源 | 编辑与副作用 | 保存 |
| --- | --- | --- | --- | --- |
| `config.title` | 必填 string，1–80 字符 | 用户标题；没有标题时采用用途名 | 参数面板；更新标题 | 是 |
| `config.context` | 可选 string，≤1200，默认空 | 用户提供的计划说明/会议结论 | 参数面板，多行文本 | 是 |
| `config.period` | 周重点可选 string，≤80，默认空 | 用户周期原文，如“下周” | 参数面板；不推导具体日期 | 是 |
| `data.origin` | 必填 `user` 或 `demo` | 构建时声明 | 只读；不接受 live/provider/sourceToken | 是 |
| `state.items` | 必填 array，0–40 项 | 用户事项或明确 DEMO | 新增、编辑、删除、完成；发送完整新数组 | 是 |
| `items[].id` | 必填 string，1–64 | 模型生成条目内标识；本地新增由 UI 生成 | 不提供编辑控件；保留既有 ID，UI 按当前行索引修改以兼容重复输入 ID | 是 |
| `items[].title` | 必填 string，1–160 | 用户行动原文/整理 | 行内表单；空标题不能提交 | 是 |
| `items[].owner` | 可选 string，≤80，默认空 | 用户明确提到的负责人 | 行内文本；不解析/通知通讯录用户 | 是 |
| `items[].due` | 可选 string，≤100，默认空 | 用户给出的截止原文 | 行内文本；不创建日程/提醒 | 是 |
| `items[].status` | 必填 待办/进行中/受阻/完成；新项待办 | 用户状态或本地编辑 | checkbox 完成/回到待办，表单可选全部状态 | 是 |
| `items[].priority` | 工作推进可选 重点/常规/稍后；默认常规 | 用户优先级或默认值 | 行内选择器 | 是 |
| `items[].day` | 每周重点可选 周一…周日/待安排；默认待安排 | 用户星期 | 行内选择器；未指定留待安排 | 是 |
| `items[].note` | 可选 string，≤500，默认空 | 用户备注 | 行内多行文本 | 是 |
| `state.note` | 可选 string，≤1000，默认空 | 用户个人备注 | 参数面板 | 是 |
| 完成计数/百分比 | 从完成项数/总项数确定计算；空列表0 | 派生 | 不接收模型数值 | 不单独保存 |
| 编辑草稿、错误、单步撤销快照 | React 临时状态 | 本次页面交互 | 取消不写入；离开/刷新会清除撤销快照 | 否 |

所有编辑通过 `useCardEditor.patch` → `CardActions` → owner `card.update`，完成完整实例 Schema 与宿主字段策略检查。`data/def` 不能普通更新。单步“撤销上次编辑”仅在当前 `config/state` 仍等于本次提交结果时启用，防止覆盖其他编辑；原来受阻/进行中的状态也能准确恢复。更早历史、跨刷新编辑撤销不在本组件范围；宿主已有删除撤销仍照常使用。

## 来源与安全边界

- `user` 显示“用户输入”；用户粘贴飞书笔记仍只是用户提供的副本，不冒充受控飞书读取证据。固定范围提示为“本地整理，未同步外部日历”。
- `demo` 显示“DEMO · 虚构样例”，示例标题也有 DEMO；Test Space 额外强制 DEMO。清空/改写标题不会去掉来源标记。
- 本轮不接飞书 MCP、不创建/修改真实日程、不发送消息。将来受控飞书事实要走单独 ProviderResult/来源引用协议，不能给本包补一个随意编辑的 live 字段。
- `sources:[]` 与 `sourceData:{}` 沿用纯用户扩展卡合同。已有后端会核对数值、完整 ISO 日期和 URL；自然语言负责人、截止描述和结论不是连接器验证的事实。内容经 React 转义，标签字符串不执行。
- 自有包由同一 `parsePackageFiles` 校验并生成内容 hash。专用 UI 只认校验后的 `definitionRef` 精确匹配；同 ID/版本但内容不同的包回退通用宿主，不能因名称相同获得专用 renderer。升级包时不手工维护 hash。

## 视觉与双模式

复用现有 `SceneCardShell`、SceneEmpty、`.vivic-scene-*` 表单/按钮、Lucide、宿主字体和主题变量。不是第二套卡片注册器。标题→说明/结论→派生进度→任务行→动作的层次保持一致；星期分组仅在周重点出现。

默认沿用 ExtensionCard 用户创建 `360×340`、模型创建 `360×300`；宿主自动布局保持原规则。用户页内容自然增长；Display 固定高度下任务区滚动，控件只读。标题/负责人/备注长文本换行；空列表提供明确提示。工作行局部圆角16px、间距8px、文字13px、150ms颜色过渡均为 Vivic 适配选择；减少动态效果时关闭过渡。深浅色仅使用宿主 token，12种背景仍由宿主管理。

## 实现与集成接口

- `apps/web/src/cards/office/builtinOfficePackages.ts`：`OFFICE_PLANNER_CATALOG`、`loadBuiltinOfficeDefinitions(): Promise<CardDefinition[]>`、`officePlannerKind(definition)`。
- `useOfficePlannerKind.ts`：`useOfficePlannerKind(definition)`；`OfficePlannerCardView.tsx`：`<OfficePlannerCardView card height definition kind preview />`。父宿主先完成正常定义/实例校验，再按返回 kind 调用；未知包保持 `ExtensionCardView`。
- `officePlanner.css` 只含局部样式，不修改全局 tokens/React Flow。
- ExtensionManager 的内置预览仍走 `TestSpaceSession`，没有直接安装捷径；通用卡片的原始 SchemaForm 仍可用。

## 验证记录

本轮已完成：3个包目录校验；每包3个样例；API新增4项通过（实际 pipeline、fixture 模型、动态 Schema、非法来源/状态/字段、缺失定义、全批次失败）；Web新增7项通过（精确包身份、双模式、转义、owner 完成/撤销/保存、非法修改拒绝、失败反馈与陈旧撤销）。单测不请求真实模型或服务。

`apps/web/tests/e2e/office-planner.spec.ts` 定义3条隔离浏览器验收：12配色/空/长/窄屏；编辑/完成/撤销/传送/刷新；明确卡名经真实 API 与 fixture StepFun 响应生成三类型。该文件交由集成负责人在 `5186/8796` 串行运行；最终浏览器截图、真实模型抽样与全量结果以本轮集成验收记录为准。

命令：`corepack pnpm --filter @vivic/web test src/cards/office/__tests__/officePlanner.test.tsx`；`corepack pnpm --filter @vivic/local-api test tests/office-planner-packages.test.ts`。打包使用现有 `card:pack`，不把 JSON 改后缀冒充 ZIP。
