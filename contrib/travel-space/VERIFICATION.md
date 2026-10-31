# Travel Vivic Space 验证

2026-10-22。仅验证独立旅行 DEMO；无真实模型、飞猪查询、预订、密钥、麦克风或物理音频。

| 检查 | 结果 |
| --- | --- |
| 独立 TypeScript strict 检查 | 通过 |
| 独立 production Vite build | 通过；输出在本目录 dist，不覆盖主产品 |
| oxlint（本目录源码/服务/打包器） | 通过 |
| 旅行逻辑 Vitest | 6/6 通过 |
| Node 服务边界 | 4/4 通过 |
| 隔离 Playwright 生产包浏览器验证 | 4/4 通过，40.3 秒；单 worker、5196 静态服务、独立 context |

逻辑覆盖：DEMO 声明、无价格/库存/预订链接；拒绝模式/来源/服务字段篡改；用户编辑与收藏；同目的地重规划保留有效状态；空结果清选择；取消和错误不产生部分卡；输入边界和预算算术；独立保存 key、损坏数据与配额失败。

服务覆盖：capabilities 如实返回 liveEnabled=false；跨源 POST 拒绝；独立 HttpOnly SameSite cookie；未登录查询 401；有效 cookie 也返回 live 未配置 503；固定零上游预算；限流与会话容量上限；路径/隐藏文件拒绝；不接受查询体。

浏览器实测：生成 → 编辑 → 收藏 → 比较 → 预算变更 → 刷新恢复；独立浏览器无旧计划；取消/失败保留原数据；空结果后恢复；12 配色；390px 窄屏无横向溢出；导出与仅清理独立空间。生成/编辑流程没有 pageerror。已实际查看 `test-results/visual/desktop-light.png`、`desktop-dark.png`、`mobile-light.png`、`mobile-dark.png`，未发现遮挡或截断；运行证据不入 Git。根路径生产包浏览器验收后，最终产物按 `/travel-vivic/` 重新构建供静态部署，公开域名端到端由负责人验证。

正式发布前的未完成项：部署到实际分享域名后验证 HTTPS/CDN 路径；负责人执行 GitHub 提交和比赛提交（本轮均未自动执行）；专用 Key 的官方 MCP wire/真实响应映射与额度控制验收。当前产物可作为公开静态 DEMO，不构成 live 接入完成证明。
