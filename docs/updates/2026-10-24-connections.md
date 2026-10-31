# 2026-10-24 应用与生活服务连接

本轮在 Hark 小设置面板加入飞书、麦当劳、企业微信、钉钉的连接配置、测试与断开，以及聊天页「查询资料」。所有连接凭据仅在当前服务会话的内存中保留；在线 Cookie 会话各自创建 ConnectionManager，不读取开发者电脑上已登录的账户。

## 产品流程

1. 设置 → 连接 → 应用与生活服务，填写本人授权信息并测试。
2. 聊天页 → 查询资料，选来源并说「找一下杭州旅行计划」「这个月有什么活动」。
3. 当前已连接的 StepFun/GPT 只规划一次只读查询；工具与参数通过服务端白名单/Schema 验证后，实际调用该平台。缺少文档链接等信息会澄清，不编造编号。
4. 显示实际返回正文、来源、查询时间；可再次查询或保存到 Space。
5. 保存为现有 NoteCard，预览最多 500 字、完整资料最多 24,000 字保存于 sourceData.connectedSource，来源使用 service evidence，不冒充网页全文。只有 host.flush 确认后显示「已加入 Space」，保存重试使用同一 requestId 防止重复卡片。

指定查询内容放在折叠项中，允许不调用 LLM、按服务真实 inputSchema 填写参数。

## 已接入的实际适配

| 服务 | 接入方式 | 当前只读范围 | 用户/部署需要提供 |
| --- | --- | --- | --- |
| 飞书 | 官方开发者远程 MCP | 文档搜索/阅读/目录/评论与人员搜索，具体按授权发现 | 本人的 UAT，所用文档与通讯录的只读权限 |
| 飞书 | 官方 Lark CLI | 文档搜索、docx/Wiki 阅读 | App ID + 本人的 UAT；服务主机安装官方 CLI |
| 麦当劳 | 官方 Streamable HTTP MCP | 活动日历、优惠信息、营养、门店、餐品、已有订单等查询 | 麦当劳 MCP 控制台的个人 Token |
| 企业微信 | 官方 WeCom CLI | 文档搜索、在线 doc 阅读 | 本人的访问 Token；服务主机安装官方 CLI |
| 钉钉 | 官方网关个人 Streamable HTTP MCP | 已审阅的文档搜索、目录、元信息与正文四个精确 RPC；未知工具不可用 | 本人从官方平台生成的服务地址；仅 mcp-gw.dingtalk.com |

飞书个人托管 MCP 链接已进入弃用过渡；此处使用仍有官方开发者文档的 UAT 远程接口，同时提供 Lark CLI 模式。没有冒充已实现 OAuth 引导、自动刷新 Token 或凭据长期持久化。Token 失效时需在设置重新授权。

## 执行与数据边界

- 无下单、支付、领券、创建/删除外部文档、发送消息工具。只读注解本身不能让麦当劳写操作进入白名单。
- 钉钉限定 `search_documents`、`list_nodes`、`get_document_info`、`get_document_content`，依据官方 DWS `52f38a4a6997da07fd9159fa643d313ca9b83409` 的 `internal/helpers/doc.go` 静态读操作契约。另验证并收紧参数字段/类型，禁止远端扩充操作参数；名称启发式及 `readOnlyHint` 均不能扩大权限。
- MCP 只允许固定官方 HTTPS 主机，禁止重定向、URL 用户名密码、非标准端口及片段；请求 30 秒限时、响应最多 256 KiB、工具目录分页有上限。
- MCP 支持 JSON 及 SSE 形式的 Streamable HTTP、initialize/initialized、会话头、tools/list/call；输入 Schema 使用有深度与大小限制的子集，不支持远程引用或远程正则表达式，遇到不支持的参数契约会明确拒绝。
- CLI 只启动已安装的原生可执行文件、固定只读 argv，不经 shell，不接受模型生成命令。使用独立临时 HOME/配置目录和明确传入的用户令牌，不继承宿主账号、代理鉴权、附加请求头或认证缓存。临时目录在结束后清理。
- 拒绝模型选择的未列出工具、写工具和非法参数。目录描述只作为资料。连接断开、会话注销、应用关闭会取消在途查询；旧查询结果不能在新连接下作为成功返回。
- 响应及异常不回传凭据、个人 MCP 地址或底层堆栈。查询正文为不可信来源资料，不能当成系统指令。
- 当前是查询面板驱动的一次工具调用。搜索后读具体文档需要再次查询，不宣称自动执行任意多步 MCP 工作流。

## 验证记录

- 连接 API 单元/集成测试 31 项通过，包括真实在线会话路由的 A/B 隔离、CSRF、凭据隐藏、JSON/SSE、读工具门控、参数验证、取消、模型越权计划拒绝、应用内 StepFun 规划接线、钉钉虚假只读注解及 Schema 漂移拒绝。
- 连接界面与设置兼容测试 9 项通过，包括自然语言提问、工具查询、用户点击才建卡、保存失败、关闭清除输入凭据。
- API/Web 类型检查通过；连接代码无新增依赖，定向 lint 无警告。
- 实际 Chromium 集成 2/2 通过：Vite 17894 与真实 online handler/createApp 17895，仅注入上游 fixture，不拦截产品 `/api/connections`。飞书覆盖配置/测试/自然语言/来源/建卡/展示页/保存重载/切换 Space 丢弃旧结果/写工具拒绝/断开/隔离 Cookie；麦当劳覆盖真实 MCP 协议 fixture 的活动日历与读工具过滤。截图已检查，位于 `.cache/connections-browser-20261024`，均明确标注 TEST FIXTURE。测试服务结束后已停止。
- 无凭据实测：Lark CLI 1.0.97 与 WeCom CLI 1.3.4 在隔离环境运行版本命令均 exit 0；飞书远程端点返回 HTTP 401、麦当劳端点 HTTP 403，说明可达且要求授权。脚本 `.cache/check-connection-capabilities.ts`。
- 本轮没有这些服务的产品用户令牌，因此账号真实文档查询、麦当劳实际结果和钉钉实际目录尚未验收；fixture 测试不等于在线账号测试。

## 官方参考

- [飞书开发者远程 MCP](https://open.feishu.cn/document/mcp_open_tools/developers-call-remote-mcp-server)
- [Lark CLI 嵌入应用及显式凭据](https://open.larksuite.com/document/mcp_open_tools/feishu-cli/embed-feishu-cli-in-agent)
- [官方 Lark CLI](https://github.com/larksuite/cli)
- [麦当劳官方 MCP 配置及工具清单](https://github.com/M-China/mcd-mcp-server/blob/main/README.md)
- [WeCom CLI 环境及认证契约](https://github.com/WecomTeam/wecom-cli/blob/main/docs/cli-reference.md)
- [钉钉应用中心](https://aihub.dingtalk.com/)
- [官方钉钉 Workspace CLI](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli)

本次比赛为飞猪 AI 旅行创新大赛，飞书是办公资料连接之一。以上接入不会把现有飞猪 DEMO 宣称为真实飞猪 MCP。
