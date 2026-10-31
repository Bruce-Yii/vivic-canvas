# Hark Web 精简与 PDF / Markdown 收口

本轮按用户的明确修正实施：采用 `ECdison6227/rea-ui-library` 的 Hark Web，轻量、简单、极简；不继续扩功能。文件只支持 PDF / MD，撤下 Word 阅读。

## 设计来源与采用方式

固定来源为 [rea-ui-library / platforms/web/hark](https://github.com/ECdison6227/rea-ui-library/tree/26ac2724f29b4ee46962146fed2b6d545bf62180/platforms/web/hark)，本地缓存 `.cache/hark-source-26ac2724`。已复核 `design-package.json`、`DESIGN_SPEC.md`、布局和接入指南；继续复用 `components/hark/SOURCE.json` 中的原资产，不重新研究原 App。

| 来源 | Vivic 落点 | 本轮处理与验证 |
| --- | --- | --- |
| GT Standard L / Hark Serif / 原 glyph | 输入、菜单、标题、图标 | 保留现有原字体和 SVG；中文按库约定回退系统字体 |
| 聊天内容带 512px、输入 15/19 | ChatComposer | 继续固定内容带；空输入收起不可用的发送按钮，已启用语音时保留麦克风以支持草稿 |
| 附件菜单、主次操作关系 | ComposerMenu | 复用 Radix Popover + HarkSurface；图片、PDF/MD 上传、查询资料合并到“＋”，语音自动发送选项也放在菜单内 |
| 连续圆角、独立 fill/stroke、主题材质 | 菜单、卡片、阅读层 | 继续使用原连续圆角 helper、源 alpha 与字体；不引入新图标系统或 TODAY 样式 |
| 内容优先、独立阅读层 | FileCard / ConnectedResultCard | 去掉重复“打开阅读/阅读结果”页脚；整卡点击，摘要去掉 Markdown 标题标记与多余空行；保留来源 |
| 轻导航、按需展开 | UserCanvasControls | 传送门/展示/搜索收为 44px 图标，移除聊天顶部重复的显示全部/恢复视图，保留传送门内的操作；390px 同一行不溢出 |

以上操作合并是 D 类 Vivic 适配；来源库本身为 partial，不声称原 Hark 所有状态或所有像素均已复现。

## 文件行为

- 新上传白名单为 `.pdf,.md`，最多 5 个，单次合计 10 MB，Space 100 MB，容量和持久化规则不变。
- PDF 继续原页渲染/翻页；Markdown 继续排版阅读、长文分段、原件下载。打开文件不会调用模型，问 Vivic 仍需用户主动打开。
- 删除 DOCX 的解压/XML 正文解析路径；TXT/CSV/JSON 同样不再新上传或内置阅读。
- 保存数据契约保留历史格式，以免旧画布无法加载。旧文件卡只保留名称、格式、原件下载，不删除 IndexedDB 原件，不显示旧预览。
- 文件 Agent API 在获取模型前拒绝非 PDF / MD 文件名。画布模型上下文去掉旧格式的提取正文；手机投影和手机渲染双方都屏蔽旧正文，包括旧电脑发送来的 Word 预览。
- 手机仍只有聊天/纵向 Space。文件原件下载、双向传送门、撤销重做及已授权查询能力保留。

## 验证

本轮定向 Web 单测 43 通过，文件 API 单测 5 通过。浏览器分批覆盖 20 个独立场景：桌面/窄屏导航、附件菜单焦点与返回、草稿、图片、合成麦克风的转写/自动发送/取消、PDF/MD 阅读、历史文件仅下载、桌面与手机双向传送门、飞书及麦当劳的 fixture 查询链。没有采集物理麦克风或播放音频。

检查过程中修正了 forceMount 菜单关闭后焦点未返回，以及已有草稿时麦克风被隐藏的问题。历史 Word 浏览器测试先因测试数据缺少必需时间戳未创建卡片，补全合法数据并检查 dispatch 回执后通过；没有放宽业务断言。

类型检查、生产构建、相关 lint 通过（lint 保留已有 React 建议级警告）。Android 更新为 0.1.9 / code 10，生产包 v2/v3 验签通过。截图与本轮包在外层 `delivery/hark-minimal-20261024`；具体包 SHA 和生产启动结果以该目录回执为准。

最终 Windows 包在隔离目录实装后 12 项检查通过，回执 `.cache/windows-install-verification-1792835342600/result.json`。随后在实际安装目录启动服务，真实上传/打开 Markdown，已打包 Worker 运行正常，普通阅读 0 次模型请求；结果 `.cache/hark-minimal-20261024/production-reader.json`。临时端口均已关闭，原 18787 / PID 126080 保留。

不推送、不公开部署、不改用户运行中的 18787 服务；未重跑 Mac/模型全量验收。真实第三方账户授权仍未新增，fixture 查询不是用户飞书/麦当劳账号的真实数据。本轮 Android 验证为编译、验签和共享网页流程，未重新做物理安卓设备验收。

回退须只撤回本轮菜单/白名单相关改动，保留此前未提交工作与原件；不能按旧文档重新开放 Word 阅读，除非用户再次明确要求。
