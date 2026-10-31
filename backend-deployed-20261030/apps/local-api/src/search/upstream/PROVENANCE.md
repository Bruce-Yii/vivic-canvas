# pi-web-access 安全子集来源

核实日期：2026-10-15。此目录是明确的代码级复用，不是已安装或运行完整 Pi / pi-web-access。

- 原项目：[nicobailon/pi-web-access](https://github.com/nicobailon/pi-web-access)。
- 核实的 npm `latest`：`pi-web-access@0.41.0`，[registry 元数据](https://registry.npmjs.org/pi-web-access/0.41.0)。
- 锁定源码 commit：`d47dc040552505e3b135d0136a0b15eaf4bdba52`。
- 原始文件：[exa.ts](https://github.com/nicobailon/pi-web-access/blob/d47dc040552505e3b135d0136a0b15eaf4bdba52/exa.ts)。
- 原文件 SHA-256：`325edb245623676dda5cb2aeab60daa3dd3aae445756201e79a4c285a6e6e9b0`，提取前已验证。
- 上游包 tarball SHA-1：`ee8167f963d6c81a474b2d4db7be3bf6c681402a`；没有安装该包。
- 许可：[上游 MIT LICENSE](https://github.com/nicobailon/pi-web-access/blob/d47dc040552505e3b135d0136a0b15eaf4bdba52/LICENSE)，完整版权和许可保留于相邻 `LICENSE.pi-web-access`，再分发须一并保留。

## 保留的实际实现

`exa.ts` 保留上游 `callExaMcp` 的 `tools/call` JSON-RPC 结构、固定 Exa 工具名、请求头、SSE `data:` / JSON 解码流程，以及 `parseMcpResults` 的 Title / URL / Text / Highlights 分块解析代码。文本解析函数仅增加 `export`；并非重新模拟另一个搜索引擎。

## 为 Vivic 修改的边界

- 仅允许 `web_search_exa`，固定 `https://mcp.exa.ai/mcp?tools=web_search_exa`；不能传 tool 名、provider、proxy、endpoint、includeContent。
- 原上游 `fetch` 换为 Vivic 自己的有界 HTTPS 传输；DNS 全部答案验证后固定到 socket lookup，搜索 endpoint 拒绝重定向。
- 2026-10-16：该固定 endpoint 可先经用户代理（`VIVIC_SEARCH_PROXY`/环境/系统代理，由服务端配置，调用方不能指定），同样受字节、类型、编码限制；代理失败再走上述固定 IP 直连。代理仅用于此固定 endpoint，`/fetch` 不使用。跨 provider 的回退在 Vivic `client.ts`，不来自上游。
- 超时由调用侧统一管理；字节上限适用于整个 RPC 响应；错误正文不回传、不记录。
- 检查 RPC 版本/id/content，检测实际观察到的 HTTP 200 + `_meta["ai.exa/rateLimited"]` 限流响应，不按成功处理。
- `client.ts` 从上游文本片段或 JSON highlights/text 生成 bounded snippet；不使用上游默认空 snippet 映射，不自动读取来源网页。
- 删除 config 文件、环境凭据、credential resolver（含命令型来源）、activity monitor、直接付费 API、advanced search 和自动 provider fallback；没有 Pi session、skills、extensions、OAuth。
- `/fetch` 是 Vivic 的独立 `raw-text` HTTPS 安全包装，不冒充上游 `extractContent`、Readability、Defuddle 或完整 `fetch_content` 的实现。

## 未直接安装完整包的依据

锁定版本的 `exa.ts` 本身导入 `node:fs` 和凭据配置解析；`extract.ts` 导入 GitHub、本地视频、PDF、cookie 和多 provider 提取链。独立 MCP 的 `createMcpServer(..., enabledTools)` 支持工具名称白名单，但完整 `WebToolCore.fetchContent` 仍具仓库克隆及本地资源分支，名称白名单不足以提供物理能力隔离。

本产品模块只包含两个固定查询方法，没有上游上述导入或通用工具执行器。Node 进程仍有宿主进程的 OS 权限；这里保证的是不存在对模型/HTTP 开放的文件或 shell 工具，并不声称实现了 OS sandbox。

审查依据：[mcp-server.ts](https://github.com/nicobailon/pi-web-access/blob/d47dc040552505e3b135d0136a0b15eaf4bdba52/mcp-server.ts)、[MCP schemas](https://github.com/nicobailon/pi-web-access/blob/d47dc040552505e3b135d0136a0b15eaf4bdba52/mcp-tool-definitions.ts)、[extract.ts](https://github.com/nicobailon/pi-web-access/blob/d47dc040552505e3b135d0136a0b15eaf4bdba52/extract.ts)、[ssrf-protection.ts](https://github.com/nicobailon/pi-web-access/blob/d47dc040552505e3b135d0136a0b15eaf4bdba52/ssrf-protection.ts)。
