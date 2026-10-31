# Vivic 登录后白屏修复

日期：2026-10-28（Asia/Shanghai）

线上地址：https://vivic.edsionc.top/

根因：HTML 加载 `main-OnboardingCleanup20261027-2.js`，登录后加载的 ControlApp、db 等 15 个模块仍导入旧入口 `main-BRBMNbL1.js`。两个入口都执行 `createRoot(...).render(...)`，竞争同一个 `#root`，产生 `removeChild` / `insertBefore` 异常。完成引导的历史状态使后续打开直接走出错路径。

修复：把全部模块的入口引用统一到 `main-AccessRecovery20261028.js`，并在 `/assets/access-20261028-1/` 下发布完整配套资源。新资源返回 `Cache-Control: no-cache`，避开历史版本的长期缓存。账号和用户画布未作修改。

## 已完成验证

- 修复前：独立账号完成引导后白屏，刷新、重开标签页、直接进入 `/control` 均复现；`#root` 子节点变为 0，并捕获到上述 DOM 异常。
- 修复后：Chrome 和 Edge 均通过登录、完成引导、进入 Space、刷新、重开标签页、打开设置页、关闭浏览器进程后以同一独立持久化资料重启。每个阶段 `#root` 子节点为 1，脚本和请求错误均为 0。
- 服务健康检查 `/healthz` 返回正常。
- 测试账号已清理。
- Codex 内置浏览器能够连接并显示侧边栏，但读取页面和刷新命令持续超时，尚未完成其最终页面验证；微信未进行真机验证。

证据：`diagnostics/before-final-results.json`、`diagnostics/chrome-persistent-results.json`、`diagnostics/edge-persistent-results.json`，以及同目录截图。

## 服务器文件与后续 UI 修改

- 当前容器：`vivic-preview-20261027`，静态文件目录 `/app/apps/web/dist-online`。
- 修复前备份：`/opt/vivic-preview-20261025/releases/access-recovery-20261028/dist-before`。
- 修复后完整网页文件：`/opt/vivic-preview-20261025/releases/access-recovery-20261028/dist-fixed`。
- 变更清单：上述目录的 `repair-manifest.json`。
- 含修复的可恢复镜像：`vivic-preview-20261028:access-recovery`。
- 镜像 ID：`sha256:6051c26068b4332135dca3894d5f26e23d94b5c64661543f2279d35f2c0d20d2`。

后续 UI 更新必须保持 HTML 入口和所有模块引用一致，重新发布完整配套资源；不能只重命名入口脚本而遗留旧入口导入。

回退本次入口切换：将 `dist-before/index.html` 复制回当前容器的 `/app/apps/web/dist-online/index.html`。原资源均已保留。
