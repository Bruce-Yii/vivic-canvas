# Pi GPT 迁移来源

固定依赖 `@earendil-works/pi-ai@1.2.0`、`@earendil-works/pi-coding-agent@1.2.0`，均 MIT。

- Pi 原仓库：[earendil-works/pi](https://github.com/earendil-works/pi)，核查提交 `9a3ca68bda4db67efc506ec114bffe64635e8569`。实际登录、PKCE/state/回调、token exchange/refresh、模型传输由发行包实现；Vivic 不重写 OAuth 协议。
- 仅创建 `Models` 且注册 `openai` / `openai-codex` 两个 GPT provider。没有 `createAgentSession`、coding tools、extensions、skills、MCP dispatcher 或主机模型配置加载。coding-agent 仅使用其 `AuthStorage` 来遵循已有 Pi 的并发锁和凭据存储；API key/命令配置不进入认证解析。
- 新登录调用上游 `openai` 的 Sign in with ChatGPT；旧 Pi OAuth 根据原 provider 走 legacy Codex，凭据与地址不混用。复用 Pi 时在原认证存储中刷新，避免复制 refresh token 后破坏 CLI；断开 Vivic 不注销 Pi。Vivic 自有登录存储在 `~/.vivic/auth.json`（上游 0600/0700），设备标识独立持久化。
- 搜索调用与 citation 提取迁移自 [pi-web-access@0.41.0/openai-search.ts](https://github.com/nicobailon/pi-web-access/blob/d47dc040552505e3b135d0136a0b15eaf4bdba52/openai-search.ts)，`search-extract.ts` 的 `cleanSourceUrl` 到 `extractSearchResults` 保留上游代码，仅增加本地类型和 export。MIT 全文保留于 `../search/upstream/LICENSE.pi-web-access`，再分发须保留。
- Vivic 限定官方端点、不跟随凭据跳转、限制响应/超时、读取 completed 事件、校验 ActionEnvelope；模型回复无工具执行通道。搜索 snippet 可以是带引用的模型回答附近文本，不能当作原网页逐字摘录或全文已读。

集成协议基线：[新 OAuth 推理](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)、[能力限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)。认证必须由用户明确发起。2026-10-16 用户已通过现有 Pi 流程完成新授权，观察到 `source:vivic / phase:connected`，其后真实推理、订阅搜索和图片已验证；见 [本地验收记录](../../../../docs/archive/2026-10/manual-feedback-20261016.md)。旧 Pi 复用记录仍保留在 evidence/phase3-gpt、phase3-live-browser，不将其冒称新登录。安装不代表任意账号权限可用；本次没有开发服务器多用户 OAuth 协议。
