# 设置页设计迁移（2026-10-22）

本次把真实 `/control` 长页整理成可直接到达的七组设置，保持与聊天页共用同一 owner。未新建模型连接流程、支付系统或用户数据存储。原始会议全文仅留本机缓存，本文只记录落实后的产品取舍。

## 来源与边界

来源为 `ECdison6227/rea-ui-library`，本机 `hark/library-worktree`，固定参考提交 `d7f718d1`。

- Web：`platforms/web/hark/reports/design-analysis.md`、`design-tokens.json`。借用半透明表面、细分割线、安静的导航与排版层次。Web 报告中实测正文 15/19 CSS px、常见卡片圆角 24px，与本次目标尺寸分别记录。
- Native：`platforms/mobile/hark-android/design-package.json`、`DESIGN_SPEC.md`、`NATIVE_CONTENT_MAP.md`、`ADAPTATION_GUIDE.md`。只借用设置目标分类与深浅语义角色；原生包仍是 partial，登录后设置屏和动画未完成原版运行验证。
- 字体与组件：沿用 Vivic 已加载的 Geist、Lucide、Radix/shadcn、流光以太。未复制原品牌字体、背景、账号或专有资源；没有重画 Orb。

## 映射与目标选择（D）

| 来源规则 / 需求 | 目标落点 | 实施与验证 |
| --- | --- | --- |
| Hark 半透明表面、主次文字、细边框 | `settings-experience.css` | 映射到 Vivic 背景与现有主题变量；深浅主题分别检查 |
| 设置入口分类 | `SettingsExperience.tsx` | 开始使用、本地能力、模型与语音、外观与画布、卡片与提醒、手机连接、数据与工作区；桌面侧栏、窄屏横向导航 |
| 桌面与移动的信息层级 | 固定顶栏、独立正文滚动区 | 1280px 宽上限、216px 侧栏、18–28px 圆角、44px 导航触区均为目标 D；不声称原生实测值 |
| 10/19 会议中的两种入口 | 开始使用 | “我有自己的配置”进入本地能力；“订阅 Vivic”明确待开放，仅有真实说明展开，不出现假支付 |
| 先本地能力、再 LLM | 本地能力 → 模型与语音 | 决策模型和本地语音先呈现；可打开已实现 `/launcher`，用新窗口保留原 owner；API/OAuth 仍走原 provider 逻辑 |
| 球与背景的适度自定义 | 外观与画布 | 复用 6 深 + 6 浅流光以太配色、主题、字幕、减少动画；球位置继续自动安排，不添加未实现控件 |
| 会议里的卡片商店愿景 | 卡片与提醒 | 将当前可用入口表述为内置卡片与导包 → Test Space → 安装；保留现有扩展管理组件 |
| 语音反馈事实 | `AiSection.tsx` | 说明仅温柔女声且 TTS 开启时匹配内置短句；其他音色与内容按服务生成，未自动开启 TTS |

所有原设置面板连续呈现，导航只滚动与移动焦点。AiSection 唯一挂载，原来的状态轮询、OAuth、Key 表单和下载生命周期保持。聊天与设置仍由 `ControlShell` 同时挂载并按原 view 隐藏；草稿、正在进行的请求及 owner 不因分组导航改变。

## 修改边界

- `ControlApp.tsx`：仅 ControlShell 中的设置内容分组、SettingsExperience 导入。
- `SettingsExperience.tsx` / `settings-experience.css`：设置壳、导航、入口、双主题及窄屏样式。
- `AiSection.tsx`：分出模型与语音的视觉层级、修正 LLM 标签和说明、API Key 行窄屏换行。没有修改连接与语音行为。
- 新增组件单测与 `settings-experience.spec.ts` 浏览器验收。

球颜色缺少当前 DisplayPreferences 与 Orb 同步契约，不能通过 UI 层实现真实保存；本次没有放置假颜色选择器。任意唤醒词、订阅支付、真实卡片市场均未被描述为已完成能力。

## 验证

定向单测：SettingsExperience、AiSection、BackgroundSettings 共 11/11 通过（`--maxWorkers=1`）。首轮机器并发负载下既有 AiSection 5 秒测试超时，串行原断言与原超时复跑通过。

浏览器验收：`apps/web/tests/e2e/settings-experience.spec.ts`，3/3 通过。使用独立 context，阻止物理麦克风访问与模型权重下载，不开启 TTS；覆盖键盘导航、唯一 AI 面板、owner / 聊天草稿保留、390px 深浅色、横向溢出与固定顶栏位置。截图已实际查看，位于忽略目录 `.cache/settings-browser-results/`。

截图发现并修复了窄屏 `scrollIntoView` 同时滚动顶层页面的问题：分组跳转现在只滚动正文，焦点落在目标标题，顶栏保持可见。测试通过真实主题控件切换深浅色；既有 URL `?theme=dark` 会被 host 初始偏好覆盖，因此未用 URL 参数冒充深色验收。

定向 oxlint 无错误，仅保留 AiSection 既有同步 setState effect 警告。完整类型与构建由主线程统一执行，避免并行写共享产物和挤占当前机器内存。

回退仅需恢复上述 UI 文件到改造前的设置布局；不需要迁移或清理画布、账号、模型缓存或本地偏好。
