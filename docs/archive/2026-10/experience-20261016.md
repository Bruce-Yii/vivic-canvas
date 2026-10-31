> 历史归档：原路径 `docs/experience-20261016.md`。记录当时的需求与验证，不作为当前操作指令。当前入口：[README_FIRST](../../../README_FIRST.md)。

# 三项体验优化 · 2026-10-16

本次在 `agent/next-iteration` 延续已有实现，只处理排版材质、Control 长文详情与快速找卡。子卡片、行关联、固定编号选择、提醒合并和撤销沿用原实现。

## 设计与实现

北极星：让画布内容容易远看，让 Control 长文容易连续阅读，动作保持安静明确。

沿用 Geist Variable 和系统中文回退、Assistant UI styled registry、Radix/shadcn、Motion、React Flow、Grainient 和 Orb。没有采用 HARK 的字体、私有组件、压缩代码或天空程序，也没有新增卡片/背景引擎。无新增图片素材。

- 中文卡片正文 16px / 28px，标题保留字重层级，来源为 13px 辅助角色。单层半透明填充、轻描边和低强度阴影，不给每张卡加 backdrop blur。数字继续等宽。纯倒计时只有数字，带事项提醒沿用原合并列表。
- Grainient 仅调整公开参数：speed 0.35、flow 0.45、grainAmount 0.045；既有日夜配色、单实例、隐藏暂停、减少动效、DPR 和 context-loss 降级保留。
- 卡片 padding 22px / 20px 与正文估算集中到 `cards/metrics.ts`，CSS tokens 对齐；Todo/展开 Note/提醒估算和 Table/Chart/Search 内部高度同步。固定卡继续作为障碍，旧画布修复和撤销复用原排布策略，两张固定卡相互重叠时不会移动其坐标。
- Control「卡片与子卡片」为便笺与搜索/文章卡增加独立「阅读详情」。只保存临时卡片 ID，正文每次从当前 store 读取，不生成副本，不修改 Note.variant、原文、布局或 metadata。文章使用已有 `sourceData.articleText`；没有正文时显示已有搜索摘要，并明确区分正文截取与摘要。Markdown 复用既有 renderer，没有增加 Streamdown。
- Control 顶部「快速找卡」及 Cmd/Ctrl+K 打开 shadcn Command/cmdk。中文、全拼、首字母匹配当前画布活卡片的标题、别名、待办事项、提醒与便笺内容。结果显示类型、摘要和完整稳定 ID；选择只执行已有 `card.focus`。已到时/正在删除的卡片不参与，不按模糊匹配删除。
- 搜索实现及 cmdk/pinyin-match 由 `React.lazy` 按需加载；Display 不调用搜索入口，不加载搜索 chunk。只读窗口可检索与阅读，不能聚焦或自行接管 owner。
- 两个阅读层都使用 Radix Dialog 的焦点陷阱、Escape 与焦点恢复；支持滚动和选择文字。切画布、删除目标、控制权变化立即失效。ControlSnapshot 的临时 ownerId 来自已有 owner 广播，保证窗口始终只读时也能识别 owner 换人，不改同步协议或持久化格式。
- 弹窗 180ms 淡入/8px 移入，减少动效时立即到位；现有聚焦镜头、卡片增删与子卡片 Motion 沿用。异步搜索只替换弹窗内部内容，避免加载完成时焦点跳回入口。
- 窄屏验收发现已有隐藏图片 file input 的 `w-full` 覆盖 `sr-only`，局部锁定 1px 尺寸，避免隐形控件撑宽页面，不改图片处理逻辑。

正文、说明和动作以已有信息为准。移除顶部重复的「文字指令 · 提醒 · 画布管理」说明，为找卡入口留空间；未增加填缝文案或新装饰。

## 来源与许可

- `cmdk@1.1.1`、`pinyin-match@1.2.10`，精确版本锁入 pnpm；两个 npm 包均 MIT，包内许可已复制至 `docs/third-party/experience/`。
- shadcn `radix-nova/command` registry 源码来自 https://ui.shadcn.com/r/styles/radix-nova/command.json ，2026-10-16 获取；将输入容器接到本项目 markup、Lucide 和既有 Radix Dialog，保留真正的 CommandPrimitive。没有安装另一套 dialog 设计系统。
- registry 响应 SHA256：`c6b71409eb4166193efa3489dc45e55afd0a86f2157fad84d6271f007ad404a0`；cmdk `dist/index.mjs`：`9e11be720996de8ce85d7c31f91d87a92ddc903880b7b2e2d4f21859b4cbd09d`；pinyin-match `es/main.js`：`e6d7e5c9a5bbd9db4509776ee90d92e0554e5e5b3f8f922bd87550184971a2a1`。

## 验证、证据与边界

前端单测 386/386（47 文件）通过；`pnpm typecheck`、`pnpm build` 通过，新组件定向 oxlint 无告警。新增搜索 chunk 构建为 44.67 kB / gzip 27.99 kB；这不是总包体积或运行内存指标。浏览器最终结果见 `verification/experience-20261016.json`，本地对应完整日志在 `logs/`。

最终有效检查采用独立 context、5174/8788，串行运行不同 Playwright 命令；TTS 关闭，拦截音频播放与麦克风，不触碰用户真实画布。一次 WebKit 重测误提前启动，与前轮短暂重叠、随后受到前轮服务器退出影响，该轮作废并保留日志，后续严格串行重跑。检查包含键盘入口、方向键、Enter/Escape、Tab/Shift+Tab 与焦点恢复、IME 确认防误选、空结果、目标删除、同 ID 切画布、owner/只读生命周期、详情同步、原文/variant/固定布局不变、刷新、旧画布恢复、实际卡片几何避让。

独立视觉评审 1 轮（存量润色，不打分）和主 Agent 截图复核：已处理找卡预览露出 Markdown 标记，以及长文滚动区矩形焦点框的圆角衔接；焦点仍清楚可见。找卡说明精简为「查找当前画布的卡片，支持中文与拼音。」。日夜材质、正文层级、390px 详情/找卡、800px 固定卡画布与旧画布已留图。短录屏 6.56 秒（VP9，1100×800，无音轨）已留档并抽帧目视；正常/减少动效打开与关闭通过浏览器状态断言，不据此推断帧率。

初轮回归中，Note 行渲染调整漏掉了文本节点之间的换行；已恢复原始换行文本，原展开/收起测试复核通过。Firefox 的 `fill()` 会发 compositionstart/end，立刻 Enter 被防误提交保护拦截；事件诊断日志保留，找卡快速 Enter 改用真实拉丁按键输入拼音，专门的合成 IME 确认测试继续保留。cmdk 的受控选中 ID 始终来自当前有效结果，不保留已经被过滤掉的目标。WebKit 鼠标打开时不会总是聚焦按钮，返回焦点已改为记录真实触发按钮，删除时转到找卡入口。Tab 的原生按钮遍历顺序和 Home/End 行为依赖 macOS/WebKit 设置，因此检查焦点保持在 Radix Dialog 内，并用 PageDown/PageUp 验证可正反滚动。

本机证据目录：`evidence/experience-20261016/`。`baseline/` 保留改动前截图，`final/` 保留各状态，`logs/` 保留检查输出；不会删除原失败记录。evidence 按仓库约定不入 Git。

本次不扩大原文获取范围：便笺原有限长、正文原截取上限与搜索证据语义保留。拼音匹配是候选查找，不承诺任意错字、同义词或跨画布检索。真实操作系统中文输入法、物理 Safari、外接屏和实际 GPU 流畅度仍需本人验收；合成 composition 事件只验证应用的防误选逻辑。没有进行真实账号推理、麦克风或发声验收。

构建仍有上游 Sherpaw WASM/Node module 外部化和原大 chunk 提示。Firefox 跑测出现一次 `VoiceInput` / `SelectProvider` 跨组件更新的 React console 告警；本次未修改该语音设置模块，相关详情与找卡断言通过，不能宣称所有日志为零。该告警和原始失败检查日志均保留；没有把自动化结果当作真机语音或 GPU 性能验收。

最终浏览器结果：

| 检查 | 实际结果 |
| --- | --- |
| Chromium 最终综合（新体验、旧子卡片/编号选择、布局增长/撤销、主题、60 卡） | 23/23；对应最终代码 |
| Chromium 快速拼音找卡/Enter 重复检查 | 3/3，三轮 |
| Firefox 新体验与材质/旧画布 | 21/21，7 项各三轮；随后最终焦点修正单独 3/3 复核 |
| WebKit | 其余 6 项各三轮共 18 次通过；详情键盘/焦点修正后单独三轮 3/3；7 项最终分批覆盖，不能描述成同一轮 21/21 |

排版提交 `1b1a7e4`，详情/找卡代码与测试提交 `a8b813c`。文档提交另列；未推送、合并或发布。
