# 设置页交互修改

日期：2026-10-28（Asia/Shanghai）

地址：https://vivic.edsionc.top/control

## 已上线的行为

- 设置页顶部新增带文字的“返回主界面”按钮，调用原有站内导航返回 `/`；保留原关闭按钮。
- 飞书、麦当劳、企业微信、钉钉各自拥有独立的展开、输入、接入方式、请求状态和反馈状态，可以同时展开。
- 展开或收起一个服务不会清空其他服务的输入；收起后重开本服务也保留当前草稿。
- 离开设置页后继续清空授权输入草稿，服务连接接口和凭据保存方式沿用原逻辑。

## 实现与发布

修改实际使用的 `ControlApp-PlatformKeyLock20261027.js`。保留现有服务组件，将其按 provider 建立独立实例，并在顶部加入明确的导航按钮。

期间线上入口从版本 3 更新到版本 4；已基于最新版本 4 重新应用修改，保留了新版引导等其他更新。

完整资源发布在 `/assets/settings-20261028-1/`，HTML 与各模块仍使用同一个 `main-AccessRecovery20261028-4.js` 入口。通过暂存 HTML 后原子切换生效，未重启后端容器。

服务器发布与备份目录：`/opt/vivic-preview-20261025/releases/settings-navigation-20261028-3`。

- `index-before.html` / `assets-before`：发布前快照。
- `index-after.html` / `assets-fixed`：发布后网页与资源。
- `patch-manifest.json`：修改清单及原文件哈希。
- 可恢复镜像：`vivic-preview-20261028:settings-navigation`。

回退：将该目录的 `index-before.html` 复制回容器 `vivic-preview-20261027` 的 `/app/apps/web/dist-online/index.html`。旧资源仍保留。

## 验证

独立测试账号已在 Edge 与 Chrome 的线上页面完成以下检查，所有检查通过、页面脚本错误为 0：

1. 直接打开 `/control` 时返回按钮可见。
2. 飞书、麦当劳同时展开，输入彼此隔离。
3. 四个服务全部展开，任意单项可独立收起、重开。
4. 飞书接入方式和 App ID 不受其他服务开合影响。
5. 点击返回按钮回到用户主界面，无白屏。
6. 离开设置页后授权输入草稿清空。
7. 390px 手机宽度下返回按钮仍在可视区域内。

证据：`live-edge-passed-results.json`、`live-chrome-passed-results.json` 及同名前缀截图。预验收使用本地资源替换；最终验收直接请求线上发布资源。
