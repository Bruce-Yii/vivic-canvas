# Vivic 仓库工作约定

2026-10-24 同步授权更新：用户现已明确要求将当前成果同步到 GitHub，可提交当前集成版本到独立任务分支并创建 PR。此前“不推送”是历史状态；仍不自动合并或部署。同步范围、最新 PDF / MD 限制和验证边界见 `docs/updates/2026-10-24-github-sync.md`。

2026-10-24 最新修正：严格采用 rea-ui-library 的 Hark Web 并继续做减法。附件/查询收进“＋”，顶部视图重复操作收进传送门，卡片去重复页脚。新上传与阅读仅 PDF / MD；旧 Word/TXT/CSV/JSON 原件保留下载，不显示正文、不交给模型，手机同样限制。Android 0.1.9。详见 docs/updates/2026-10-24-hark-minimal.md。仍不推送、不发布。

2026-10-24 阅读修正追加：文件卡整块点击直接打开只读阅读器，普通阅读不调用模型；MD排版、PDF原页/翻页、DOCX正文，手机同样先读原件再按需保存。“问Vivic”是可选侧栏。查询面板、保存结果卡片和整理预览逐个重做Hark布局；Android0.1.8。具体证据见 `docs/updates/2026-10-24-reader-polish.md`，交付 `delivery/reader-polish-20261024`。仍不推送不发布，不把演示响应当真实账号授权。

2026-10-24 Connected Space追加：用户批准飞书/麦当劳/企微/钉钉查询连接、Hark卡片减法与可控动态光、手机真正双向传送门、文件卡（5个/次合计10MB，Space100MB）、排序分区及通用撤销重做。比赛是2026飞猪AI旅行创新大赛，飞书为接入服务。当前27种renderer，Android0.1.7；文件保存在owner浏览器，手机只读预览下载，不建文件DB。连接需每用户独立授权；尚无真实账号查询结论。完整新增/验收/边界见 `docs/updates/2026-10-24-connected-space.md`。覆盖下方冻结天空/无手机传送门的旧约定。仍不推送不公开发布。

2026-10-24 全量验收最新：Mac mini SSH已连通，M4/24GiB/macOS26.4；Mac安装后.app、0.8B/4B真实推理与动态TTS已验。Web140场景分次修复及公网中继补验后全部通过，API1319通过，3项默认跳过的外网诊断已另行3/3通过，真实StepFun29/29+线上接口12/12通过，安卓已用虚拟相机真正扫码验同步。新增电脑APK下载、离线任务兼容与Mac安装修复。4B完整Jev v2仍0/5过门控，保持关闭；生产APK公网HTTPS/物理语音和Mac签名公证未验。不推送、不发布。最终交付与准确边界见 `docs/updates/2026-10-24-full-acceptance.md`，覆盖下文Mac仍待SSH的旧状态。

2026-10-24 最新：用户批准三 Agent 做简洁助手收口。三端精简、官网卡片修复、Jev v2/宿主保存回执已落地；线上生产浏览器和Android独立AVD通过。唤醒默认关闭、设置不自动下载模型。StartLux 0.8B原生长状态能读出但0/5过门控，不能称正式Jev已达标；门控保持关闭。详见 `docs/updates/2026-10-24-simple-assistant.md`。Mac SSH仍等用户本地Agent交接；本轮继续不推送、不发布。

2026-10-23 最新追加：用户明确要求三 subagent 同时做手机接入线上隔离会话、目标服务器 Linux/Docker/HTTPS/反代隔离验收，以及跨平台启动器/StartLux/本地动态TTS。这一指令恢复下文暂缓的本地运行工作；仍不正式发布、不推送。职责和验收见 `docs/tasks/20261023-three-streams.md`。UI继续用Hark，线上手机入口 `/remote/` 不创建桌面owner。

先读 [README_FIRST.md](README_FIRST.md) 和 [当前交接](docs/AGENT_HANDOFF.md)，再按任务读取模块。本文件是当前产品与协作约定；旧阶段报告和归档指令只供追溯，不用于重复开发。

2026-10-23 用户最新优先级：先开发 Vivic 线上端，本地启动器/模型后续再做。全在线用户直接用网页，自有 API 也不强制下载安装。线上版采用隔离会话后端和三步新手引导，严格复用 library Hark；本轮只做可部署版本与本机验证，不发布到服务器。早期“先本地单人版”的排期由此更新，既有本地成果保留。后续设置已改为聊天上的小面板，仅连接/偏好/数据三组；卡片、提醒和空间操作移至聊天顶部 Space，详细配置折叠。保持编辑器、草稿和 owner 挂载，原生 dialog 内的 Radix 弹层使用 ControlOverlayContext，见 `docs/updates/2026-10-23-settings-panel.md`。

2026-10-19 最新安排：三人协作完善本地单人版，再讨论部署、多账号和收费。维护者重点优化核心流程，也可开发新功能；偏前端、偏后端的伙伴可承担 Landing、新卡片和新功能，按与核心的依赖程度分配。当前路线见 [本地开发路线](docs/LOCAL_ROADMAP.md)，分工边界见 [团队任务单](docs/TEAM_TASKS.md)，协作入口见 [贡献指南](CONTRIBUTING.md)。

- 伙伴/贡献者 Agent 按已分配任务的文件清单、接口契约和验收标准工作；允许实现任务内的新功能、卡片、Landing 和相应测试，不因角色被限制为只写报告。
- 核心请求链路、认证、共享契约、owner/同步/持久化及依赖/CI 的跨模块修改由维护者统筹，任务确实需要时先明确接口与集成范围。超出任务的修复另记，不能顺手扩展；不得删除必要测试、降低断言或跳过检查来掩盖失败。
- 伙伴默认从 fork 提 PR，维护者核对范围并决定合入；不因伙伴未交付而阻断主线。CODEOWNERS 与文档不等于线上写权限/分支规则已生效。
- 2026-10-20 已按会议核对分工：程佳锐做核心/卡片接入和集成，xlz 做旅游卡片/MCP 独立试跑及 UI 原型，马泽瑜做决策模型和本地启动器。以 [当前工单](docs/team/README.md) 为准，不按旧“前端/后端”猜测让马泽瑜改飞猪适配。AI 开发与提交 PR 的执行边界见 [WORKFLOW](docs/team/WORKFLOW.md)。
- 新卡片任务先按 [卡片开发契约](docs/CARD_DEVELOPMENT.md) 固定模型数据、Schema、事实来源、渲染与编辑接口；配套 [开发 Skill](.agents/skills/vivic-card-development/SKILL.md)。首个系列为 [飞猪旅游系列卡片](docs/tasks/fliggy-travel-cards.md)。不把开发 Skill 当运行时插件，不因外部 MCP 数据接入而跳过校验。

- 这是 Web 信息画布，Control/Display 双视图；Display 保持极简。2026-10-16 用户反馈更新：纯计时器只有数字；带事项的提醒显示事项与时间，未固定提醒合并呈现，到时后退出画布、记录留在 Control。2026-10-17 起 Control 分为用户页 `/` 与设置页 `/control`，二者是同一个 owner 窗口；2026-10-22 用户要求两个标签页间有可见传送门，以及聚焦、显示全部等界面操作，用户页顶部和展示页底部提供这些入口，见 [用户页](docs/user-page-20261017.md)。
- 2026-10-23 手机定位纠正：首次配置在电脑，手机扫码后仅“聊天 / Vivic Space”两个主页面；聊天向右滑看单列纵向卡片，反向返回，不复刻自由画布。手机仅保留本机明暗/字号和连接设置，其余配置回电脑；不要恢复旧五标签/手机模板页。卡片内容由已配对电脑白名单投影，手机不建owner/画布DB；只读预览不授予扩展执行或任意远程编辑。电脑设置4组，保留隐藏面板的草稿与owner，见 `docs/updates/2026-10-23-mobile-remote.md`。
- 保留已批准的 SmoothUI Orb、Assistant UI styled registry、React Flow、Motion、Radix/shadcn、Recharts；不要自行重画替代。2026-10-23 用户最新要求 UI 全面使用 library 的 Hark `26ac2724`，替换此前 TODAY 混合界面和旧背景。优先复用原 SVG、字体、连续圆角与透明材质；领域缺项保留现有 Lucide。三页共用冻结 Hark 天空，原 6 深 + 6 浅配色作为叠色保留，不增加动画形式选择。入口 `components/hark/` 与 `docs/updates/2026-10-23-hark-full-ui.md`；研究 partial 和目标适配差异需保留。
- 当前 LLM 接 StepFun Coding Plan、GPT/Pi OAuth；用户已提出通用自带服务与预设连接方向，后续按路线中的具体任务扩展。语音独立；Pi 只迁移认证/模型，不启用 coding tools、session、扩展或 skills，不开发新 OAuth 协议。
- 决策模型纳入本地版正式接入目标，支持 API 或本地运行；产品默认优先引导配置并使用，用户明确关闭时允许直接走 LLM。服务不可用或判断不确定时要有明确降级，不静默改成永久关闭。现有 Kev 默认关闭是旧实现状态，不代表新目标已完成。JevHarness 先做适配评估，见 [候选记录](docs/research/jev-harness-assessment.md)；当前仓库整理与 GitHub 教学流程不变。
- 模型只生成校验后的 Action/数据，不能执行代码或虚构联网数据。图片仅用于当前明确发送的请求。
- 凭据不进入源码、文档、日志、浏览器存储或画布；`.env*`、`.cache/`、`evidence/` 默认不入 Git。不要删除本机验收证据。
- 当前自动化测试静音，TTS 保持关闭，不采集物理麦克风；实际播放需用户后续明确允许。浏览器测试使用独立 context，不碰用户真实画布。
- 自动排版须避开固定卡片；关注长文本、内容增长、撤销和旧画布恢复。两张均固定时不能擅自移动坐标。
- 在当前开发分支继续，小步提交；不要重置/覆盖已有工作。未收到用户“提交 PR”等明确指令时，不自动推送、合并或发布。基线/分支约定见 [Git 工作方式](docs/GIT_WORKFLOW.md)。
- 当前协作仓库为 `ECdison6227/vivic-canvas`，合入分支为 `main`；旧 `ECdison6227/vivic` / `agent/next-iteration` 只作历史记录。用户说“提交 PR”即授权提交本轮改动、推送任务分支到当前 `origin`，向 `ECdison6227/vivic-canvas:main` 创建 PR，无需重复确认。操作前核对实际 remote；不得按旧文档改写远端。标题和说明必须对应本轮实际修改，并写明验证结果；完成后返回 PR 链接。只创建，不合并、不启用自动合并。每轮修改使用对应的 PR，必要时新建独立分支，避免混入此前 PR 的改动。

按改动运行相应检查；前端 `pnpm --filter @vivic/web test`，后端 `pnpm --filter @vivic/local-api test`，全量 `pnpm test`，类型 `pnpm typecheck`，构建 `pnpm build`。浏览器测试使用 5174/8788，串行运行不同 Playwright 命令，避免占用用户的 5173/8787。
