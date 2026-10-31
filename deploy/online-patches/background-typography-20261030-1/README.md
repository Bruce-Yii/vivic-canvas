# 背景设置字体统一

版本：`background-typography-20261030-1`。

将设置 → 偏好 → 背景展开后的「浅色」「深色」「浅色/深色自选配色」和四个颜色字段标签，统一为相邻「空间光效」中「流动速度」「光晕强度」的字体样式：`var(--hark-font)`、400 字重、13px 字号、19px 行高，文字颜色为 `var(--hark-ink)`，自动随深浅色主题变化。

只新增局部 CSS 和 HTML 样式引用；当前启动入口、React 运行模块、卡片、背景动效、配色及其账号级存储逻辑均保持原有实现。

## 验证

- 候选验证与线上验证分别保存在 `candidate-verification.json`、`live-verification.json`；检查桌面和 390px 手机宽度、浅深色主题、13 个配色选项和全部 7 个字段标签的计算字体。
- 配色选择、自选开关、HEX 修改、刷新与带登录历史重开使用隔离模拟账号接口；静态资源在候选时仅替换 HTML/CSS，线上验收不替换任何静态资源。
- 没有创建生产账号，也没有操作真实用户画布、数据库、模型 Key 或服务凭据。

## 发布与回退

新完整前端目录使用硬链接复用未改动资源，HTML 用临时文件原子替换，新 CSS 使用独立版本路径。发布前校验 `frontend-current`、主页 SHA-256 和 Nginx 配置，任何并行变更都要求重新取得基线。保留原安全响应头及 API 代理配置，只更新静态资源的版本头 include 路径。

`publication.json` 记录本次版本和 `previous`。回退时先校验当前指针确实仍属于本版本，再将 `frontend-current` 原子切回记录的 `previous`，将 `nginx-before.conf` 原子恢复至 `/etc/nginx/conf.d/60-vivic-preview-20261025.conf`，执行 `nginx -t` 后 `nginx -s reload`。不重启后端。

保留 `patch/` 和本说明供每天同步到 GitHub `ECdison6227/vivic-canvas` 的 `deploy/online-patches/`。旧发布目录没有在本次任务中删除，待维护者完成 Git 归档后处理。
