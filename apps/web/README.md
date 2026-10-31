# Vivic Web

React/Vite 前端，包含用户页 `/`、设置页 `/control`、展示 `/display`、本地演示 `/landing/` 和开发卡片预览。

从仓库根目录按 [贡献指南](../../CONTRIBUTING.md) 安装与启动。独立命令：

```sh
pnpm dev:web
pnpm --filter @vivic/web test
pnpm --filter @vivic/web typecheck
pnpm build
```

前端调用同源 `/api`，由 Vite 服务端代理到本机 API；凭据不能进入前端 bundle、浏览器 storage 或 Card。状态、布局、持久化和双窗同步在现有宿主中处理。

组件遵循根 [AGENTS.md](../../AGENTS.md)，功能说明见 [文档目录](../../docs/README.md)。伙伴任务的允许文件以 [任务单](../../docs/TEAM_TASKS.md) 为准，不因熟悉前端而自行修改其他模块。
