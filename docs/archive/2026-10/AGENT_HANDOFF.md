> 历史归档：原路径 `docs/AGENT_HANDOFF.md`。记录当时的需求与验证，不作为当前操作指令。当前入口：[README_FIRST](../../../README_FIRST.md)。

# 下一位 Agent：Vivic 交接

## 2026-10-19：本地优先与协作准备

用户最新要求先做完整本地功能，再讨论服务器、多账号和免费/付费；现在由本人开发，后续按任务给新人分工。执行入口为 [本地开发路线](../../LOCAL_ROADMAP.md) 与 [贡献指南](../../../CONTRIBUTING.md)。已准备任务/缺陷/PR 模板及 Linux/Windows CI 配置，未创建线上看板、Issue 或协作者邀请；新功能仍按路线分项实施。

当前仓库 `ECdison6227/vivic-canvas`，集成分支 `main`，准备工作分支 `chore/local-development-workflow`；核对实际 `git status` 后继续。下文旧仓库、旧端口、旧工作目录及旧基线仅作历史，Git 操作以 [最新约定](../../GIT_WORKFLOW.md) 为准。

本机锁定安装、契约/类型/构建通过，单测 web 520 + API 1,070 通过、3 跳过。通过 `.gitattributes` 修复 Windows CRLF 引起的两项契约一致性失败。详见 [本轮验证](../../verification/local-development-20261019.md)，真实模型/设备及远端 CI 未因此完成。

交接日期：2026-10-15。工作目录 `/Users/cjr/Projects/vivic`，macOS Apple M1 / 8 GiB。用户准备切换 Agent，当前任务是交付和人工测试，**不是要求重新开始项目或再次完整重做 PoC**。

## 2026-10-17 内测落地页 `/landing/`

落地页已按用户要求参照 Hark 官网重做为 Vite 第二个入口的 React 页面（`apps/web/landing/index.html` → `src/landing/`），不再是静态 HTML：分屏首屏（左侧「展示窗口」逐句打字→Orb 思考→真实卡片出现→字幕回复，右侧 wordmark 与内测表单）、20 种场景卡片的 3D 弧形轮播（可拖动/暂停）、用户页与展示窗口双窗口流程、五个左右交替的「流光以太」舞台演示（对话出卡、提醒与日期、生成前核对、可直接操作的用户页卡片、12 种背景配色）、逐字上墨的大标语和结尾 CTA。卡片、SiriOrb、AtmosphereBackground 均为产品原组件，示例数据见 `src/landing/demoCards.ts`（单测按 CardRecordSchema 校验）；示例照片沿用 playground 的 Unsplash 远程图，离线时显示卡片自带占位。演示只在可见时播放，尊重减少动态效果；不调用 API、不录音、不保存任何修改。「申请内测」行为不变：任一合法邮箱即提示成功并进入 `/`，不发请求、不保存邮箱。检查见 `tests/e2e/landing.spec.ts`。

单文件版本：`cd apps/web && VITE_LANDING_APP_URL=http://localhost:5175/ LANDING_SINGLE=1 vite build --config vite.landing.config.ts && node scripts/inline-landing.mjs`，产出 `dist-landing-single/vivic-landing.html`（约 3.5 MB，gzip 约 1.1 MB，可直接双击打开）。该文件已部署到 https://edsionc.top/vivic/（服务器 `/var/www/vivic/index.html`，nginx `00-edsionc.conf` 的 `BEGIN/END VIVIC LANDING` 段）；部署版没有同源 Vivic，故「进入 VIVIC」与报名成功都打开本机 `http://localhost:5175/`。

## 2026-10-17 场景识别与 20 种动态卡片

用户要求实现场景识别与卡片渲染：模型只返回 `{"cards":[{scene_id, data}]}`，服务端核对证据（不编造数字/日期/链接/作者/图片）并按契约校验后生成卡片；20 个场景与 20 种卡片一一对应（`packages/contracts/src/scenes.ts`），复用并升级 CountdownCard（日期模式，不进提醒调度）、TodoCard、ChartCard，其余 17 种为新类型。卡片只在展示页出现并保留到用户要求删除；需要时拖到用户使用页任意位置操作（用户使用页不保留对话，只有输入框），再拖回展示页松手处。展示页待机不再黑屏，始终与用户使用页同一背景。开发版 `/playground` 可查看全部卡片。分支 `feature/scene-cards-v2`（基于 feature/user-page），详见 [场景卡片](../../scene-cards-20261017.md)。

## 2026-10-17 用户页、三页统一背景与配色设置

按用户要求新增**用户页** `/`：左上角设置按钮跳到原 Control（现为设置页 `/control`，左上角可「返回聊天」），右上角头像；中间是本次会话的对话记录，底部是图一样式的输入框（文字、`+` 图片、按住说话、发送）。文字和语音输入已从设置页移到这里。两页是同一个 owner 窗口的两个视图，切换时请求、草稿和录音都不中断。

展示窗口、用户页和设置页共用用户 HTML 中的「流光以太」背景（`components/atmosphere/`，替代原 Grainient 挂载）。默认配色是深色「午夜蓝紫」，新装默认主题因此改为深色。设置页新增「背景配色」，可选 6 种深色和 6 种浅色，不开放动画形式选择。配色保存在同步的 `DisplayPreferences.darkPalette/lightPalette` 中。着色器的噪声 hash 换成了精度安全的写法，以消除本机 GPU 上的矩形接缝。细节与验证见 [用户页与背景](../../user-page-20261017.md)。

e2e 用例随之改为真实路径：在聊天页发指令，在设置页操作设置（helpers `showChat`/`showSettings`）。

## 2026-10-17 模型连接稳定性

StepFun Key 与 GPT 连接「不稳定」的根因已实测定位并修复：经代理的 OpenAI 隧道握手 3.5–9.5 秒撞上 undici 默认 10 秒上限、且 4 秒空闲即被丢弃；Pi 令牌刷新硬编码 15 秒超时（约每小时一次，被误报为授权失效）；推理遇到断连/429/5xx 从不重试；StepFun 推理探测要求 JSON 而推理模型可能只思考不作答；后端重启静默丢失所选模型和 GPT 连接。现为隧道握手 30 秒、保活与 GPT 保温，两家对瞬时故障在同一时限内重试一次，所选模型与 GPT 登录跨重启恢复（`~/.vivic/preferences.json` 仅存名称），StepFun Key 仍只在内存、重启后面板明确提示重新输入。详见 [模型连接稳定性](../../llm-connection-stability-20261017.md)。

## 2026-10-16 联网搜索回退链

搜索不再绑死所选模型：依次尝试所选模型的搜索（GPT 仅在已连接时）、另一条已连接搜索、无凭据公共搜索，改用其他路径时提示写明来源；公共搜索可经 `VIVIC_SEARCH_PROXY`/环境/系统代理（含 macOS）出网，网页正文读取仍只直连；未连接模型时明显的查资料问题也会联网。详见 [搜索回退链](../../search-fallback-20261016.md)。

## 2026-10-16 GitHub 已公开推送

用户明确要求推送当前 Vivic 并改为公开，已连接 [ECdison6227/vivic](https://github.com/ECdison6227/vivic)。当前分支 `agent/next-iteration` 已推送并设为默认分支；远端旧版 `main` 保留，没有覆盖或合并。公开前扫描本地与远端共 38 个提交、760 个文本 blob，未发现匹配的凭据内容；环境文件、缓存与本机证据未纳入。后续 Git 约定以 [工作方式](../../GIT_WORKFLOW.md) 的远端说明为准，历史“没有远端”记录不再代表当前状态。本次未部署应用或创建 Release。

## 2026-10-16 二期方案整理，尚未开工

用户随后要求总结和拓展二期内容。[二期清单](PHASE2_CANDIDATES.md) 已扩写为建议路线：自然协同 → Control/首次配置 → 一种新卡片 → 个人 OAuth 与服务器可行性/多用户隔离 → 最小内测入口 → 手机 Control。文档区分已确定方向、建议候选与待验证问题；顺序和新增卡片选型尚未批准为实施方案。本次仅改文档，没有启动二期功能开发、部署、模型评测或邀请发送。

## 2026-10-16 最新：用户反馈后由 Agent 直接实测

用户不想继续机械地逐组手测，提交了 C4–C7/D2–D4、Orb 位置、提醒退场/提示、天气/搜索和新画布连接反馈，要求 Agent 直接测试。应以 [本轮修复](user-feedback-20261016.md)、[逐句真实输入](USER_TEST_RESULTS_20261016.md) 和 [验证摘要](../../verification/user-feedback-20261016.json) 为准，不再先要求用户从第 0 组重做。

已修正澄清串题、常见说法、本地待办行高亮/原文便笺、普通交流的结构化回答，以及自然天气/搜索问法到既有真实适配器的受限路由。没有新通用工具或代码执行。输入区显示真实模型连接，定期刷新；换画布不会断开模型，重启后端仍会丢失内存 Key。

Orb 工作态固定顶部中央；单个普通卡片操作后聚焦，明确高亮不改镜头，计划提醒不自动抢镜头。纯计时器与事项提醒分开；日期/周期/条件有独立分组和标识，超过一小时/未触发条件留在 Control，临近再出现。固定卡保留位置，明确聚焦可临时查看远期事项；交付后一次性卡退场，记录/条件历史保留。

新增不依赖 TTS 的到时短提示音，需用户首次交互解锁，可关闭并跨 Control 同步偏好。自动化继续静音，跨引擎测试用关闭提示音或 Web Audio 替身，未播放真实扬声器/开麦。背景改为清楚的暖色框/光与大字事项；关闭普通字幕仍保留提醒，普通回复不能覆盖到时事项。

使用用户本轮明确授权的 StepFun 测试连接，仅留后端内存；已有 `source:vivic` GPT OAuth 已恢复，真实模型/套餐搜索/图片检查完成，没有新开登录或读取凭据内容。日常仍为 5175/8787；运行状态以实时 `/api/providers/status` 为准，不重启已连接的后端。二期部署/邀请/多用户/手机/新卡片仍未启动，先请用户看修复后的效果。

## 2026-10-16 最新：手测入口固定 5175

用户截图发现旧 5173 地址实际是另一个发布会项目；先前“HTTP 200 即前端正常”的核对不充分。已将 Vivic 日常 Web 固定为 `http://localhost:5175/control` / `/display`，API 仍是 8787，测试仍是 5174/8788。Vite strictPort 防止静默换端口，API 精确允许新 origin，页面 title 标记 Vivic。未停止/修改其他项目，旧画布未读取或清除；换端口后原 origin 存储不会自动迁移。

验证见 [入口修正](entry-port-20261016.md)、[摘要](../../verification/entry-port-20261016.json)：真实 5175 的独立浏览器已确认 Control 主标题、同源 API POST 和 Display 同步，未用模型/麦克风/声音或真实画布。此前两种 provider 均未连接，配置重载没有丢失内存 Key。当前清单链接已更新；下文旧端口与旧“前端仍在”描述仅为历史，应以本节为准。

## 2026-10-16：一期收尾后逐组手测，二期暂记候选

用户已要求修复审计中的当前交付问题，提供从首次使用开始的完整清单，测试结束后再逐项做二期。本轮实现见 [一期收尾](finalization-20261016.md)、[验证摘要](../../verification/finalization-20261016.json)，手测入口统一为 [完整清单](../../FINAL_ACCEPTANCE_CHECKLIST.md)。生产 Display 调试限制、共享生成的 JSON 契约/一致性测试、UTC 示例及两条旧浏览器流程已修正，不能再按下文旧审计重复修复。没有改聚焦的数据密度或退回旧提醒显示。

本轮实际结果：单测 Web 386 + API 881 = 1,267 通过，另 3 项外部网络跳过；类型/构建/契约检查通过；Chromium 完整 90/90、Firefox/WebKit 专项 30/30、生产 Display 2/2、定向 10/10 分别通过。`b4ed31a` 当前代码不录屏真实 30 分 2.058 秒，24/24、60 个唯一 ID、无页面异常，临时测试资源清理。离线 503 console 与慢 rAF 事实保留，不称真机流畅度通过。代码提交 `cb020f6`、`b4ed31a`；文档另提交。

用户本人测试尚未结束。真实麦克风/听感/输入法/Safari/外接屏等保持待测；自动化继续静音与独立 TEST context。Kev 默认关闭、音色复刻暂缓，不启动新模型下载/评测；已有 GPT 授权可恢复，不重复新登录。

用户补充的二期意图是每人用自己的 Pi/OAuth，考虑内测码及邮箱候补邀请，以及手机网页 Control 的语音/设置/照片；“还不急，先把前面改好，一个一个来，不希望一堆逻辑很乱”。已记入 [候选与启动条件](PHASE2_CANDIDATES.md)，目前没有开始多用户/部署/手机/新卡片实现，不自动发送邀请或收集邮箱。卡片继续复用 Assistant UI styled registry 和批准组件。

下文为历史阶段记录；当前状态以本节、一期收尾及完整清单为准，不把历史暂停、待实施、待新授权措辞当成新指令。

## 2026-10-16：修复前全项目完成度审计（历史）

用户要求核对整个项目是否按 brief 全部完成。本轮只检查并整理报告，未修改业务实现。[逐项审计](project-audit-20261016.md) 和 [验证摘要](../../verification/project-audit-20261016.json) 区分当前实测、历史验收与未闭环项。三项体验优化已实现；不能据此将整个 PRD 标为全部验收完成。

当前需收尾的事实包括：生产 Display 的 `?dev=1` 调试入口缺开发环境限制；交接 JSON Schema 缺批量删除和计划/条件提醒；Chromium 全套有聚焦镜头与旧提醒显示断言两项失败；本地决策仍实验，真实语音/输入法/Safari/外接屏验收保留。旧源码三十分钟长测不冒充当前 UI 版本长测。本轮无 Key Exa 已实际返回五条来源，不能再按旧受阻记录判为不可用。后文的历史暂停/待实施/待新登录描述不能覆盖该报告及最新体验交付。

## 2026-10-16 最新：三项体验优化

用户已在新 case 授权并实施排版材质、Control 长内容详情与快速找卡；原候选 brief 的「未实施」是历史状态。说明与边界见 [experience-20261016.md](experience-20261016.md)，验证摘要见 [verification/experience-20261016.json](../../verification/experience-20261016.json)。

- 现有字体、Assistant UI styled registry、Radix/shadcn、Motion、React Flow、Grainient/Orb 保留；正文/来源/材质 tokens 与布局估算对齐，纯计时数字与带事项提醒合并均保留。
- Control「卡片与子卡片」的独立「阅读详情」临时保存卡片 ID、从当前 store 阅读原文，复用 Markdown；不改 Note.variant。子卡片和编号候选系统继续沿用，不能重新开发。
- 顶部「快速找卡」或 Cmd/Ctrl+K：cmdk + pinyin-match 按需加载，当前画布中文/全拼/首字母候选，完整稳定 ID 区分重复项，只调用既有聚焦 Action。只读可搜索阅读，不能自行接管。切画布、目标删除、owner 变化与 IME 已处理。
- 临时 ownerId 来自既有 owner 广播，保证持续只读的窗口也能在 owner 换人后关闭阅读层；没有改 wire/persistence schema。固定/增长/撤销/旧画布仍走原布局策略，两个固定卡相互重叠不移动坐标。

前端 386 单测、类型与构建通过；最终浏览器分次结果及截图/录屏位置以本轮验证摘要为准。自动化静音、独立 TEST context，5174/8788，未使用真实画布、麦克风或 GPT 推理额度。真实输入法/物理 Safari/外接屏与 GPU 仍待本人验收；Firefox 语音设置 console 告警已在说明中保留，不扩大本次三项范围。

## 2026-10-16 最新：子卡片与目标选择

用户随后明确要求本 case 先改交互细节，并更新下一 session prompt。已新增 Control「卡片与子卡片」、按原行关联的持久化扩充、Display Radix Popover/Arrow 阅读、合并提醒精确事项高亮/删除，以及临时冻结编号选择（回复「2号／第二个」、悬停/键盘预览、取消、IME 防误提交）。删除父卡片后撤销携带子卡片一起恢复。固定卡片阅读按钮可点击，不解除固定；切画布后立即编辑的同步时序也已修正。

实现、使用方法及边界见 [交互细节](../../interaction-details.md)。子卡片是手动编辑的一级文字扩充；表格/便笺原行改写时保留未关联内容供修复。下一 case 的整体排版材质、完整长文详情、快速找卡尚未实施，更新后的 [experience-iteration-brief.md](experience-iteration-brief.md) 已明确哪些应复用，不能再重复开发。

本轮代码 `23ca1dd`、`0312ab3`；最终单测 Web 376 + API 860 = 1,236 通过、3 跳过，类型/构建通过；Chromium 19/19，Firefox/WebKit 完整专项 24/24、最后箭头微调后新增专项 12/12，分次记录。摘要：[verification/interaction-details-20261016.json](../../verification/interaction-details-20261016.json)。真实语音/物理 Safari/新的长测没有因此完成。

GPT 已复用用户本次 `source:vivic` 新授权恢复到 `gpt-6-luna`，无须再次登录；本轮没有重复消耗推理/搜索/图片验证额度。仍遵守静音、不采集物理麦克风、只操作隔离 TEST 画布。下文「暂停」与「待新授权」均为历史状态，不能覆盖本节。

## 2026-10-16 手测反馈与最新优先级

用户已提交真实 Chrome 截图，表示流畅度不错，但交互限制太死；明确要求继续处理这些反馈，优先于下文历史暂停约定。已完成的本轮修正详见 [手测反馈修复](manual-feedback-20261016.md)。不要退回旧行为：上海市直接查天气；建空表格不先追问；带事项的提醒显示事项/时间并合成一张列表；一次性到时后退出画布，记录仍供 Control/条件使用；明确「删除所有卡片」本地执行并支持整批撤销。

这次用户的明确要求覆盖原规约「所有 Countdown 都只有数字」：**纯计时器仍只有数字，带事项提醒应能看出事项**。固定卡仍单独保留坐标，不能为了合并移动固定卡。

已按用户要求打开既有 Pi OAuth 授权页，用户完成新登录，观察到 `source:vivic` / `phase:connected`；不是复用旧 Pi 登录冒充新流程。热重载后可用「恢复本机 GPT 登录」复用这次授权，不需再次让用户登录。真实 GPT 推理/多提醒/搜索/图片验收记录见本轮说明。不要读取或打印认证文件。

后续排版材质、长内容详情、快速找卡仍属于已评审的新 case brief；本 case 未顺带实施，也未开始其他决策模型评测。音色复刻仍暂缓，浏览器全关提醒仍不需要。

## 此前用户确认（历史）

本节优先于下文历史的「继续完成剩余所有」和建议顺序。用户可能新开 session，目前只要求说明已做功能、解释提醒支持范围并保留交接；不要自行继续功能开发、下载模型或启动新评测。

- **音色复刻暂缓**：已有 File ID 接口原型和证据保留，不继续录音/上传/复刻闭环，不做真实克隆或试听。
- **真实语音由用户后续手动验收**：到测试时再提供输入、步骤、预期结果和记录方式。继续遵守自动化静音、不采集物理麦克风；本次不是播放或开麦授权。
- **真机兼容与流畅度由用户后续测试**：Safari、外接屏、实际 GPU、输出设备和听感仍待本人验收，不因长测通过而标成真机已通过。
- **全部浏览器关闭后不需要提醒**：从未完成清单移除，不开发原生后台服务或推送。保留现有 Control 打开时调度、持久化及恢复处理，不为此删除已有逻辑。
- **GPT 新授权仍待发起**：用户澄清是让 Agent 在手测完成后打开新的 GPT 授权页面，由用户登录；不是说新授权已经完成，也不是仅复用 Pi。当前先不发起，等待用户明确表示手测结束；随后走既有 Continue with ChatGPT/Pi OAuth 路径，不另造协议、不注销 Pi。授权后再用隔离 TEST 数据验证真实 GPT，不碰真实画布。
- **Kev 中文效果不满足用户要求**：保留默认关闭的实验入口与失败/放弃证据；后续恢复开发时评估其他本地决策模型，重点验证中文、误执行、否定/复合指令、指代和本机内存/延迟。现在不开始新评测，不把 Kev 当成最终选型。
- 月/年、节假日和天气等外部条件提醒尚未实现；这不影响现有天气卡、每天/每周提醒。先解释范围，不据此自动扩展任务。

最新流程和手测项见 [USER_ACCEPTANCE_NOW.md](USER_ACCEPTANCE_NOW.md)。用户贴出的排版/材质、长内容详情、快速找卡 prompt 当前仅供评审，**不是本 case 的实施指令**；后续 brief 已记录在 [experience-iteration-brief.md](experience-iteration-brief.md)，等手测和新 GPT 登录验证结束、用户开新 case 后再实施。

## 先读与用户意图

先读根 [README_FIRST.md](../../../README_FIRST.md)、[交付](DELIVERY.md)、[人工测试输入](MANUAL_TEST.md)、[实施现状](../../implementation-status.md)，再按任务读原 [PRD](../../../Vivic_Kimi_Handoff_v0.6/PRD.md)、[AGENTS](../../../Vivic_Kimi_Handoff_v0.6/AGENTS.md)、架构/组件/契约。旧模块报告里的「尚未集成」常是当时的历史状态，不能覆盖当前主线。

用户要求先完成主线开发，再统一调整体验。最近重点是卡片重叠、三事项提醒、思考反馈、音色、本地识别/唤醒以及只提供 StepFun Coding Plan 和 GPT/Pi 两种决策连接。本轮已落地这些主线，但 [交付中的未完表](DELIVERY.md) 仍明确保留实验、未实现细节和现场验收。

最新用户要求：在 `agent/next-iteration` 修复实际反馈，再继续未完计划。用户最终更正为「上海天气」「给我创建一个表格」思考结束后没有卡片/解释，不是待办问题。已补齐数据澄清的展示字幕、真实地点选项、天气/表格续答；已继续完成统一清除本地数据入口。增量详情与最新检查见 [next-iteration.md](next-iteration.md)，下文原交接验证数字保留为历史基线。

随后用户继续原计划，已实现[固定预录短反馈、逐词字幕、PCM 振幅](../../voice-feedback.md)。预录素材已随仓库附许可/散列；生成与测试没有播放扬声器或开麦。真实 StepFun 词轴及听感仍待验收，不要重复开发或误称实际套餐已测。

## 本轮剩余计划的最新状态

已继续完成[剩余计划实现](remaining-plan.md)：浏览器精确操作不走 LLM；日期/重复/画布条件提醒；固定公网 DNS 备选和真实正文读取；可选 Kev-0.8B 准备/启用/停止/清理；输出设备选择、静音通知、已有 File ID 的 Plan 音色复刻；WebKit Blob 缓存回退。模型与权限测试仍不播放、不采集真实麦克风。

Winnow 已定位为 [EldanRing/Winnow-E4B](https://huggingface.co/EldanRing/Winnow-E4B)，8.01GB Q8 不适合当前 8GB M1；不再向用户追问项目链接。采用用户允许的 [Kev](../../local-decision.md)，原始中文正确率 68.89%，必须保留默认关闭和严格放弃策略，不把实验改称通用可靠路由。模型不是第三种远程聊天 LLM。

最终验证摘要见 `docs/verification/next-plan.json`；旧阶段数字与旧失败记录仅保留为历史事实。后续只处理真实测试反馈和外部验收，不重写这些模块。

## 不可遗失的约束

- 中文沟通，直接推进已授权工作。不要让用户反复说「继续」，也不要假称启动了子代理。此前子代理均已完成并关闭，没有后台在途实现任务。
- 当前自动化测试静音，TTS 保持关闭，不播放扬声器、不采集物理麦克风。过去一次听音授权不当作持续授权；用户本人可按清单选择测试时机。
- 浏览器自动化已获允许，使用独立 context/存储，不能在用户真实窗口里输入、改画布或读出 Key。
- LLM 只有 StepFun Coding Plan 和 GPT。GPT 迁移现有 Pi OAuth/provider，不重写 OAuth，不接更多 provider；语音与 LLM 独立。
- Pi 没有 coding agent session、read/write/edit/bash、扩展/skills 或宿主自动配置。模型只发校验后的结构化 Action。
- 维持批准的真实组件和极简 Display；纯 Countdown 数字模式保留，带事项提醒按最新反馈显示事项与时间。不把设置/聊天/调试面板加到 Display。
- Key 仅后端内存，不进源码/日志/浏览器/导出。Pi 凭据留在原安全存储并遵守刷新锁；断开 Vivic 不登出用户 Pi。不从聊天抄 Key 到项目文件。
- 不放宽 fetch 私网/重定向/DNS 防护来规避 fake-IP；不把搜索摘要称为已阅读全文，不编造天气或数值。

## 运行与连接

- Web（当前固定 5175）：`http://localhost:5175/control` / `/display`；API：`http://127.0.0.1:8787`。
- 当前已有后台 `pnpm dev`，日志 `/tmp/vivic-dev-$(id -u).log`。切 Agent 不需要重启；先请求 `/healthz` 或检查端口，避免占用重复服务。
- 从零启动：Node >=22.19.0，`pnpm install`、`pnpm dev`。API 的本机 bearer 位于被忽略的 `apps/local-api/.env.local`，代理注入，不能打印文件内容。
- 交接检查时 StepFun 和 GPT 均连接，当前 StepFun `step-3.5-flash`，GPT `gpt-6-luna`。这是易失进程状态，后端重载会清空连接；不要反复要求用户发送 Key。GPT 可通过 Control「使用本机 Pi 登录」恢复现有授权。
- StepFun 默认 3.5 不按视觉处理。图片须选实际支持视觉的模型，例如目录中有权限的 3.7 flash/5 preview，或已验证 GPT。
- 云语音仅走 Plan 路径；不静默 fallback 到普通按量计费 API。
- 本次增量曾触发 API watch 热重载，StepFun 内存 Key 已断开，不能从文件或聊天恢复。收尾已通过应用既有接口复用 Pi 授权恢复 GPT（gpt-6-luna），未新开 OAuth，也未更改原模型选择。连接是易失状态；StepFun 在 Control 重连。

## 代码导航

| 模块 | 主要位置 / 实现要点 |
| --- | --- |
| 动作契约 | `packages/contracts/src/{actionEnvelope,cardRecord,vivicState}.ts`；原交接 JSON 契约也已同步 `card.update.variant` |
| 排版 / 撤销 | `apps/web/src/state/canvasStore.ts`：按尺寸保留空间，固定/恢复坐标作为障碍，Todo 16px 行宽估计，Note 展开高度，密度更新只允许 Note 且不能同时改原文 |
| 同步 / 持久化 | `sync/controlHost.ts`：owner 验证交互、保存后同步、旧重叠画布修复、`arrangeCanvas()`；`displayClient.ts` 不写 DB |
| React Flow | `canvas/CanvasView.tsx`：保留 measured 尺寸，避免旧 #015/RO 重测问题；minZoom 0.05；Display 拖动先预览，owner 确认才持久化 |
| 文字 / 澄清 | `commands/{parse,references}.ts`、`control/ControlApp.tsx`；expand/collapse 歧义选择发 variant + fit，不得误发 focus/delete |
| 主题 | `sync/protocol.ts` 的可选 dayStart/dayEnd，旧记录兼容；`motion/motionDirector.ts`、`stage/StageRoot.tsx`；默认 07:00–19:00、跨夜/分钟边界/隐藏恢复 |
| 卡片 | `cards/*CardView.tsx`，Recharts + styled Table；真实天气来源链接和 Radix HoverCard；负数 pie 不伪造比例 |
| GPT / Pi | `apps/local-api/src/gpt/**`、`PROVENANCE.md`：Pi 1.2.0，OAuth-only AuthStorage，public/legacy 路由区分；目录上限 4MiB、推理/搜索 512KiB；完整 SSE completed 才接受结果 |
| 本地决策 | `local-api/src/decision/`、`scripts/decision-model/`；固定 Kev 选择评分器、离线加载、超时放弃，默认关闭；见 [决策说明](../../local-decision.md) |
| 数据与搜索 | `local-api/src/data/**`、`search/**`、`intent/searchSummary.ts`；数值来自明确输入或既有数据，比较摘要只能引用已有证据 |
| 图片 | `ai/attachments.ts`、`control/ImageAttachment.tsx`、API `images.ts`/`imageDecoder.ts`：4MiB/16MP/8192 边上限，Sharp 全像素解码，当前请求内存附件 |
| 本地语音 | `ai/localSpeech/**`、`control/LocalSpeechSettings.tsx`/`LocalWakeInput.tsx`；固定模型 manifest，按需下载/SHA/取消/清理，显式前台单句；不是后台常驻唤醒 |
| 语音与提醒 | `ai/speech.ts`/`speechTelemetry.ts`、`public/voice-feedback/`、`reminders/**`、API `speechStream.ts`；固定短句、同流词轴/浏览器边界、PCM 包络通过现有 activity 广播，只有 owner 播放 |
| 统一清除 | `control/DataActions.tsx`、`sync/controlHost.ts` 的 `clearLocalData()`、`persistence/db.ts` 的原子 reset；`local-data-reset` 通知已打开窗口，清除前取消在途请求和语音；后端账号/Pi 存储不动 |

完整模块说明在 `docs/`，许可证及固定来源在根 `LICENSES.md`。

## 最新验证

[最终增量摘要](../../verification/next-plan.json)：Web 354 + API 855 = 1,209 项通过，3 项外部条件跳过；类型/构建通过。Chromium 原全套 71/73 的两个旧断言在后续 10/10 专项中复核通过；最新 Firefox/WebKit 专项 16/16。最终冻结 Web snapshot 不录屏，真实 30 分 2.577 秒，24/24、60 卡完整、原生 GL 丢失停止绘制，无页面异常，资源已清理。完整边界及证据见 [剩余计划交付](remaining-plan.md)。

## 原交接回归事实与限制

可移植摘要：[verification/phase3-final.json](../../verification/phase3-final.json)。Web 317 + API 793 = 1110 项单测通过，另 3 项跳过；类型/构建通过。完整 Chromium 58/58，最后受影响功能 11/11；Firefox/WebKit 排版 12/12、设置/便笺 6/6，分别记录。

真实证据保留本机：

- `evidence/phase3-final/REPORT.md` 及各 JSON/日志，`layout/` 是标注 TEST 的合成卡截图。
- `evidence/phase3-live-browser/live.json` 与截图/录屏：真实 GPT 图片算式 43、天气、表格、柱图、搜索 5/5；7 卡刷新前后无重叠。
- `evidence/phase3-gpt/live.json`：复用既有 Pi，真实推理/三提醒/订阅检索 3/3。
- `evidence/phase3-local-speech/REPORT.md`：17/17，合成录音/真实权重/虚拟 AudioWorklet；默认唤醒词只有词表/初始化，不是声学验收。
- 原 `2026-10-15T08-04-07-253Z-chromium` snapshot 的真实 30 分钟保留主题选择器错误，原修正复核只有短专项；不要改写这些原始记录。本轮最终源码另有 `2026-10-15T13-39-03-281Z-chromium` 完整长测，见上方最新验证。

已知限制：两张均 Pin 且互相重叠时不擅自移动；手动拖动允许自行重叠，之后可「重新排布」。任意布局不等于已覆盖无限组合。Firefox 服务器转发日志曾出现 BackgroundLayer React 更新告警；功能通过但不能声称所有日志为零。构建有上游 Sherpaw/包体积提示。

## 下一轮建议顺序

1. 接收 [人工清单](MANUAL_TEST.md) 的真实反馈，优先修复错删、事项遗漏、数值错误、重叠/丢卡及连接权限问题；不要先增加接入方式。
2. 安排本人语音/默认唤醒词及物理 Safari/外接屏验收；自动化仍静音。新 GPT 登录只在用户确实要新登录时完整走原 Pi 流程。
3. 统一清除、预录反馈、字幕/振幅、重复/条件提醒、输出设备选择、静音通知及已有 File ID 的 Plan 复刻路径均已实现，不要重复开发。真实 Plan 权限、时间戳、声音复刻与听感仍待用户操作；当前禁止自动化实际发声。上传 Plan 路径未明确，不能猜测或切普通计费 API。
4. Kev 已有可选实验入口，优先收集真实中文输入的误判/放弃反馈；保留置信度、否定/复合语句和目标校验。Laya 原 NO_GO 证据保留，Winnow 身份已明确，但本机内存不适用。
5. 最终 Web 源码 `4db5446` 已完成不录屏 30 分 2.577 秒、24/24 检查，证据见验证摘要；Firefox 驱动回调更新已修正。保留慢帧/物理 GPU 限制及所有旧失败记录，不把这次通过描述成所有设备流畅度验收。

## 检查命令与端口

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @vivic/web exec playwright test
pnpm --filter @vivic/web exec playwright test --config playwright.compat.config.ts tests/e2e/overlap.spec.ts tests/e2e/phase3-settings.spec.ts
```

普通测试用 mock/TEST 数据，不证明真实服务权限。Playwright 使用 5174/8788，多个套件顺序跑；真实脚本 `scripts/verify-gpt.mjs`、`verify-live-browser.mjs` 会用用户套餐，按明确目的运行，不反复消耗额度。不得读取或输出认证文件内容。

## Git 交接

已从此前没有版本历史的目录建立 `main` 基线和 `v0.6-mvp-handoff-20261015` 标签，下一轮工作分支为 `agent/next-iteration`。没有远端，也没有推送。先 `git status --short --branch` 再工作，小步提交，详见 [Git 工作方式](../../GIT_WORKFLOW.md)。

源码/配置/锁文件/规格/本交付文档纳入基线；`.env*`、`.cache/`、`evidence/`、依赖、构建和测试输出保持忽略。本机证据/模型缓存仍在，不要 `git clean -fdx`。未来 clone 时须重新装依赖、下载可选语音模型并取得用户授权，不能从源码恢复 Key/用户画布。
