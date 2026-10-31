# 场景识别与动态卡片（2026-10-17）

分支 `feature/scene-cards-v2`（工作树 `D:\商赛\vivic改-cards`，基于用户使用页分支 `feature/user-page`）。三个页面：用户使用页 `/`（只有文字/语音输入，其余是背景）、设置页 `/control`（用户使用页左上角设置按钮进入）、展示页 `/display`（副屏）。用户用自然语言提出需求时，模型只判断场景并给出结构化数据，程序校验后在展示页显示对应形式的卡片；展示页保留所有卡片，直到用户要求删除。需要时可把卡片拖到用户使用页任意位置操作，再拖回展示页。

## 链路

```
用户输入（Control）
  → /api/intent：精确规则 / 数据适配器 / 联网检索（原有，未改）
  → 规划模型（StepFun Coding Plan 或 GPT/Pi），系统提示附场景表
      输出 {"cards":[{"scene_id","card_type?","data"}],"spokenText"}，可与 actions 同时出现
  → 服务端 scenes/：payload 校验 → 防编造核对 → 构建 CardRecord → CardRecordSchema 全量校验
      失败：把校验标签回传模型重试一次；仍失败则向用户追问缺失信息，或退回模型的文字回答
  → ActionEnvelope（card.create）→ Control 唯一写入方 → 广播 → Display 渲染
  → 卡片注册表 CARD_VIEWS[type] → React 组件（错误隔离）
```

模型从不输出 id、布局、时间戳、HTML/JSX 或组件名；`card_type` 若给出必须与场景表一致。场景卡片不能通过原始 `actions` 直接创建（会被拒绝并要求改用 `cards`）。

## 场景 → 卡片 → 组件（唯一映射）

单一来源：`packages/contracts/src/scenes.ts`（`SCENES`、`SCENE_CARD_TYPE`、`SCENE_CARD_SIZES`），20 个场景对应 20 个互不相同的卡片类型。

| scene_id | card_type | 组件 | 说明 |
|---|---|---|---|
| countdown | CountdownCard | `cards/scene/views/CountdownDateView.tsx` | 复用并扩展原 CountdownCard：新增 `sourceData.event` 日期模式；纯计时器/事项提醒行为不变 |
| academic_paper | PaperCard | `cards/scene/views/PaperCardView.tsx` | 新增 |
| photo_gallery | GalleryCard | `cards/scene/views/GalleryCardView.tsx` | 新增，含 `cards/scene/Lightbox.tsx` |
| weekly_schedule | WeeklyScheduleCard | `cards/scene/views/WeeklyScheduleCardView.tsx` | 新增 |
| todo_list | TodoCard | `cards/TodoCardView.tsx` | 复用并升级：可选标题、进度、用户页勾选/增删 |
| project_roadmap | RoadmapCard | `cards/scene/views/RoadmapCardView.tsx` | 新增 |
| data_visualization | ChartCard | `cards/ChartCardView.tsx` | 复用 Recharts 图表：可选标题、用户页切换折线/柱状/饼图 |
| news_summary | NewsCard | `cards/scene/views/NewsCardView.tsx` | 新增 |
| historical_timeline | TimelineCard | `cards/scene/views/TimelineCardView.tsx` | 新增 |
| quote_note | QuoteCard | `cards/scene/views/QuoteCardView.tsx` | 新增；原 NoteCard 便笺保留为普通文本 |
| photo_story | StoryCarouselCard | `cards/scene/views/StoryCarouselCardView.tsx` | 新增 |
| activity_feed | ActivityFeedCard | `cards/scene/views/ActivityFeedCardView.tsx` | 新增；`live:"canvas"` 实时读取本画布卡片的创建/更新记录 |
| goal_progress | ProgressRingCard | `cards/scene/views/ProgressRingCardView.tsx` | 新增（轻量 SVG 环，未引入 Mantine） |
| habit_tracking | HabitHeatmapCard | `cards/scene/views/HabitHeatmapCardView.tsx` | 新增 |
| book_record | BookCard | `cards/scene/views/BookCardView.tsx` | 新增 |
| monthly_calendar | MonthCalendarCard | `cards/scene/views/MonthCalendarCardView.tsx` | 新增 |
| option_comparison | ComparisonCard | `cards/scene/views/ComparisonCardView.tsx` | 新增 |
| web_bookmark | LinkPreviewCard | `cards/scene/views/LinkPreviewCardView.tsx` | 新增 |
| photo_memory | PhotoCoverCard | `cards/scene/views/PhotoCoverCardView.tsx` | 新增 |
| single_notification | NotificationCard | `cards/scene/views/NotificationCardView.tsx` | 新增；“提醒我…”仍走原提醒 |

天气、便笺、表格、搜索结果和原计时器/提醒保持原有链路。所有类型由 `apps/web/src/cards/registry.tsx` 的 `CARD_VIEWS` 注册（TypeScript 强制每个类型都有组件）。

2026-10-21：设置页可用卡片清单旁新增 **Vivic Store** 入口，在新标签页打开 `https://edsionc.top/vivic/store`，用于后续添加新卡片。商店页面尚未创建，入口标注“即将上线”；当前不提供新的卡片安装能力。

## 数据与校验

- 卡片契约：`packages/contracts/src/sceneCards.ts`（17 个新类型，字段与列表均有上限，图片只能是 https 链接或本地 `media:` 引用）；`cardRecord.ts` 扩展 CountdownCard 日期模式、TodoCard/ChartCard 可选标题、`layout.surface`。旧记录全部兼容（新增字段均为可选），JSON 契约已重新生成。
- 模型 payload：`apps/local-api/src/scenes/payload.ts`；构建：`scenes/build.ts`；编排：`scenes/index.ts`；提示：`scenes/prompt.ts`；明确指定卡片形式：`scenes/explicit.ts`。
- 防编造（`scenes/grounding.ts`）：数字（含中文数字、万、%）、日期（含“还有 N 天”、相对日、星期、节日、“今年”=年底）、时间、链接、DOI、作者/出处/书名/方案名必须能在用户原话、澄清上下文、用户链接的页面正文或已有画布数据中找到；新闻/论文摘要须与原文有足够重合；没有记录的“最近动态”只能用画布实时动态；模型修改场景卡片时引入的新数字/日期/链接同样核对。
- 链接：用户给出单个 https 链接并要求摘要/收藏时，复用原有受限网页读取器读取一次，正文仅作为不可信资料和证据；卡片 `sources` 标注来源。读取失败不编造标题，仅保存链接并标注“未读取网页信息”。
- 冲突处理：长周期日期倒计时（“生日倒计时”“还有 30 天”）不再进入只支持一天内的分钟计时器抽取器；明确写出卡片形式（“做成时间线”“用月历展示”）时，模型若选了别的卡片会被要求改正或澄清。

## Display 与用户页

- 同一个组件两种模式（`cards/scene/cardContext.ts`）：Display 只读浏览（翻页、切月份、看大图、详情弹层），高度严格等于布局高度、长内容裁切或在卡片内滚动；用户页可编辑（勾选、调进度、改日期、增删条目、添加照片），所有修改都走所有者的 `card.update` 并按卡片 schema 重新校验，未通过时卡片保持原样并提示。
- 统一外观：`cards/scene/SceneCardShell.tsx` + `sceneCards.css`（沿用 shadcn/aui 颜色、圆角与字体，新增两枚集中定义的强调色变量），深浅主题与窄屏均已检查。
- 卡片位置 `layout.surface`：缺省为副屏；`"user"` 表示在用户页。用户页卡片不参与副屏排版、聚焦或调暗。
- 拖拽（`cards/surfaceDrag.ts`）：展示页卡片悬停时顶部出现把手，拖到用户使用页松手处即放下（`layout.userPos` 记录位置，窄屏自动收进可见范围）；在用户使用页用同一把手换位置，拖回展示页窗口则落在松手位置；悬停时也有“放回副屏”“删除”小按钮。两个窗口间使用浏览器原生拖放（同一浏览器）；展示页只能请求“把卡片放回画布”，移出操作由用户使用页（唯一写入方）执行。
- 用户使用页：不保留对话记录，只有输入框；每次指令只在输入框上方短暂显示一行状态（进行中或待回答的澄清会保持显示）。卡片层组件 `apps/web/src/control/UserCardLayer.tsx`。2026-10-21 起，设置页的模型配置下方展示全部 24 类已接入卡片：本地指令 3 类、模型场景 17 类、数据与联网 4 类，来源为共享卡片名称和场景注册表。清单随当前选中模型的连接状态更新，未连接时标明接入条件；数据/联网卡片标明数据或服务要求。原有“卡片与子卡片”保持不变。
- 背景：展示页取消待机黑幕，从待机到工作始终与用户使用页同一“流光以太”背景，Orb 仍居中（`stage/AwakeningClock.tsx` 只负责从唤醒进入工作态）。

## 照片

照片只来自用户给出的 https 链接，或在用户页卡片上点“添加照片”从本机选择。本机照片会在浏览器内解码、缩放并重新编码（去除 EXIF/GPS），存入独立的 IndexedDB `vivic-media`，卡片只保存 `media:` 引用；“清除本地数据”会一并清除，启动时清理无卡片引用的照片。发送给模型做图像分析的附件仍只用于当次请求，不会自动存进卡片。

## 测试入口

- Card Playground（仅开发构建）：`/playground`，20 张卡片 + 边界样例，副屏/用户页并排，浅色/深色、手机宽度；示例数据只在页面内存中，不连接真实画布。它只是辅助，不能替代真实聊天链路。
- 自动化：
  - API 单测 `apps/local-api/tests/scenes.test.ts`（20 个场景的真实中文输入、易混淆输入、防编造、指定卡片、组合动作、规划器集成）。
  - Web 单测：`cards/__tests__/sceneCards.test.tsx`、`sync/__tests__/cardSurface.test.ts`、`reminders/__tests__/dateCountdown.test.ts`。
  - 浏览器 `apps/web/tests/e2e/scene-cards.spec.ts`。
- 真实模型抽查（会消耗所连模型的额度，按需手动运行）：`node apps/local-api/node_modules/tsx/dist/cli.mjs scripts/verify-scene-cards-live.ts <web 地址> [--connect-gpt] [--only <scene_id>]`，结果写入被忽略的 `evidence/scene-cards/`。
- Playwright 端口被其他项目占用时，可用 `VIVIC_E2E_WEB_PORT` / `VIVIC_E2E_API_PORT` / `VIVIC_E2E_STUB_PORT` 改到空闲端口，默认值不变。

## 已知限制

- 跨窗口拖拽依赖同一浏览器的原生拖放；两个窗口在不同浏览器时请用按钮。触屏设备没有原生跨窗口拖放，同样使用按钮。
- 方案对比中的文字型取值（如“采光好”）无法逐字核对，只核对数字与方案名；论文/新闻摘要按与原文的重合度核对，属于启发式。
- 场景识别依赖已连接的模型；未连接模型时只能用本地规则，场景卡片不可用（如实提示）。
- 导出画布 JSON 不包含本机照片文件，只保留 `media:` 引用。
