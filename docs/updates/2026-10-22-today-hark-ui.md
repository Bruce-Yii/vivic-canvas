# TODAY 布局与卡片 / Hark 文字与图标修订

> 本页保留旧版本记录；当前 UI 已由 [2026-10-23 Hark 全面接入](2026-10-23-hark-full-ui.md) 替代。

用户拒绝此前的通用深色面板，明确要求严格复用 xlz 提供的 TODAY 研究；随后指定 TODAY 的文字和图标改用自己的 Hark UI 库。本轮据此替换了桌面启动器和手机界面的呈现层，并调整办公卡片与设置的材质和排版。

## 来源与实际复用

TODAY 固定 `franzkotkowski330-collab/today-ai-rea-research@70a6d69d4e8cef19f6e3a3afd2d9bcfb41fa2ee6`，使用根 `design-package/` 的认证研究与 `reconstruction-demo/src/AuthWorkspace.jsx`、`auth-workspace.css`、`style.css`。未将另一个 `primary-delivery` 的游客页研究冒充已登录工作区。

- `apps/web/src/components/today/today-source.css` 保存来源认证参考 CSS 的完整原字节。
- `task-catalog.json` 从 TypeScript AST 静态读取来源数组，保留 8 条普通任务、9 条定时任务的原始标题与描述，没有执行来源脚本。
- `TodayTaskCard` 沿用来源 TaskCards 的 article / icon / title / description / circle-action 结构。
- `today-cards-source.css` 保留来源 Today 内容卡、2×2 指标、进度与步骤规则的属性和媒体条件，只增加目标作用域。
- `SOURCE.json` 记录三个来源文件的 SHA-256 与固定提交。新增样式、目标事件与业务插槽单独实现。

Hark 固定 `ECdison6227/rea-ui-library@d7f718d1`。文字采用 Web 的 15px/19px 正文及对应 13px/18px 辅助、20px/24px 标题角色，图标复用目标已有 Lucide 并调整到库中记录的线性图标风格；不再复用 TODAY 参考里的字符图形或临时手绘 fallback。原 GT Standard L 文件在库中标记 withheld / license-gated，本轮只绑定本机已有 family，再回退现有可分发字体，未夹带原字体文件。

## 目标落点

| 落点 | 采用内容 | 目标行为 |
| --- | --- | --- |
| `/launcher` | TODAY 1:1 双栏、右 pane 12px 圆角/6px inset、冷蓝至暖桃渐变、玻璃 Tabs、指标卡、原始任务清单 | 保留实际模型状态与启停；来源模板进入画布可编辑草稿，绝不自动发送 |
| 手机控制 | TODAY 半透明任务卡、24px 卡片、浮动底栏和静态渐变；Hark 排版与 Lucide | 原扫码/可信地址校验/owner 确认不变，增加卡片/任务/记录的实际导航与模板草稿 |
| 办公卡片 | TODAY 80px 任务行、8px 节奏、24px 轮廓、半透明表面；Hark 字号字重 | 现有 Schema、包身份、编辑/完成/撤销/传送/保存保留 |
| 设置 | 相同 pane/半透明表面与 Hark 文字角色 | 七组持续挂载，导航只滚动正文；不改模型、owner 或持久化行为 |

手机改用来源静态渐变，不初始化旧版 WebGL 背景。这样减少了原生 WebView 的额外图形工作，但不能据此声称先前 QEMU 渲染问题或所有真机 IME 已解决。手机 12 配色、深色派生与安全触区为目标 D；原版认证手机材料仅有 390×844 任务页样本，不能声称已取得 Today 原生 Android/Windows 客户端完整实现。

## 验收

- 17 条模板正文来自原始静态数组；普通/定时任务分组和来源卡片几何由浏览器核对，原始任务行 radius24 / min-height80 / gap8，与用户指定的 Hark 15/19 字号同时生效。
- 首轮手机/启动器/办公/设置相关单测通过；新增草稿连续读取、过期、异常及消费用例通过。手机原有 6 条浏览器闭环通过。
- 桌面来源任务内容、17 模板切换、真实画布草稿交接、无自动请求、办公三卡和设置 7 条浏览器流程通过；窄屏额外发现原来源 media 会隐藏面板头部，目标保留其导航并单项复测通过。
- 生产 Web 构建通过。APK 0.1.1（versionCode 2）使用原开发签名更新，v2/v3 签名校验通过，正式包不启用 WebView 调试。
- 0.1.1 已在独立无账号模拟器安装并实际查看画面，未出现旧截图花屏。配对输入的真实软键盘已确认 `mInputShown=true`，首次发现浮动导航会盖住输入框后，增加焦点/可视区检测，键盘打开时收起底栏；修复后再次查看实际截图，配对框完整位于键盘上方。相关单测通过；不外推为真机或全部聊天 IME 已测。
- 新手机任务导航与原模板草稿插入浏览器场景通过，未自动提交指令。桌面 8 个场景分批通过（7 个整体通过、窄屏导航修复后单项通过）。
- 截图、源属性核对和构建日志位于 `.cache/today-hark-rework/`，旧界面源码已保留在其 `before/`；没有重置真实画布或向 TODAY 接口发送请求。

原站结构/数值来源分类保持 A/B，参考源码和本轮适配属于 D。用户已在本会话说明与 TODAY 的合作授权；未向公开制品复制来源账号、私有截图、原站照片或未提供的资源。此修订不改变飞猪 live 仍待接入、产品 GitHub 推送仍延期的安排。
