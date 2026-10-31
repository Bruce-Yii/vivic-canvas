# 自选颜色取色器

2026-10-28（Asia/Shanghai）

- 删除自选配色下方的说明文字。
- 删除色块旁的独立色号显示。
- 点击色块打开取色框，内含饱和度/亮度面板、色相滑条、当前色预览和可编辑 HEX 输入框。
- 支持带或不带 # 的六位 HEX；三位简写在确认时展开。无效输入不会覆盖有效颜色。
- 颜色实时更新、沿用现有服务器偏好保存；支持键盘 Escape、焦点返回及 390px 手机宽度。
- 发布时统一资源中的入口版本引用，避免线上入口 7 与旧入口 6 同时初始化。

Edge 线上检查全部通过：文字移除、取色框当前值、精确 HEX、无效输入、三位简写、可视选色、键盘关闭、独立颜色保存、刷新恢复、深浅色隔离和手机布局。页面脚本及 HTTP 错误均为 0。

证据：`live-edge-results.json`、`live-edge-picker.png`、`live-edge-mobile.png`。

服务器发布与备份目录：`/opt/vivic-preview-20261025/releases/color-picker-20261028-1`。
资源版本：`/assets/color-picker-20261028-1/`。
可恢复镜像：`vivic-preview-20261028:color-picker`。

回退：将发布目录的 `index-before.html` 复制回容器 `vivic-preview-20261027` 的 `/app/apps/web/dist-online/index.html`。原资源保留，后端未重启。
