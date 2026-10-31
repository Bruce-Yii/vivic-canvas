# 卡片二次打磨（2026-10-23）

本轮保留所有既有未提交工作，不新增 cardType，不提交、推送或发布。官网/产品完整对应见 [卡片覆盖表](../cards/coverage-20261023.md)：25 个展示项、24 个展示类型、21 个内置场景、26 个真实 renderer，以及复用 ExtensionCard 的三个办公包。

## 实际修改

1. **可恢复编辑**：目标进度和读书页码保存失败后保留用户输入；进度空白输入不再被 Number 转成 0。进度/页码 Enter 提交、Escape 放弃；通知状态/移除失败反馈明确。旅游个人备注改为草稿失焦提交，拒绝时保留；只允许原有 selectedIds/notes，服务价格/来源仍由 owner 字段策略拒绝修改。
2. **内容和尺寸**：共享 SceneCardShell 不在可编辑阅读态截断标题；窄容器标题栏/徽章可换行、页脚长标识不撑宽。进度大数字/操作行可换行、百分比按长度缩小；周计划无时刻事项不再留空时间列，极窄容器时间单独成行。固定高度办公卡整段内容可滚动，长说明不会挤掉所有行动项；通用扩展卡内容可滚动、表格可聚焦横向阅读。
3. **媒体状态**：旅游和扩展图片复用现有 MediaImage，失败显示明确占位而非直接隐藏为空白；通用扩展页脚不再常驻包 hash。DEMO 扩展预览仍不加载远程图、不打开外链。
4. **手机纵向预览**：列表/图表/表格空态、长数值换行、图表可展开数值清单，保留 Recharts。计时只对 CountdownCard + metric + 现有 adapter 严格生成格式启用本地跳字；纯计时无标题/类型装饰，事项显示完整事项和时间。暂停固定已投影值；条件未满足显示等待。格式不符、无效日期、被截断或其他类型回退原摘要。
5. **可复核入口**：CardPlayground 使用既有 HarkBackdrop/HarkSurface 与真实组件，支持 `scene/theme/width` URL 参数，计数来自 SCENES。它只写内存，不连接真实画布。

## 来源到目标映射

Hark 来源固定为 `ECdison6227/rea-ui-library@26ac2724f29b4ee46962146fed2b6d545bf62180/platforms/web/hark`，本机路径 `C:/Users/edsjrcheng/Desktop/hark/library-worktree/platforms/web/hark`。已读取 design-package、DESIGN_SPEC、ADAPTATION_GUIDE 与 rea-design-transfer/transfer 指引。来源 readiness 仍为 partial。

| 来源规则/资产 | 本轮目标 | 处理与差异 | 验证 |
| --- | --- | --- | --- |
| GT Standard L / Hark Serif 字体角色 | 既有 SceneCardShell、手机预览、Playground | 沿用 `components/hark` 原字体；未换近似字体；中文按既有回退 | 真实组件测试；字体加载与像素由主 Agent 浏览器核验 |
| 连续角与 fill/stroke 独立层 | Playground 真卡外壳、既有办公行 | 直接复用 HarkSurface 原算法薄包装，未新增外壳算法 | 类型检查；主 Agent 视觉复核 |
| 原 SVG 字形与 compact 内容层级 | 共用标题栏/手机卡片 | 沿用 HarkIcon，领域缺项保持 Lucide；不重新描图 | 原有组件仍被调用，测试断言真实 renderer |
| 长内容内部滚动、编辑失败恢复 | 扩展/办公/进度/阅读/旅游 | D 目标业务适配；不是声明原 Hark 后端行为 | 新增失败草稿和全部类型 owner 保存恢复测试 |
| 独立可读数值/状态 | 手机图表与计时 | D 目标投影；保持 2 页遥控边界和原白名单 | 移动组件、投影、协议回归 |

## 手机兼容性决定

未给 `CardPreviewSchema`、Hello、Welcome 或消息帧增加字段。旧客户端对未知字段 strict 拒绝，因此本轮选择解析既有受控可见摘要而非直接扩协议。`countdownPreview.ts` 只接受已知类型、metric、标准数字/等待值、严格 ISO 与完整正文/标题匹配；没有模糊日期解析，不能从 Notification 或任意文字猜计时。Adapter 增加严格 ISO 检查及未满足条件的等待值，仍只发已有 kind/stat/body。

这种兼容适配不增加读取 sourceData、任意扩展 data、执行权限或远程编辑权限。暂停时间仍由 owner 投影的静态数值体现；旧摘要未带条件等待状态时无法还原条件，本轮不会推断。将来如要结构化计时字段，需独立完成旧 relay/旧手机能力协商和按 peer 裁剪；不是当前交付前置。

## 本轮验证

- Web 最终合并定向场景、经典数据卡、办公、扩展隔离、服务字段策略、官网样例及新编辑/手机预览：9 文件 133 项通过。其中新覆盖测试 3 项验证官网清单、26 类型 owner 保存/重开、全部官网手机白名单投影。
- `contrib/mobile-console` adapter + protocol：2 文件 40 项通过，覆盖原字段形状、暂停、条件等待、无效 ISO、未知扩展、授权与数量/长度上限。
- API scenes + office packages：2 文件 78 项通过，使用受控 fixture，不调用模型或真实旅游服务。
- Web `tsc -b` 与 mobile prototype `tsc --noEmit` 通过。
- 本轮卡片文件定向 `git diff --check` 通过。定向 oxlint 无错误；既有 Playground ref、Book 纯度/导出、Travel Date.now 警告未改动或放宽规则。

命令统一从仓库根使用 `corepack pnpm --filter <包> exec vitest run <测试路径>`；当前环境脚本加 `--` 的形式会丢失定向筛选，应避免误跑并发全量。曾误触全量后立即停止；当时 `LocalDecisionSettings` 出现并发 UI 中间态失败，已告知主 Agent，未修改该测试或放松断言。

主 Agent 负责最终统一构建、真实浏览器/手机视觉和整体回归。本执行者未启动浏览器/模拟器，未播放语音，未写用户画布，也不把单测和源码核对当作 12 个配色全部完成视觉验收。历史 e2e 的已覆盖路径列在覆盖表中供本轮选取；是否实际运行以主 Agent 最终记录为准。

## 后续真实 planner 失败修复

主 Agent 的真实 StepFun 合成样例输出保存在 `.cache/simple-assistant-live/synthetic-*.json`（2026-10-23 22:25–22:26，Asia/Shanghai）。诊断脚本仅在固定 fixture 循环捕获模型结果，进入服务阶段关闭捕获；没有将 key、请求 headers 或用户交互写入本报告。实际观察到：

- `photo_gallery/activity_feed` 首次把分类填成实例编号或漏掉 scene_id；第二轮修正可成功。
- `book_record` 同时生成带日期的 scene_id 和数组 author。旧反馈只报告前一处，第二轮仍保留数组。
- `habit_tracking` 复制提示示例的 `weeklyGoal:4`，而用户只提供打卡日期。
- `news_summary` 把当天日期写为 publishedAt，原文实际只给事件开通日。
- `option_comparison` 把 A/B/C 改成方案A/方案B/方案C，无法原样追溯后两项名称。

本次只修改 `scenes/prompt.ts`、`payload.ts`、`build.ts`：说明 scene_id 为固定分类、推荐省略冗余 card_type；展示真实 JSON 键、另列可选字段；移除无依据目标/评分示例，明确作者字符串、原方案名和发布日期语义。错误提示可根据已登记的精确类型同时报告分类和字段形状错误，但不会据此接受、猜测或改写非法 payload。没有放宽字段 Schema、事实匹配或增加重试次数。未提供每周目标或发布日期的样例保持省略；模型编造时仍拒绝并让模型修复，避免向用户追问并非必要的信息。

新增 `apps/local-api/tests/scenes-live-regression.test.ts`，联合已有 scenes/extension-scenes 共 **3 文件 85 项通过**。这是由真实失败输出提炼的合成回归，不替代主 Agent 重启测试服务后的真实模型复测。

主 Agent 浏览器检查同时发现 CardPlayground 窄屏两列互相挤压，已将预览布局改为窄屏单列、xl 桌面两列；不改产品画布。新的截图与真实模型复测结果由主 Agent 统一记录。

主 Agent 后续完整真实复测中，21 场景有 20 项通过；旅游唯一失败的原输出同时给出 `dateText:"下周"` 和无依据的 `startDate:"2026-10-27"`。校验正确拒绝具体日期，但旅游错误携带 ask 导致首轮立即返回澄清。最终修复只针对“已有可信 dateText、额外 startDate 无依据”返回内部修复 issue，让原有第二轮规划省略编造的精确日期；不修改或接受首轮 payload、不提前调用 provider、不增加重试。真正缺日期/晚数/出发地仍澄清。提示另明确粗日期仅使用 dateText。新增单项回归通过，确认首轮 provider 未调用、修复后仅调用一次、查询保留原日期范围和 DEMO 来源；真实旅游复测结果由主 Agent 记录。
