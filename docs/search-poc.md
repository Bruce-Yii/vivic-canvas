# P2 搜索 PoC：Exa 历史受阻记录

最新范围补充：本报告保留 Exa 子集的历史失败证据；StepFun 官方同一 Plan Key 的 StepSearch 已另行开发，最新事实见 [模型与语音核查](provider-voice-architecture.md) 及 [StepSearch 验证](../evidence/phase2-stepsearch/REPORT.md)。GPT OAuth 已恢复为待迁移，其他 OAuth 暂缓；本文旧范围描述不再代表最新计划。

核验时间：2026-10-15，Asia/Shanghai。范围：真实 `pi-web-access` Exa keyless 搜索协议及公开网页安全读取。没有读取 `.env`、任何 Key 或 Pi 登录存储；没有启动/停止服务，没有运行 Web E2E。

**结果：实现、接口和自动化安全检查已完成；“真实搜索返回 title/url/snippet 来源”和成功读取公网正文尚未通过，不能宣称 P2 搜索验收完成。** 外部协议探测实际收到 Exa 免费额度限流；正式安全路径又被本机 DNS 的 `198.18.0.x` 答案阻断。没有伪造结果、强制索取 searchKey、切换其他搜索引擎，或放宽 SSRF 策略。

## 采用的实际上游及许可

已读取交接包 `README_FIRST / AGENTS / PRD / ARCHITECTURE / AUTH_SEARCH_PI / COMPONENT_LOCK`。按用户最新指令，只保留 StepFun LLM/TTS/STT 的整体产品方向，其他模型和 OAuth 暂缓；Exa 是独立搜索来源，不是新增 LLM 或 OAuth 集成。

2026-10-15 通过原仓库和 npm registry 核实 `pi-web-access@0.41.0`，MIT，锁定源码 commit `d47dc040552505e3b135d0136a0b15eaf4bdba52`。实际复用其 `exa.ts` 中 `callExaMcp` 的请求结构/SSE 和 JSON 解码，以及 `parseMcpResults` 的来源分块解析。源码 SHA-256、精确改动及 MIT 全文见 [PROVENANCE](../apps/local-api/src/search/upstream/PROVENANCE.md) 和 [LICENSE](../apps/local-api/src/search/upstream/LICENSE.pi-web-access)。

不是安装完整包后的模仿，也不冒充完整 Pi runtime 或完整 pi-web-access standalone server。没有新增依赖；没有修改 package.json / lockfile。

之所以使用用户允许的**代码级安全子集**：完整扩展和独立 MCP 的公共核心都包含广泛网页/仓库/PDF/视频/配置能力，单纯过滤两个工具名不足以排除文件/命令分支。当前模块没有导入 Pi、upstream `WebToolCore`、`extractContent`、credential resolver、`node:fs`、shell/child_process、宿主 skills/extensions、浏览器 cookies 或自动 provider 回退。运行时没有 read/write/edit/bash/gitclone 工具、通用工具执行器或 agent loop。这里是 API 能力隔离，不是 Node 进程的 OS sandbox。

原始来源：

- [上游锁定 package.json](https://github.com/nicobailon/pi-web-access/blob/d47dc040552505e3b135d0136a0b15eaf4bdba52/package.json)、[npm registry](https://registry.npmjs.org/pi-web-access/0.41.0)。
- [上游 exa.ts](https://github.com/nicobailon/pi-web-access/blob/d47dc040552505e3b135d0136a0b15eaf4bdba52/exa.ts)、[MIT 许可](https://github.com/nicobailon/pi-web-access/blob/d47dc040552505e3b135d0136a0b15eaf4bdba52/LICENSE)。
- [独立 MCP server](https://github.com/nicobailon/pi-web-access/blob/d47dc040552505e3b135d0136a0b15eaf4bdba52/mcp-server.ts)、[MCP tool schemas](https://github.com/nicobailon/pi-web-access/blob/d47dc040552505e3b135d0136a0b15eaf4bdba52/mcp-tool-definitions.ts)、[完整 extract 路径](https://github.com/nicobailon/pi-web-access/blob/d47dc040552505e3b135d0136a0b15eaf4bdba52/extract.ts)。
- [Exa 官方 MCP 文档](https://exa.ai/docs/get-started/exa-mcp)：当前支持无登录、无 API Key 的受限额度模式；显式 `tools` 列表替换默认列表。当前仅启用 `web_search_exa`，不启用 `agent_run`、远端页面读取或其他 MCP 工具。

## 主线程可用接口

从 `apps/local-api/src/search/index.ts` 导入：

```ts
import { createSearchRoutes, createSearchClient } from './search/index.js';

// 每个服务实例只创建一次，HTTP routes 与意图链路共享并发/频率额度。
const search = createSearchClient();
// 必须位于现有 bearer / CORS / bodyLimit 中间件之后。
app.route('/api', createSearchRoutes({ client: search }));

// 后端意图链路可注入 webSearch: search.webSearch（不需要 bind）。
// 不会启动服务、读取配置或加载 Pi。
const results = await search.webSearch(query, abortSignal);
const page = await search.fetchContent(httpsUrl, abortSignal);
```

两种工厂都接受 `{ config?: Partial<SearchConfig> }`，routes 另支持 `{ client: SearchClient }` 注入；使用注入时配置必须在创建 client 时设置，routes 不能同时再传 config。与现有 `LocalApiConfig` 分开，不要求修改 config.ts。可配置项见后文。`webSearch` / `fetchContent` 返回 Promise；失败抛出 `SearchError`（`code / status / message`），类型和错误类均从 index.ts 导出。HTTP 包装只返回安全错误文案，不回传上游错误正文。无注入时 `createSearchRoutes()` 仍可独立使用。

`POST /api/search` 仅接受 JSON `{ query: string }`，去首尾空白后 1–500 字符，拒绝未知字段：

```ts
// 成功响应类型；不是本次真实搜索的成功证据。
{
  ok: true,
  results: Array<{
    title: string;
    url: string;
    snippet: string;
    fetchedAt: string; // ISO timestamp
    provider: 'pi-web-access/exa-mcp-keyless';
    readFullPage: false;
  }>;
}
```

搜索只发送查询和固定数量参数，不自动抓取结果页。snippet 来自上游 Text / Highlights 或 JSON text / highlights，最长 700 字符；title 最长 300 字符。过滤明显不安全来源 URL、去重，不声称已读取来源网页。引用 URL 的 DNS 只会在显式 fetch 时校验，搜索结果本身不是页面安全/真实性认证。

`POST /api/fetch` 仅接受 JSON `{ url: string }`。成功返回 `{ ok:true, url, text, contentType, format:'raw-text', fetchedAt, provider:'vivic-bounded-https', readFullPage:false, truncated, trust:'untrusted-web-data' }`。这是本模块独立的有界 HTTPS 原始文本读取，不是上游完整内容提取器；HTML 保持为 JSON 中的惰性文本，禁止调用方 `innerHTML` 渲染、执行脚本或将其作为 system/developer instructions。后续 StepFun 总结必须作为明确分隔的非可信资料传入。原始 HTML 包括脚本/样式文本，尚无 Readability/Markdown 提取。

失败：`{ ok:false, code, error }`，不附 results。HTTP 400 输入/目标被拒，413 体积超限，415 类型不支持，429 本地并发/频率或远端免费额度受限，502 上游/格式/连接错误，503 固定搜索源 DNS 未通过公网校验或调用取消，504 总超时。

**挂载边界回归已覆盖：** 全部 middleware（响应头、4KB bodyLimit、JSON content-type）只绑定 `/search` 和 `/fetch`；无 `use('*')`。父 Hono 在挂载后注册的无关 `GET /api/providers/status` 和携带 8KB 音频的 multipart `POST /api/transcribe` 均正常通过，不被误施加 415/413 或搜索响应头。另有回归验证直接意图调用和注入该 client 的两个 HTTP 路由共享同一额度。

## 实际网络证据（不含 secrets）

执行环境：Node `v26.10.0`、pnpm `12.11.2`。本次 workspace 没有 `.git`，文件以限定写范围交付。

### 1. 真实上游 MCP 协议探测

UTC `2026-10-15T06:26:13.918Z`（上海 14:26:13），使用 Node 原生 HTTPS 向上游原始代码相同的公开 endpoint 发出真实请求。此为实现前的协议诊断，尚未使用产品的 SSRF 包装，不能据此宣称安全路径成功。

```json
{
  "endpoint": "https://mcp.exa.ai/mcp?tools=web_search_exa",
  "method": "tools/call",
  "tool": "web_search_exa",
  "arguments": { "query": "React Flow React canvas library", "numResults": 3 },
  "httpStatus": 200,
  "contentType": "text/event-stream",
  "resultMeta": { "ai.exa/rateLimited": true },
  "outcome": "BLOCKED: keyless free quota"
}
```

原响应明示免费 MCP 额度受限，未返回 title/url/snippet。上游还提供了注册 API Key 的建议；产品不会转发该要求，也不会自动使用环境 Key。实现额外识别这种 **HTTP 200、没有 isError 的额度失败**，规范化为 429，不显示“已连接”。

### 2. 产品安全路径真实诊断

使用 `createSearchRoutes().request()` 发起真实网络操作，无 mocks、无 HTTP listen、无凭据。2026-10-15 14:35（上海）的结果：

| 探测 | 实际结果 | 证据边界 |
|---|---|---|
| 搜索 `React Flow React canvas library` | 503 `search-unavailable`，DNS 未通过公网校验，约 271ms | 未建立搜索 socket、无结果 |
| `https://example.com/` | 400 `search-blocked-url` | 公网域名被本机 DNS 解析为保留地址 |
| `https://127.0.0.1/` | 400 `search-blocked-url` | 字面 IP 在联网前拒绝 |
| `https://127.0.0.1.nip.io/` | 400 `search-blocked-url` | 真实 DNS 后拒绝 |
| httpbingo 指向 loopback 的 redirect | 400 `search-blocked-url` | 首跳已被 DNS 阻断，**未验证真实远端重定向跳转** |
| example.com，64-byte cap | 400 `search-blocked-url` | DNS 提前拒绝，**未验证真实网络正文的大小拦截** |
| example.com，1ms deadline | 504 `search-timeout`，约 5ms | 在真实 DNS 阶段总超时，**未验证正文慢流超时** |

独立调用 Node `dns.lookup(...,{all:true})` 和 `dns.resolve4`，真实返回：

```text
mcp.exa.ai  -> 198.18.0.187
example.com -> 198.18.0.188
httpbingo.org -> 198.18.0.189
```

这些是 `198.18.0.0/15` 保留范围，可能来自 TUN/fake-IP 网络环境；这里仅根据观测推断原因，未读取代理配置。没有为该范围设置 allowlist、trustEnvProxy 或其他例外，也没有修改 DNS/网络设置。

**因此真实 title/url/snippet 成功证据为空；成功抓取公网正文也为空。** 需要外部网络返回可验证的公网 DNS 地址，并且 Exa keyless 额度可用后，重跑下述诊断。无需先添加 searchKey。当前不得对外宣称联网查询已可用。

## 安全边界及默认限额

| 项目 | 实现 |
|---|---|
| 工具 | 仅 web_search / fetch_content 对应方法；无任意工具名入口 |
| 输入 | 严格 JSON 字段；两个路由各自 4KB bodyLimit（含无 Content-Length 的流） |
| URL | 仅 HTTPS / 443，最长 2048；禁止凭据、控制字符、本地路径、危险协议、本地域名及私网/保留 IP |
| DNS | 每一跳查询全部地址，任一私网/保留答案即拒绝；IPv4/IPv6、mapped IPv4、NAT64/transition 均保守校验 |
| 连接 | HTTPS request `lookup` 固定已验证地址和 family，保留原 host/TLS 校验；不再解析；`agent:false` 不复用连接，不继承全局 proxy agent |
| Redirect | fetch 手动最多 3 跳，含同域跳转重新校验 DNS；不携带 cookie/auth。搜索固定 endpoint 不跟随跳转 |
| 响应 | 默认 256KiB、最大可配 512KiB；Content-Length 和逐 chunk 双重限制；headers 16KiB |
| 类型 | fetch 仅 text/plain、text/markdown、text/html、application/xhtml+xml；搜索仅 JSON/SSE；拒绝压缩和二进制，不解压、不取嵌入资源 |
| 时间 | 搜索 20s、fetch 12s，覆盖 DNS/连接/正文/全部跳转；两者最大可配 30s；支持调用方 AbortSignal |
| 并发/频率 | 每个 client 默认共用 2 并发、每分钟 10 次；最大可配 4 并发/30 次，无后台排队或重试风暴 |
| 文本 | 默认最多 20000 UTF-16 code units，最多可配 30000；不完整时 truncated；一直 readFullPage:false |
| 敏感性 | 不读取宿主凭据或配置，无产品日志，无缓存；不返回服务异常原文；不可信资料无指令/执行权限 |

Config 字段：`timeoutMs / fetchTimeoutMs / maxResults / maxResponseBytes / maxTextChars / maxConcurrent / requestsPerMinute`，服务初始化时 Zod 校验，HTTP 请求不能覆盖。没有 SSRF 放行范围或代理豁免设置。

Node 的 `dns.lookup` 无原生取消，但封装在 deadline/AbortSignal 下；超时后不再打开 socket，迟到的 DNS 结果被丢弃。当前一次只连接一个已验证地址；多地址自动故障转移未实现。文本按 UTF-8 解码，其他 charset 尚未提供转换。

传输行为核对：[Node HTTP agent:false / proxyEnv](https://nodejs.org/api/http.html)、[HTTPS request](https://nodejs.org/api/https.html)、[Net address families](https://nodejs.org/api/net.html)。

## 测试与重现

普通 API 单测没有外部网络请求，live diagnostics 默认跳过：

最终核验：API 全量 **388 passed / 2 live skipped**（12 个测试文件通过、1 个 live 文件跳过）；其中搜索单测 125 项通过。API `tsc --noEmit --incremental false` 通过。真实 live diagnostics 单独执行 2 项通过，仅证明上述 BLOCKED 与安全拒绝事实。

```sh
pnpm --filter @vivic/local-api test
pnpm --filter @vivic/local-api exec tsc --noEmit --incremental false
```

真实诊断不加载 `.env`，不需 Key，不启动服务，明确输出 `SEARCH_RESPONSE / FETCH_RESPONSE / BLOCKED`：

```sh
VIVIC_SEARCH_LIVE=1 pnpm --filter @vivic/local-api exec vitest run tests/search.live.test.ts --reporter=verbose --silent=false
```

安全单测覆盖：实际 HTTPS/DNS primitives 被 stub、真实策略与请求选项保留，验证混合 DNS 答案、私网/保留 IPv4/IPv6、固定 lookup、同域重绑定、逐跳 redirect、字节流限制、二进制/压缩拒绝、DNS deadline、取消、并发频率、SSE/JSON/Highlights 解析、HTTP-200 免费额度限流、未知字段、敏感错误隐藏、父挂载隔离及 untrusted 文本。

live diagnostics 的 2 项“通过”仅表示诊断已执行且失败被如实处理，**不等于搜索成功**。真实网络尚未走到的 redirect/size/正文 timeout 依然是验收缺口，不能用 stub 测试代替。

## 修改文件（仅授权范围）

```text
apps/local-api/src/search/index.ts
apps/local-api/src/search/client.ts
apps/local-api/src/search/errors.ts
apps/local-api/src/search/policy.ts
apps/local-api/src/search/transport.ts
apps/local-api/src/search/upstream/exa.ts
apps/local-api/src/search/upstream/LICENSE.pi-web-access
apps/local-api/src/search/upstream/PROVENANCE.md
apps/local-api/tests/search.routes.test.ts
apps/local-api/tests/search.security.test.ts
apps/local-api/tests/search.live.test.ts
docs/search-poc.md
```

main 后续负责 route 挂载、意图链路和来源卡片集成。本任务未修改 app.ts / pipeline.ts / schemas.ts / config.ts / Web；未实现 OAuth、其他 LLM provider 或搜索设置 UI。
