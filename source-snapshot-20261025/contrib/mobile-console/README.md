# Vivic 手机控制台（MOB-01）

关联 [Issue #12](https://github.com/ECdison6227/vivic-canvas/issues/12)。2026-10-22 用户明确授权正式接线与本人服务器中继，维护者集成分支已连接真实 owner、文字执行、保存确认和 Display；[本轮更新](../../docs/updates/2026-10-22-local-runtime-mobile.md)与[验收](../../docs/verification/local-runtime-mobile-20261022.md)为最新状态。PR #14 原 Draft 状态与独立 DEMO 保留，未自动合并；下文 DEMO 测试仍不能冒充实体手机验收。

2026-10-22 维护者继续修复：请求总期限不被 ACK 延长，未知结果不因迟到进度变成处理中；重连需新 owner 快照，撤销后旧回调失效。中继限制非法帧频率、32 KiB 单帧和 128 KiB 待发缓冲；大摘要按字节裁剪并保留当前画布。详细复现和检查见 [验证记录](../../docs/verification/mobile-console.md)。

同局域网首版也需要互联网、中继在线及电脑运行 Vivic。手机刷新需重新配对；同一页面断网可用内存凭据重连。未实现局域网自动直连、全量云存储、原生 App 或语音。

## 安装与检查（仓库根目录）

```powershell
pnpm install --frozen-lockfile
pnpm --filter @vivic/mobile-console-prototype test
pnpm --filter @vivic/mobile-console-prototype typecheck
pnpm --filter @vivic/web test
pnpm typecheck
pnpm build
pnpm --filter @vivic/web build:mobile
```

原型正式声明为 workspace 包，Web 通过包名和显式 exports 引用；所有依赖只由根 `pnpm-lock.yaml` 锁定。不要使用 `--ignore-workspace` 或单独生成 contrib 锁文件。根 `pnpm test` 包含中继单测，`pnpm typecheck` 包含原型与浏览器用例，`pnpm build` 包含独立 UI 构建。`dist-ui/` 不把中继 secret 烘焙进前端。Node 22+；本轮实测 Windows / Node 24。

新增运行依赖为 `ws`（MIT）与 `zod`（MIT），准确解析版本固定在根锁文件。其余 UI 依赖复用现有项目批准的组件；开发工具在对应 workspace 包内声明。

## 启动独立中继

在专用 PowerShell 终端，通过运维安全方式将随机、专用的 `VIVIC_RELAY_ADMISSION_SECRET` 注入进程环境（32–256 字符）；不要复用模型/本地 API Key，不把具体值写进命令、脚本、文档或 Git。其他非秘密配置：

```powershell
$env:VIVIC_RELAY_ORIGINS='http://127.0.0.1:5174,http://localhost:5174'
$env:VIVIC_RELAY_HOST='127.0.0.1'
$env:VIVIC_RELAY_PORT='8791'
pnpm --filter @vivic/mobile-console-prototype relay
```

进程只输出端口/模式，不打印配对码或请求正文。`GET /healthz` 返回服务身份，WS 路径是 `/relay`；本地开发 URL 为 `ws://127.0.0.1:8791/relay`。非 loopback 的明文 WS 被客户端拒绝。生产部署参考 [deploy/README.md](deploy/README.md)，只提供说明，不自动部署。

## 手机 UI 与电脑 DEMO

```powershell
pnpm --filter @vivic/web dev:mobile
```

独立服务器对应 `http://127.0.0.1:5174/`（手机界面）与 `/computer.html`（电脑 DEMO）。占用 5174 时不要终止他人进程。浏览器测试严格启动自己的服务器、拒绝复用未知服务；若 `127.0.0.1:5174` 被占，可设置 `VIVIC_MOBILE_TEST_HOST=127.0.0.2`，仍使用测试端口 5174。

电脑 DEMO 输入专用 admission secret，仅保存在当前内存，连接真实中继后才显示短时配对码；手机输入该码。DEMO 的文字执行、画布和卡片只是明确标注的内存测试数据，既不调用模型，也不连接用户 IndexedDB/Display。要让真实手机访问，需由维护者配置可信 HTTPS/WSS 环境；`127.0.0.1` 只用于本机开发，不能让手机访问电脑。

## 独立浏览器验证

```powershell
pnpm --filter @vivic/web test:mobile:e2e
```

使用 5174、串行运行、独立 browser context、静音；不需要本地 API，不采集麦克风。已有测试进程/浏览器之间不要并发运行不同 Playwright 命令。可设置 `VIVIC_E2E_CHROMIUM` 指向已安装 Edge；否则使用 Playwright Chromium。截图在被忽略的 `evidence/mobile-console/`，关闭 trace/video，配对码不进入截图。

这组测试验证真实本机 WS 中继 + DEMO adapter 和手机尺寸浏览器；不是实体手机/移动网络/锁屏/真实键盘验证。真实 owner 的固定卡片、保存和 Display 同步另由 `apps/web/src/control/mobile/__tests__/vivicHostAdapter.test.ts` 在内存 DB 上验证，也不是实体双设备证明。

## 文件和接线

| 文件 | 职责 |
| --- | --- |
| `protocol.ts` | 严格运行时 Schema、权限和消息 |
| `transport.ts` | 可替换传输接口、WSS 边界 |
| `client.ts` | 手机状态机、内存凭据、查询/取消/结果 |
| `connector.ts` | 电脑会话、权限、串行执行和去重 |
| `vivicHostAdapter.ts` | 注入既有 owner 接口，不创建 owner、不自动挂载 |
| `relay.ts` / `server.ts` | 独立鉴权中继与 CLI |
| `tests/` / `browser/` | 根测试覆盖协议/中继单测；真实 WS 浏览器测试另行执行 |
| `../../apps/web/src/control/mobile/` | 独立手机 UI、电脑 DEMO、局部样式、构建/浏览器配置 |

connector 单次生命周期：stop/过期后新建实例与设备身份。已配对设备仅限三项白名单操作；文字 callback 必须遵守提交前 guard，并返回真实完成结果。512 条去重额度耗尽后结束旧会话再新建，不能清空旧记录后在同一会话重放。离线 stop 只证明本地不能执行，不能伪称已通知中继撤销。

原型阶段接线记录见 [最小接线方案](../../docs/design/mobile-console.md)，协议见 [传输决策](../../docs/decisions/mobile-control-transport.md)。本次正式接线、扫码与服务器部署状态见顶部的新更新；原 PR 未合并，实体安卓与原生 App 仍需另行验收。
