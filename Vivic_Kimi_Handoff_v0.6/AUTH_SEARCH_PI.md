# Vivic v0.6 — Pi、认证、零额外 Search Key 专项设计

## 1. 目标与非目标

2026-10-15 用户更新：只保留 StepFun Coding Plan / GPT 两种 LLM 连接，其他模型登录暂缓；GPT 复用 Pi 既有 OAuth，不自建登录协议。当前 Pi 已区分新 `openai` ChatGPT 登录与 legacy `openai-codex`，迁移前需固定真实版本并正确绑定凭据与端点。StepFun 官方 StepSearch 可以使用同一 Plan Key，应优先于 Exa 备选验证；STT/TTS 独立于 LLM。详见 [本轮架构核查](../docs/provider-voice-architecture.md)，本文后续「Claude 等」不再属于当前开发范围。

用户希望：**连接自己的 StepFun API Key，或个人登录已支持的 GPT/Codex、Claude 等服务，然后直接让 Vivic 查询网络资料；理想情况下不必额外注册搜索 API、填第二把 Key。**

这不是要做 Coding Agent，也不是承诺“所有订阅都可当 API 使用”。Pi 是 SDK/Auth/受限查询能力载体。

## 2. 经过文档验证的事实（仍须在实际版本 PoC）

- Pi `@mariozechner/pi-coding-agent` SDK 支持 `createAgentSession`、`AuthStorage`、`ModelRegistry` 等，并允许设置工具；其传统 CLI **默认提供文件读写和 bash**，Vivic 必须禁止。
- Pi 的 `/login` 可连接其当前支持的部分 OAuth/订阅模型，具体范围随版本/提供商政策变化；Codex 不等于通用 OpenAI Platform API。
- `nicobailon/pi-web-access` 是 Pi 扩展，可提供 `web_search` 与 `fetch_content`；自述默认无搜索 API Key 可通过 Exa MCP 查询，在有 Pi Codex 合适 auth 的情况下可尝试复用 OpenAI 搜索。
- `pi-web-access` 还提供独立 MCP tool server：`web_search/fetch_content/get_search_content/source_check`，但此模式**不能自动复用** Pi 特有的 Codex subscription search 或 Pi 交互环境的摘要/模型功能。
- Zero Config 是“**不向 Vivic 用户索取额外搜索 Key**”，并非无联网依赖或承诺永久免费、任何地区都可用。其上游提供方可能有限额、变更或要求额外授权。

## 3. 连接 UI（个人版）

- 设置页：「模型」 StepFun / 实验性 Pi 登录，明确当前 provider 能力：`chat`, `structured`, `vision`, `search`。
- 「搜索连接」：自动检测 `keyless-exa`, `codex-auth-search` 等可用后端，绿色状态只能在实际请求成功后展示；可重试，无必要隐藏具体失败原因。
- 不出现“你必须再填 Search API Key”作为默认流程；可选高级页面允许未来用户自带 Key。
- 用户断开 Pi OAuth / StepFun Key 后，不允许无意继续调用缓存的凭据；连接状态应立即更新。

## 4. 集成路径建议

**先做两项独立 PoC：**

**PoC A：Pi Extension 模式（首选）**

1. 固定当前已测试的 Pi 与 pi-web-access 版本，不自动加载用户 `~/.pi` 的其他扩展、skills 和默认 coding tools。
2. 显式设置 `tools: []`（以当时 SDK API 实测），只暴露 `VivicWebSearch` / `VivicWebFetch` 两个安全 wrapper；wrapper 再经审查调用 `pi-web-access`。
3. 无搜索 Key 时执行 `web_search({query:'React Flow React canvas library'})`，验证是否真正取得可引用来源及 URL。
4. 个人已登录 Pi Codex 条件满足时重复测试，验证认证是否正确复用；区分因额外服务/配额而成功的情况。
5. `fetch_content` 必须在请求进入实际工具前按 URL 和主机逐步验证，屏蔽 local path/Git clone/raw arbitrary fetch 等功能。

**PoC B：pi-web-access Standalone MCP（降级备选）**

- 优点：不用启动完整 Pi Session；暴露四个查询工具，适合受限工具进程。
- 缺点：Pi 专有登录模型查询（如 Codex auth-backed search）在此模式不自动可用；实际默认 keyless backend 也需要联网服务正常。
- 不能直接信任完整 tools 列表，Vivic 仍需严格代理/过滤输入输出；子进程的文件和网络权限须限制。

## 5. 用户请求序列

```text
User: 查找 3 个用于无限画布的开源库
  -> Winnow: SEARCH_COMPARE, confidence 0.93 (示例值，非实际模型跑分)
  -> PiWebSearch: query + maxResults=5
  -> PiWebFetch: 选择 2-3 个可信来源（可选）
  -> SourceEvidence: title/url/provider/fetchedAt/readFullPage
  -> StepFun/Pi selected LLM: summarize compactly and select SearchResultCard/TableCard
  -> Action Schema validation
  -> Canvas reducer + sync
  -> Voice: "找到三个，第二个比较适合。"
  -> Motion Director: highlight item 2
```

搜索失败时：语音/短字幕「现在连不上资料源」，不得基于模型常识制造带“刚查到”标签的假卡片。

## 6. 认证和计费边界

- **StepFun Key**：设置页粘贴、测试连接，Key 仅进本机可信后端；默认本次启动内存保存，非秘密配置可记住。
- **Pi OAuth**：初版可先使用个人本机已经通过 Pi 官方流程登录的身份，读取其服务端认证状态；若不能安全地与浏览器集成，则不虚构“一键登录”。真实 GUI Login PoC 通过后才添加按钮。
- **ChatGPT/Codex**：不得把 ChatGPT 订阅当作任意 GPT API；个人适配与商业转售/会员化授权边界不同。
- **Claude**：订阅模式能否在第三方 harness 中使用、配额与额外计费，依当前官方服务条款及 Pi 项目文档确认。
- **会员系统**：未来独立项目，不能凭个人 OAuth 实验版推断允许商业化。

## 7. 安全 checklist

- [ ] 后端只绑定本机 loopback、只允许受控 origin、具本地 session/CSRF 验证。
- [ ] Provider credentials 绝不进入 Display、IndexedDB、localStorage、prompt、日志或导出文件。
- [ ] Pi SDK 没有任何文件/终端工具，资源/扩展载入白名单可审计。
- [ ] `web_search` 限制参数、次数、频率与超时。
- [ ] `web_fetch` 禁止本地路径、`file://`、localhost、内网 IP、恶意重定向、巨大文件和不受控协议。
- [ ] 已抓取的文本作为不可信材料处理，不能指挥 Vivic 安装/执行东西。
- [ ] 显示内容保留来源 URL、抓取时间，区分搜索摘要与已读取正文。
- [ ] 无 Key 情况真的能查询成功，失败时不会伪报已连接。

## 8. 文档及核查链接

- Pi: https://github.com/badlogic/pi-mono
- Pi SDK: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md
- Pi Provider: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/providers.md
- Pi Web Access: https://github.com/nicobailon/pi-web-access
- Pi Web Access README（确认 Extension 与 MCP 差异）: https://github.com/nicobailon/pi-web-access/blob/main/README.md

**实现前必须记录 package 版本、LICENSE、官方支持策略，以及执行成功的真实响应与来源；不能把本文件的研究结论当作已经在用户机器上可用。**
