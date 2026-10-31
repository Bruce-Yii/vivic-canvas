> 历史归档：原路径 `docs/project-audit-20261016.md`。记录当时的需求与验证，不作为当前操作指令。当前入口：[README_FIRST](../../../README_FIRST.md)。

# Vivic 全项目 brief 核对 · 2026-10-16

本文冻结的是修复前 `dfefebd` 审计事实；随后已进行一期收尾，见 [当前修复及验证](finalization-20261016.md)。不要把下面记录的生产入口、契约漂移或旧断言直接当作当前仍未修复，也不要改写原审计证据。

核对基线：`agent/next-iteration`，`b620896`（业务代码最近提交 `a8b813c`）。本轮任务是检查完成度，未修改业务实现。

结论：**个人 Web MVP 主线和最新三项体验优化已实现，但不能宣布整个项目已全部完成并通过验收。** 还存在生产 Display 调试入口、JSON 契约落后于运行时代码、浏览器全套未通过，以及本地模型和真实设备验收未闭环。

## 核对依据与范围

- 入口：根 `AGENTS.md`、`README_FIRST.md`、`docs/AGENT_HANDOFF.md`。
- 当前 brief：`docs/experience-iteration-brief.md`，并以 2026-10-16 用户更新覆盖原提醒显示规则。
- 原始范围：`Vivic_Kimi_Handoff_v0.6/{PRD,ACCEPTANCE,COMPONENT_LOCK,CARD_CONTRACT}.md`。
- 实现：Web 控制/展示、卡片与布局、同步/持久化/撤销、结构化契约、本地 API、两种模型连接、搜索/数据/图片、提醒、语音及可选决策模型；核对相应测试和既有证据。
- 当前审计采用源码、实际检查和历史验收三种证据，下面明确区分；历史成功不改写为当前版本重新通过。

## 本轮实际检查

原始输出保存在本机忽略目录 `evidence/project-audit-20261016/`；可移植摘要见 [verification/project-audit-20261016.json](../../verification/project-audit-20261016.json)。

| 检查 | 结果 |
| --- | --- |
| `pnpm test` | Web 386、API 860，共 **1,246 通过**；另 3 项外部联网测试在常规命令中跳过 |
| `pnpm typecheck` | 通过 |
| `pnpm build` | 通过；保留 Sherpaw WASM/Node 分支提示及大 chunk 提示，主 JS 3,350.24 kB / gzip 1,033.75 kB |
| `pnpm --filter @vivic/web lint` | 退出码 0；**21 条 warning**，包含现有组件的 refs、effect、purity 和未使用变量提示 |
| Chromium 全套 | **88/90 通过，2 项失败**；失败原因见下文，未改断言后拼成全通过 |
| Firefox / WebKit 专项 | **46/46 通过**（各 23 项），覆盖新体验、子卡片/编号、天气/表格、合并提醒/批量撤销、固定与增长排版 |
| 显式公开网络测试 | `VIVIC_SEARCH_LIVE=1 VIVIC_DATA_LIVE=1`，3/3 通过；其中搜索诊断允许明确失败，因此另外做了下列产品路径探测 |
| 真实上海天气 | Open-Meteo 返回来源与当前天气 envelope；未用账号或模型 |
| 真实 Exa 无 Key 搜索 | 产品 `createSearchClient` 开启与应用一致的公网 DNS 备选，无凭据，返回 **5 条** HTTPS 来源，provider 为 `pi-web-access/exa-mcp-keyless` |
| 真实网页正文 | 同一受限 client 读取 `https://example.com/`，提取 156 字符，`format: extracted-text`、未截断 |
| 契约对照 | Ajv 2020 + 当前运行时 Zod：批量删除、重复提醒、条件提醒三份消息均是 **Zod 接受、交接 JSON Schema 拒绝** |
| 生产 Display 定向复核 | 真生产构建，普通路径无调试面板；`/display?dev=1` 出现 **1 个面板、10 个调试按钮**，且开发测试全局不存在，确认不是开发服务器误判 |

浏览器使用当前提交的隔离源码副本、独立 context、5174/8788，未打开用户真实画布。副本共享已安装依赖，因此仅为测试基础设施给副本 Vite 增加依赖目录访问范围，并关闭副本 pnpm 自动依赖检查；应用源码未改。最初字体路径被隔离副本拒绝的一次中断运行保留为 `chromium-setup-invalid.txt`，不计入结果。不同浏览器命令串行。

自动化没有物理麦克风或扬声器输出。语音用例只使用静音替身或 Chromium 合成输入；独立 context 内为验证状态而切换的 TTS 开关不影响用户偏好。未新登录、恢复连接或调用真实 StepFun/GPT 推理、搜索、图片、克隆接口。公开网络探测没有账号凭据。

本轮目视复核了实际生成的深色材质画布、窄屏正文详情与找卡截图；截图确认不能替代用户对视觉方向、真实输入法和设备流畅度的最终验收。

## 需要处理的发现

### 1. 生产 Display 可通过查询参数显示 Phase 0 调试面板

位置：`apps/web/src/display/DisplayApp.tsx:20`、`:53`，`apps/web/src/dev/DevPanel.tsx:98`。

`isDevPanel` 仅取决于 `?dev=1`，渲染时没有 `import.meta.env.DEV` 限制。相比之下，`window.__vivic` 的测试全局已经限制为开发环境。因此生产包仍能暴露 `DEV PANEL — PHASE 0 SCAFFOLD`、demo 创建、删除、撤销和主题按钮。这不符合原规约 Display 不展示调试/固定工具栏的要求；普通 `/display` 没有该面板。

本轮以 `pnpm build` 产物在 5174 单独提供静态服务复现，未启动后端，独立空 context；记录及实图为 `evidence/project-audit-20261016/production-display-probe.json`、`production-display-debug.png`。测试浏览器和静态服务均已关闭。

应将调试组件和对应入口限制到开发构建，并补生产构建下普通路径与 `?dev=1` 的覆盖。该发现针对产品交付边界，不表示后端凭据已经泄漏。

### 2. 交接 JSON Schema 与当前消息契约不一致

位置：`packages/contracts/src/actionEnvelope.ts:13`、`packages/contracts/src/cardRecord.ts:66`，对照 `Vivic_Kimi_Handoff_v0.6/contracts/action-envelope.schema.json`、`card-record.schema.json:31`。

- Zod 已允许 `cards.delete`，JSON action `oneOf` 中没有该动作。
- Zod 已允许 `schedule`、`condition`、时区及调度交付字段；JSON Countdown 的 `sourceData` 仍仅列五个旧字段并设置 `additionalProperties: false`。
- 实际复现：合法批量删除消息，以及各含一张合法重复/条件提醒卡的消息，运行时均接受，JSON Schema 均拒绝。

当前前后端及导入导出走共享 Zod，不能据此认定网页导入已经故障；但供外部/交接使用的 JSON 契约不再准确。应同步基础契约，或明确版本化并提供当前机器可读契约，同时验证两者一致。

### 3. Chromium 完整回归仍有两项失败

1. `tests/e2e/control.spec.ts:18`：创建唯一纯计时器后发送「放大倒计时」，focus 状态已经建立，但画布 transform 仍为 `translate(588px, 399.5px) scale(1)`。`CanvasView.tsx:218` 的聚焦缩放在原 zoom 为 1 时仍取 1；卡片原本已经居中，镜头无需平移。当前测试要求镜头必须变化，所以失败。应明确「放大」的幅度语义；若聚焦允许幂等，应让摄像机测试先建立非居中视图，并验证正确目标/密度，而不能把这次失败当作通过。
2. `tests/e2e/voice-input.spec.ts:57`：合成语音识别「10分钟后提醒我喝水」，Display 正确显示 `喝水09:59`，旧断言仍要求只有数字。该断言落后于用户 2026-10-16 对带事项提醒的明确修改，应更新并保留纯计时器只显示数字的独立验证。不能把正确的新提醒行为改回旧规则。

两项分别是聚焦/测试语义需要收敛、旧验收断言未同步，不应统称两处生产功能损坏。其他 88 项通过，包括新详情/找卡、子卡片/编号选择、批量删除撤销、固定避让/增长/旧画布、真实 Worker 合成输入及静音语音状态测试。

### 4. 本地决策模型仍是实验，尚无已满足中文要求的最终选型

`docs/local-decision.md` 与当前入口一致：Winnow-E4B 没有在这台 8GB M1 接入；Laya 原组合 NO_GO；Kev 默认关闭、禁止模型删除、严格放弃。已有的 180 条合成中文评测原始正确率 68.89%，过滤接纳 25/180，不是通用可靠路由。用户此前已明确 Kev 中文效果未满足要求，并将其他模型评估留作后续任务。

因此不能宣称原 D06 的专用路由选型已经完成；这不妨碍本地确定规则与 StepFun/GPT 主流程使用。本次没有下载模型或启动新评测。

### 5. 已实现的语音与设备能力仍缺最终现场验收

本人麦克风、默认「你好维维」的真实召回/误触发、真实噪声五分钟监听、输出设备热插拔、实际听感及真实 Plan 词级时间戳权限/同步，仍只有部分合成、替身或历史接口证据。

物理 Safari、系统中文输入法、外接屏及实际 GPU 流畅度尚未完成本人验收。Playwright WebKit 和合成 composition 事件不能替代这些项目。旧 30 分 2.577 秒、24/24 长测属于源码 `4db5446`，早于本次排版、详情和找卡；本轮最新版本已跑短性能/60 卡回归，但没有重新做三十分钟长测。

### 6. 当前状态文档存在相互矛盾的历史描述

`docs/implementation-status.md:5`、`docs/DELIVERY.md:5` 仍说排版/详情/找卡留待后续；`docs/experience-iteration-brief.md:5` 紧接完成说明又写「仍留给下一 case」。另有 GPT provenance 和实施表保留新 OAuth 未验收描述。

实际应以当前源码、`experience-20261016.md` 和最新交接为准：**三项体验已实现；用户参与的新 GPT 授权以及真实推理/搜索/图片已有 10 月 16 日记录。** 本轮没有再次消耗账号额度，这部分成功属于历史验收事实。旧 Exa 受阻结论也不能覆盖本轮无 Key 搜索成功。应整理当前状态入口并明确标注历史段落。

## 最新三项体验 brief 对照

| 要求 | 当前结论 | 核对入口 |
| --- | --- | --- |
| 保留批准组件和字体、统一中文正文/标题/来源/数字层级 | 已实现；真实挂载原组件 | `cards/vivicGUILibrary.tsx`、`cards/metrics.ts`、`index.css`、`stage/BackgroundLayer.tsx` |
| Grainient/Orb 保留，不给每张卡增加高成本 blur | 已实现 | `stage/`、卡片 tokens |
| 字体尺寸变化同步布局估算，避开固定卡、内容增长/撤销/旧画布恢复 | 已实现并有本轮 Chromium 几何回归；两固定卡互相重叠不自动挪动 | `state/canvasStore.ts`、`sync/controlHost.ts`、`tests/e2e/overlap.spec.ts` |
| Control 详情只存稳定 ID，从当前 store 读原文；不改 variant/布局 | 已实现 | `control/CardDetailsDialog.tsx` |
| 键盘、Escape、焦点恢复、滚动、文字选择与生命周期关闭 | 已实现；浏览器合成输入验证，真实系统 IME 另验 | `ControlDialogContent.tsx`、`experience.spec.ts` |
| Command/cmdk + pinyin-match，中文/全拼/首字母、类型/摘要/完整稳定 ID | 已实现 | `control/{QuickFind,QuickFindContent,cardSearch}.tsx/ts` |
| 动态加载、不在 Display 加载查找 chunk，只查当前活卡片 | 已实现 | `React.lazy`、`completedCountdown`/exiting 过滤及请求检查 |
| 选中只走既有 focus，不改内容、密度、固定；只读不接管 | 已实现；注意前述唯一居中卡片聚焦测试语义 | `QuickFindContent.tsx:38`、owner key 生命周期 |
| 子卡片、编号、提醒合并等复用，不重做 | 已实现 | `CardSubcardsSection`、`SubcardAnchor`、提醒展示投影 |
| 音色复刻、其他决策模型等不混入本次 UI | 范围遵守；既有实验仍保留 |

这三项可记为“实现完成且有自动化证据”，仍不能替代真实设备最终验收，也不能据此把整个 PRD 标为全完成。

## 原验收条款映射

“通过”仅指列出的技术/自动化或明确历史证据；“部分”表示有实现但对应门禁未闭环。没有将取消或暂缓范围算成应立即补开发的缺陷。

| 条款 | 状态 | 依据或缺口 |
| --- | --- | --- |
| A01 Grainient | 通过 | 真实组件与固定副本；当前浏览器背景检查 |
| A02 Orb | 通过 | 真 SmoothUI、黑色待机；当前 staging 检查 |
| A03 连续唤醒 | 通过 | Motion/遮罩实现，当前断言与短录屏 |
| A04 styled/minimal | 通过 | 真 styled registry；纯计时器仅数字，事项提醒遵循最新覆盖 |
| A05 画布/镜头 | 部分 | React Flow 正常；唯一居中卡片「放大」用例失败待收敛 |
| A06 字幕 | 通过 | 临时字幕、覆盖/取消及静音状态回归 |
| A07 tokens/用户认可 | 部分 | 统一 tokens、截图复核完成；最新材质仍需用户确认 |
| A08 减少动效 | 通过 | 当前系统偏好、窄屏和无高频闪烁实现/测试 |
| B01 双窗 | 通过 | 打开同源 Display，独立 context 双窗验证；外接屏本人另验 |
| B02 极简 Display | 部分 | 普通路径通过；生产 `?dev=1` 暴露调试面板 |
| B03 同步/幂等 | 通过 | owner/snapshot/patch、重复事件测试 |
| B04 重连/恢复 | 通过 | 当前双窗、刷新和断开重连用例 |
| B05 歧义/撤销 | 通过 | 编号候选、目标删除与整批撤销 |
| B06 多画布持久化 | 通过 | 创建/切换/保存/恢复/导入导出覆盖 |
| B07 严格 Schema | 部分 | 运行时拒绝未知字段；交接 JSON 契约存在漂移 |
| B08 focus/restore | 部分 | 不改数据/密度通过；镜头变化语义见失败用例 |
| C01 未连接降级 | 通过 | 断开/离线本地规则与明确错误 |
| C02 StepFun | 通过（实现＋历史实测） | Plan 目录与探测、内存 Key；本轮协议/断开回归 |
| C03 无 coding tools | 通过 | Pi 仅 Models/AuthStorage；function_call 拒绝测试，无 agent session |
| C04 无独立 Key 搜索 | 通过 | 本轮真实 Exa 5 条来源；历史 StepSearch/GPT 另有成功记录 |
| C05 失败降级 | 通过 | 无假结果、账号变更丢弃旧结果及错误回归 |
| C06 fetch/不可信正文 | 通过（技术边界） | DNS 全答案/每跳固定、私网/协议/大小/超时检查；正文不具执行通道 |
| C07 来源及引用 | 通过（实现＋历史实测） | 当前搜索来源/高亮回归；历史真实 GPT/浏览器搜索 |
| C08 Winnow/专用路由 | 未闭环 | Winnow 未接入、Kev 中文实验；已清楚降级，未冒称完成 |
| C09 当前请求图片 | 通过（实现＋历史实测） | 严格解码、显式发送、无视觉拒绝与清理回归 |
| C10 凭据隔离 | 通过（已查边界） | 后端内存、存储/DOM/Display/导出泄漏回归；非对所有未知漏洞的保证 |
| C11 GPT/Pi OAuth | 通过（实现＋历史实测） | 10 月 16 日本人新授权及真实能力记录；本轮固定 SDK 协议测试 |
| D01 共享 Action Engine | 通过 | 文字与合成 PTT 转写共享指令流程；旧显示断言另行修正 |
| D02 PTT 授权/降级 | 部分 | 合成 AudioWorklet、权限拒绝/取消通过；本人麦克风未验收 |
| D03 语音字幕/Orb | 部分 | 静音模拟、PCM/词轴覆盖；真实听感/Plan 时间戳未验收 |
| D04 真实数据 | 通过 | 本轮真天气/正文；明确数字、空表格/图表来源与负值回归 |
| D05 尺寸/压力/长期 | 部分 | 本轮 60 卡、窄屏、增长/固定/刷新及 10 秒性能；三十分钟证据为旧源码，真机未验收 |
| D06 降级 | 通过（自动化） | WebGL loss/hidden/减少动效、音频拒绝覆盖；真机性能仍需现场验证 |
| F 最低交付 | 部分 | 一键开发、lockfile、测试、许可/媒体证据齐备；全套失败和上述交付问题尚待收尾 |

## 不应重新计为当前欠账的范围

- 用户明确不要“所有浏览器关闭后仍准点提醒”；不开发原生后台或推送。
- 音色复刻由用户明确暂缓；现有 File ID 原型不等于真实克隆闭环，本轮不推进。
- 月/年、节假日和天气等外部条件提醒目前未实现，不属于最新三项体验 brief；已支持日期、间隔、每天/工作日/指定周几及画布内条件。
- Vanta/Clouds、日历、网页预览卡、第三种远程 LLM、新 OAuth 协议、桌面宿主、跨设备、音乐、会员等仍为研究/暂缓或 Roadmap，不能因旧表格中出现就擅自扩展。

建议收尾顺序：先封住生产调试入口、同步机器可读契约、处理两条失败用例及当前状态文档，再安排用户已保留的真实语音/输入法/Safari/外接屏验收；本地决策模型另按后续任务评估。
