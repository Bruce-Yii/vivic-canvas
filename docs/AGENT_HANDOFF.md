# 当前交接

2026-10-24 用户已授权 GitHub 同步。以当前可运行集成版本建立 `feat/hark-connected-space-20261024` 分支，附新增/更改/验收说明并创建 PR；不要自动合并或部署，也不关闭伙伴原 PR。此前“不推送”仅描述当时状态。入口 `updates/2026-10-24-github-sync.md`。

2026-10-24 最新修正：严格采用 rea-ui-library 的 Hark Web 并继续做减法。附件/查询收进“＋”，顶部视图重复操作收进传送门，卡片去重复页脚。新上传与阅读仅 PDF / MD；旧 Word/TXT/CSV/JSON 原件保留下载，不显示正文、不交给模型，手机同样限制。Android 0.1.9。详见 docs/updates/2026-10-24-hark-minimal.md。仍不推送、不发布。

2026-10-24 阅读体验修正：用户指出此前阅读/查询/整理界面还像测试面板。已改为整块文件卡点击即读，Markdown排版、PDF原页、DOCX正文、长原件分段阅读；AI问答为可选侧栏。查询和保存结果采用独立Hark阅读层，整理预览收起参数后显示分区清单。手机直接读取原件后预览，Android0.1.8。见 [阅读修正](updates/2026-10-24-reader-polish.md)，交付 `delivery/reader-polish-20261024`；未推送未发布，不把fixture当真实账号数据。

2026-10-24 Connected Space最新：三子Agent已实现并集成连接器自然语言只读查询、Hark精简/动态空间、手机双向传送门、子卡片和原件下载；维护者完成文件契约、容量集成、排序分区、通用撤销重做、跨窗口保存光效与独立审查修复。新文件卡后27类型，Android0.1.7。参赛是飞猪AI旅行创新大赛；真实服务账号授权、正式公网APK链、OCR和Mac重打包未声称完成。先读 [本轮更新](updates/2026-10-24-connected-space.md)，交付在外层 `delivery/connected-space-20261024`。本轮不提交、不推送、不发布；不要重置大量此前未提交改动。

2026-10-24 全量验收完成：三子Agent测试Web/Android/Mac，主Agent实测StepFun/Windows并修复集成。Mac SSH已经严格连接，M4/24GiB；实际.app安装及0.8B/4B/TTS通过。Web去重140通过，包含既有公网relay补验；最终API1319通过，另补跑外网诊断3/3；真实StepFun29/29、线上真实接口12/12通过。安卓生产包下载验签安装通过，扫码全链使用包内精确私有CA的debug变体，生产公网链留待发布。4B native-v2 5个任务均有有效概率但0/5过门控，不能称正式Jev完成。交付在外层 `delivery/full-acceptance-20261024`，含Win/Mac/Online/APK及报告，未提交推送/公开部署。先读 [本轮完整验收](updates/2026-10-24-full-acceptance.md)，不要重做下方已解决的Mac等待或扫码手动链接阶段。

2026-10-24 简洁助手收口：三端Hark减法、官网25项/26renderer覆盖、卡片保存/窄屏、Jev v2任务回执与手机withCommit接线、按需唤醒和球配色完成。真实StepFun修复生成格式/事实混淆，独立Android与线上生产浏览器通过。原生0.8B 5/5有效读出但0/5过门控，特调4B质量与Mac实机仍未完成。阅读 [完整新增/删改/验证和限制](updates/2026-10-24-simple-assistant.md)，不要恢复自动下载、营销模板或旧设置布局。未提交推送或公开发布。

2026-10-23 三线集成最新：手机已经接入online隔离会话，`/remote/`不创建桌面owner，Android0.1.5/code6保留聊天/纵向Space；真实浏览器/独立AVD已通过指令→正文→固定→Display→保存重载→撤权。Linux目标现有Docker/私有测试CA反代已实际验收，最终archive对应结果见服务器报告，公开路由未变。启动器现在一键准备/运行真正StartLux Instant，Windows0.8B与Sherpa/Kokoro动态TTS已真实静音验收；Mac按用户明确选择先完成安装与自动验收流程，未声称Mac实机。主任务另完成0.8B58步LoRA及重载/独立评测，4B正式微调和更大数据仍待后续，训练候选不进入启动器。见 [手机](updates/2026-10-23-online-mobile.md)、[服务器](updates/2026-10-23-online-server.md)、[本地运行](updates/2026-10-23-local-runtime-next.md)、[训练](../training/startlux/README.md)。这些状态覆盖下方历史“手机未接线上/StartLux未一键准备/无动态TTS/未跑Linux”的描述。用户18787服务未重启，不推送不正式发布。

2026-10-23 后续设置简化：用户选择小面板，已将设置改为聊天背景上的 Hark modal，三组为连接/偏好/数据。模型和语音参数、配色与权限按需展开；卡片包、布局/固定、提醒和空间管理移到聊天顶部 Space，快速找卡保留图标和快捷键。草稿/owner 持续挂载，Radix 二级菜单与确认挂入同一原生顶层；新手引导与失效会话会挂起设置。见 [本轮映射与验收边界](updates/2026-10-23-settings-panel.md)。本轮仍不发布，不推送，不重启原18787服务；本机线上预览18794。

2026-10-23 最新：用户将优先级改为线上端，本轮明确“不发布，只做可部署版本”。已新增独立在线会话后端、三步Hark引导、设置入口收敛、按需麦克风授权与online专用构建。Cookie会话隔离Key，不读本机Pi/偏好/中继、不启动本地决策；全在线无需启动器。画布仍在浏览器，没有账号/跨浏览器云同步。入口 [线上部署](online-deployment.md)，本机预览18794与原18787服务分开，前者为线上服务器入口演练，不是已发布公网。后续不要继续按下面旧启动器方向开发或擅自部署。

2026-10-23 本地运行方向：用户确认 StartLux（原称 starlux）4B 为二次训练首选，低内存候选为2B/0.8B。已新增原生决策协议、固定模型清单/内存建议API、现有Qwen运行时的Mac双架构文件适配，以及Mac原生打包/安装/停止与手动CI。当前Windows实际运行仍是Qwen，StartLux一键准备/真实推理/微调与Mac运行尚未完成；不要改名冒充。语音继续复用Sherpaw ASR/KWS/VAD，Sherpa-ONNX动态TTS尚待接入。先看 [本轮具体实现和边界](updates/2026-10-23-startlux-runtime.md)、[Mac打包](updates/2026-10-23-cross-platform-launcher.md)。未重启用户服务，未推送Github。

2026-10-23 后续减法：用户强调简单简洁，手机移除重复品牌/大标题、健康连接栏、版本号、常驻口号及逐卡保存页脚，固定操作收为图标；手动配对折叠，手机设置变短行，异常反馈/权限/保存/草稿仍保留。电脑设置移除重复介绍。安卓0.1.4/code5、本机与公网静态UI已更新，不重启服务，见 [本轮简化](updates/2026-10-23-minimal-ui.md)。后续别把已删装饰和说明重新堆回主页面。

2026-10-23 最新产品边界纠正：手机为电脑首次配置后的遥控，扫码后仅聊天/纵向 Vivic Space 两页，双向横滑与顶部Tab切换；设置仅手机明暗/字号/连接，移除五标签、模板、独立历史和设备面板。电脑设置收为4组与高级折叠，持续挂载草稿/owner。现有只发标题的远控已增加白名单正文预览、Office定义身份校验及32KiB降级，真实caller显式启用，默认adapter摘要授权保留。安卓0.1.3/code4、电脑与公网中继/UI一并更新；原生已实际配对并查看电脑两张卡、横滑、输入法和撤权通过。先看 [本轮范围和验证](updates/2026-10-23-mobile-remote.md)，优先于下段旧手机信息架构。GitHub仍未提交推送。

2026-10-23 最新 UI 要求覆盖此前 TODAY/Hark 混合方案：已拉取 library `26ac2724`，全面改用 Hark 原 glyph、七份原字体、连续圆角、深浅透明材质与冻结天空；启动器、主画布/展示、设置、Office 和 Android 0.1.2/code3 已接入。TODAY 活跃源码已退到本机忽略缓存，现有模板只保留业务文字。请先看 [本轮来源、范围与边界](updates/2026-10-23-hark-full-ui.md)，不要再按下段旧方案恢复 TODAY。GitHub 仍延后；当前未提交的晚间功能必须保留。

本轮验收：全量 Web654 通过，随后 camera 修复定向8通过；19项桌面/7项手机浏览器分批通过，APK实际覆盖安装/软键盘已查看。`viewKey` 窗口缓存补修了聚焦恢复初始化归零，原精确断言未放宽；缩放0.5/1.4通过。本机18787静态UI已热更新，不重启模型服务。外层 `delivery/hark-full-20261023/` 的0.1.2 APK、Windows ZIP和说明为新交付，SHA见同目录；公网手机站和Travel DEMO未重发。全部临时console已移除，任务模拟器和4329只读预览完成后正常关闭；用户其他服务保留。

2026-10-22 后续审美修订：用户明确拒绝通用深色面板，要求 TODAY 原卡片/布局 + Hark 文字/图标。在同一未推送分支直接复用 xlz 研究的 CSS、17 条模板与内容卡属性，更新 `/launcher`、手机、Office 卡与设置；新增模板草稿交接，不自动发送。APK 升到 0.1.1 / code 2；手机移除旧 WebGL 背景，独立模拟器实际画面正常，并定向验证配对输入键盘后补修底栏遮挡。来源、差异与验证见 [本次修订](updates/2026-10-22-today-hark-ui.md)。此前晚间 ZIP/APK 已由本轮新包替代，旧版本与证据保留。

2026-10-22 晚间演示：在 `8655a52` 上完成原生扫码+WebView 安卓包、Windows `/launcher` 与进程/模型竞态修复、TODAY 参考的三种 Office/Planner 卡片、Hark 风格七组设置页、16 段 STEPFUN 温柔女声，以及独立 Travel Vivic Space。手机公网两轮实际 owner/Display/保存/撤权通过；旅游纯静态 DEMO 已发布。集成补修长卡编辑弹窗、传送到待机画布时唤醒、断网保留内置语音开关。真实模型三类办公卡抽样通过；手机原生 IME/模拟器 GL 问题、飞猪 live/MCP 待接与 GitHub 延后见 [本轮完整更新](updates/2026-10-22-evening-demo.md)。所有子任务已本地完成，产品 GitHub 未推送；不要把 Travel DEMO 或模拟器验证说成 live 飞猪/实机全测。

2026-10-22 后续集成：用户授权本地安装器、决策模型和手机正式接入，`feat/local-runtime-mobile-bridge` 在平台基线上合入 #13/#14 的本地修复，并择取 #18 状态提示。已实现 Windows 固定模型准备/预热/回收、可分发启动/安装包、手机扫码与真实 owner 保存确认，以及本人服务器独立 HTTPS/WSS 中继。全量 Web 616 / API 1178 / 手机 54 通过，3 项既有外部测试跳过；类型、契约、构建通过，真实公网中继 + 隔离 owner/Display/手机浏览器闭环通过。未合并/推送产品仓库分支。体验、真实小模型低覆盖限制和部署回退见 [本轮更新](updates/2026-10-22-local-runtime-mobile.md)、[验收](verification/local-runtime-mobile-20261022.md)。Hark Android 设计包由独立任务上传至 `ECdison6227/rea-ui-library`，不包含私人原包/字体/账号。

2026-10-22 GitHub 交付：本轮新增、更改、体验步骤和边界汇总于 [更新说明](updates/2026-10-22-card-platform.md)，README 已补入口及功能表。[任务分支](https://github.com/ECdison6227/vivic-canvas/tree/feat/card-platform-runtime) 的推送/PR/检查状态以 GitHub 为准；下面各段“未推送”描述的是当时验收状态，不代表后续没有提交。本轮仅创建 PR，不自动合并或部署。

2026-10-22 体验反馈补充：已加入用户页/展示页卡片传送门（同页拖入或点选双向传送）、可见聚焦/显示全部/恢复视图操作，以及 owner 确认与断开禁用。前端 595 项单元测试、78 项同步测试、3 项新增浏览器流程和2项既有画布交互分批通过，类型/lint/build 通过；传送门深色和窄屏截图已检查。当前 5176/8789 预览保留，平台分支仍未推送。详情见 [传送门验收](verification/card-portal-20261022.md)。

2026-10-22 最终验收：PLAT-01 参考协议/旅游 DEMO、PLAT-02 v0.1 声明式包宿主、底层修复、SSE 进度与 105 条评测已本地实现并验收。Web 586 + API 1167 项通过，3 项既有真实服务测试跳过；56 项关键浏览器场景分批通过；冻结安装、类型、契约、lint、构建与交付包校验通过。当前分支 `feat/card-platform-runtime` 已包含最新 main，产品代码提交 `6938d6a`，平台改动未推送。详细真实结果、兼容性及边界以 [平台验收](verification/platform-20261021.md) 为准，不重复执行下面历史“尚未实现”的准备工作。

可直接导入的参考包在外层 `delivery/card-platform/goal-progress.vivicard`。真实飞猪和包内 live 能力尚未接入；真实模型抽样被现有服务 401 拒绝，因此没有模型准确率结论。后续应在此实现基线上接入 xlz 提供的真实适配结果，并在有效连接下跑真实模型评测；#13/#14 继续等待作者修改，不自行并入。

2026-10-21 维护者实现更新：原设置改动已通过 [PR #16](https://github.com/ECdison6227/vivic-canvas/pull/16) 合入，DEC-01 已补配置容错并通过 [PR #15](https://github.com/ECdison6227/vivic-canvas/pull/15) 合入；#13/#14 已请求修改并保留 Draft。当前本机 `feat/card-platform-runtime` 正在完成最终验收，包含 PLAT-01 结构化旅游 DEMO、PLAT-02 声明式导包/Test Space、旧画布恢复、有限上下文、拆包、SSE 进度及中文评测集合。线上任务已存在：[PLAT-01 #9](https://github.com/ECdison6227/vivic-canvas/issues/9)、[PLAT-02 #10](https://github.com/ECdison6227/vivic-canvas/issues/10)。当前能力见 [CAPABILITIES](CAPABILITIES.md)，导包实际接口见 [CARD_TEST_SPACE](CARD_TEST_SPACE.md)；下文 10/20 记录用于追溯，不能再当作功能未实现清单。

真实飞猪响应与真实模型质量仍需独立验收；105 条离线 golden 回放验证的是校验/builder，不等于模型命中率。新的平台实现尚未因上述 #15/#16 自动进入 main，提交状态以当前 Git 与验证记录为准。

更新：2026-10-20。仓库整理已通过 PR #1 合入 `main`（`c20a217`）；GitHub Desktop 已安装并完成本机同步，`main-protection` 已在公开规则页确认 Active。当前为“飞猪旅游系列卡片”整理开发契约、Skill 与交接任务，尚未实现旅游卡片或实际 MCP 接入。

最新：用户提供 10/19 会议 PDF/Excel，并授权只读飞书分工资料。已核对两场原始文字记录，形成 [实名分工与8项工单](team/README.md)、[AI 开工/提交PR提示词](team/WORKFLOW.md)、[两位伙伴所需资料](team/REFERENCES.md)。实际为 xlz 旅游/卡片/UI、马泽瑜决策/启动器、程佳锐核心/接入；此前推测的 CORE/FE/BE 草案已被替代。完整源材料留 `.cache`，不上传原始会议或私有研究内容。尚未创建线上 Issue、Project、assignee 或发送消息。

用户已提供两位账号：xlz=`franzkotkowski330-collab`，马泽瑜/mzy=`Shenbeijc`。账号已写入个人说明、工单与分工数据；线上分配仍未执行。下一教学步骤先提交/发布当前文档分支并 PR 合入，然后创建首轮 PLAT-01、TRAVEL-01、DEC-01 Issue，填写真实链接后再认领开工。

## 用户的最新安排

- 共三人：维护者、偏前端伙伴、偏后端伙伴。两位伙伴使用 AI 编程，需要明确限制。
- 用户已纠正此前分工：维护者重点优化核心流程，也可开发新功能，统筹接口、产品范围与合并。
- 两位伙伴可以开发 Landing、新卡片和新功能，按与核心的依赖程度选择任务；限制写在任务的代码范围、接口与验收条件里，不限制为只交测试报告。此前 FE-001/BE-001 报告草案已撤回，尚未正式分配任务。
- 采用 fork → 任务分支 → PR → 维护者验收；首轮不授予主仓库写权限。主分支规则已启用，成员权限、具体 Issue 和看板尚未设置。
- 本地版验收后再讨论部署、账号与收费。主线不等待伙伴任务，只有复现出的确切阻断问题才进入修复安排。
- 用户随后补充：决策模型优先作为标准能力接入，API/本地均可，用户明确关闭时才选择纯 LLM 路径；现有默认关闭的 Kev 实验不等于完成此目标。JevHarness 已列入 [评估候选](research/jev-harness-assessment.md)，只做初步资料核查，不改变当前 GitHub 操作流程。

## 接手先看

1. [团队任务单](TEAM_TASKS.md)：按依赖分工、任务模板与可复制给 Agent 的指令。
2. [实施现状](implementation-status.md)：已有能力、实验与待开发项。
3. [贡献指南](../CONTRIBUTING.md) 和 [Git 约定](GIT_WORKFLOW.md)：安装、分支、PR、验收。
4. [本地路线](LOCAL_ROADMAP.md)：功能顺序与可分配范围。

## 工作区和验证

仓库 `ECdison6227/vivic-canvas`，集成分支 `main`。本轮卡片文档分支 `docs/card-development-contract` 从干净的 `test`（与 `c20a217` 相同）创建；实际状态以 `git status --short --branch` 为准。按用户的逐步教学流程，不自动提交、推送、合并。

新增入口：[卡片开发契约](CARD_DEVELOPMENT.md)、[项目 Skill](../.agents/skills/vivic-card-development/SKILL.md)、[飞猪任务](tasks/fliggy-travel-cards.md)。开发规则使用现有目标进度卡作可运行样例；飞猪能力只核对了官方文档/仓库，实际工具 Schema、鉴权和响应仍须实测。

用户进一步明确卡片要支持具体参数/用户编辑、确定视觉、深浅色适配、复用现有组件，并以 Agent 按 Skill 制作后可导入为长期目标。已补 [单卡设计表](cards/CARD_SPEC_TEMPLATE.md)、契约 6.1/6.2 与 [扩展设计](CARD_EXTENSION_DESIGN.md)。当前没有通用自动参数表单、插件包安装或外部 renderer 宿主；设计候选不作为已实现 API。

已确认：在设置导入卡片包，先解析校验，再进 Vivic Test Space 弹窗预览和试跑，最后确认安装。[产品流程](CARD_TEST_SPACE.md) 不变；[首轮任务入口](tasks/card-platform-first-sprint.md) 已指向会议校正后的工单。平台协议/宿主由程佳锐牵头，旅游卡片由 xlz 先独立开发再接线。当前文档分支仍待用户按步骤提交和合入。

本轮 Skill 格式、真实解析样例、文档 JSON 与契约一致性通过；API 定向 93 + Web 定向 67 项通过，见 [卡片开发验证](verification/card-development-20261020.md)。尚未提交推送，不把规范交付等同于旅游卡片已开发。

本机已有 Node 24.21.0，依赖按 pnpm 12.11.2 锁定安装。若终端没有 pnpm 命令，见贡献指南中的局部 Corepack 入口。旧 `scripts/dev.mjs` 的跨平台启动仍需真实检查，单独启动命令可用于定位问题。

协作准备阶段已有 Windows 验证：web 520 + API 1,070 项通过，另 3 项跳过；契约、类型和构建通过。`.gitattributes` 固定生成契约为 LF，修复 Windows CRLF 一致性误报。详见 [验证记录](verification/local-development-20261019.md)。PR #1 的 Linux/Windows CI 此后均已通过；真实模型、音频和用户设备的验证边界仍保留。

## 保留的边界

复用现有组件、owner/持久化和受控 Action 链路。不要读取或输出认证文件，不重置用户画布，不因交接而重复 OAuth 登录。自动化静音、不采集物理麦克风；浏览器测试用独立 context 和 5174/8788。

历史交接与旧分支记录移到 [归档目录](archive/README.md)。源码所依赖的生成契约、示例、许可证、模型清单和验证脚本均保留。
