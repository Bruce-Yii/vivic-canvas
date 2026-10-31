# 背景主题与空间光效

日期：2026-10-28（Asia/Shanghai）

地址：https://vivic.edsionc.top/control

## 已上线

- 删除新增的“返回主界面”按钮、专用标记及包装代码。原关闭按钮继续使用原站内导航。
- 按提供的 `vivic-theme-lab.html` 读取 7 套深色与 6 套浅色配色，保留参考中的中文名称和颜色值。
- “空间光效”提供柔光雾面、顶部极光、丝绸流光、液态流光、纯净背景。
- 保留暂停、柔和、灵动选项，新增 0.25–2.00 倍流动速度、0–100% 光晕强度和恢复默认光效。
- 可分别为深色、浅色配置背景底色、两个光晕颜色、点缀色。选择预设时切回该预设；深浅色切换保留各自的自选方案。
- 偏好沿用现有账号/画布的服务器元数据保存和窗口同步，刷新后保留，用户页、设置页、展示页共用。
- 暂停与系统减少动效会保持静态；纯净背景和 0% 强度不显示光晕。

## 实现

新增可维护的 `atelier-background.js`、`atelier-background.css`。配色模块数据来自上传 HTML 的主题数组，并校验颜色格式；保留旧预设 ID 作为兼容映射，增加星河灰蓝预设。

扩展前端偏好校验及分发字段，沿用现有受认证保护的元数据接口；无需修改或重启后端。

保留原液态背景实现，为其接入自选颜色与速度；参考 HTML 的柔光、极光与丝绸效果使用对应 CSS 渐变和漂移动画。

## 验证与发布

独立测试账号在 Edge 和 Chrome 验证：13 套预设、按钮删除、深浅色自选方案互不影响、全部光效、速度、强度零值、暂停、系统减少动效、刷新恢复、展示页同步及 390px 设置布局。脚本错误及 HTTP 错误均为 0。

证据：`live-edge-results.json`、`live-chrome-results.json`，以及同名前缀截图。

期间线上入口更新到版本 6，已保留其更新。完整资源版本为 `/assets/theme-atelier-20261028-1/`，HTML 和各模块保持同一个 `main-AccessRecovery20261028-6.js` 入口。

服务器发布、备份与源码：`/opt/vivic-preview-20261025/releases/theme-atelier-20261028-1`。

- `index-before.html`、`assets-before`：发布前快照。
- `index-after.html`、`assets-fixed`：发布后的网页文件。
- `patch`、`theme-manifest.json`：本次源文件及修改清单。
- 可恢复镜像：`vivic-preview-20261028:theme-atelier`。

回退：将 `index-before.html` 复制回容器 `vivic-preview-20261027` 的 `/app/apps/web/dist-online/index.html`。旧资源保留。
