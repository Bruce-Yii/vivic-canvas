# 连接模块：浏览器集成与白名单复核

日期：2026-10-24。全部使用隔离测试会话，未读取真实飞书/企微/钉钉账号，未使用真实麦当劳 Token，未向外部发送消息或下单。

## 真实代码链路、模拟数据边界

浏览器 → Vite online 17894 → Hono online 会话服务 17895 → createOnlineSessionApp → createApp → ConnectionManager → 真实 MCP JSON/SSE 协议处理。

仅 `fetchImpl` 的上游服务响应使用 fixture；产品连接 API、Cookie 会话、当前 StepFun 选择、规划/工具白名单、Schema 校验、owner、展示窗口同步和 IndexedDB 保存均真实运行。未放宽生产官方域名限制，也未拦截 `/api/connections`。

配置：`apps/web/playwright.connections.config.ts`。
运行器：`apps/local-api/tests/fixtures/connections-browser-server.ts`。
场景：`apps/web/tests/connections/connections.spec.ts`。

## 结果

- 2 个完整浏览器场景通过。
- 飞书：界面填写模拟授权 → 测试成功且输入清空 → 自然语言查询 → 当前 StepFun fixture 规划 → MCP 查资料 → 来源和时间 → 用户点击保存 → 展示页同一张卡 → owner 重载后同一 ID → 再次查询 → 切新 Space 后旧结果消失且新 Space 无卡 → 切回原 Space 仍只有一张 → 越权模型工具被拒绝 → 重新测试 → 断开 → 新 Cookie 会话无连接。
- 麦当劳：界面配置模拟授权 → 仅展示已审核活动日历工具（自动领券不可见）→ 自然语言查询 → 显示明确 fixture 结果 → 保存带麦当劳 service 来源的卡片。
- 不采集麦克风/摄像头，不播放音频，不录制请求 trace。只有显式 `TEST-FIXTURE` 字符串进入测试凭据输入，浏览器 local/sessionStorage 均无凭据。
- 初轮飞书场景仅第二个 context 的会话启动等待不足；加上真实新手引导可见的等待后，两场景均通过。其他产品断言未放宽。
- 测试服务 17894/17895 已退出。

截图位于 `.cache/connections-browser-20261024/`：`01-fixture-natural-query.png`、`02-fixture-card-in-space.png`、`03-fixture-mcd-calendar.png`，均经人工图像检查。

## 钉钉独立审计修复

审计发现未知工具即使名为 `getAndPayOrder` / `queryThenRedeemCoupon`，也可能伪造只读注解。已彻底删除名称启发式。

只允许官方 DWS `52f38a4a6997da07fd9159fa643d313ca9b83409` 的 `internal/helpers/doc.go` 明确标记 `Effect: read / Risk: low` 的四项：

| RPC | 读取含义 | 参数边界 |
| --- | --- | --- |
| search_documents | 文档搜索 | 关键词、类型、时间、关联人/空间筛选及有限分页 |
| list_nodes | 直接子节点目录 | 文件夹/空间及有限分页 |
| get_document_info | 文档元信息 | nodeId |
| get_document_content | 文档正文 | nodeId、格式、历史版本及有限范围选择 |

每个远端参数名/类型还必须符合已审阅目录；发现新操作字段、类型漂移或未知工具即不开放。客户端本地 Schema 强制 additionalProperties:false；不支持公开文档密码参数。远端只读注解不能扩大权限，显式破坏性注解会缩小权限。

定向 API 测试最终 31/31，通过虚假注解、未知 RPC、写参数、Schema 漂移、断开取消和模型越权等检查。UI 定向 9/9，API/Web 类型检查及连接代码 lint 通过。

仍需真实个人授权后验收账号数据。MCP 网络可达/fixture 通过不等于外部账号查询通过。
