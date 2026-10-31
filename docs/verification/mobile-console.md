# MOB-01 验证与交付边界

最新：正式 owner、保存回执、扫码和本人服务器 HTTPS/WSS 已由维护者集成并验收，见 [本轮记录](local-runtime-mobile-20261022.md)。下文是 #14 独立修复阶段的历史证据，不再代表正式接线尚未授权；实体安卓与原生 App 尚未验收。

更新：2026-10-22，Asia/Shanghai。Refs #12；PR #14 保持 Draft，**不满足关闭 Issue 的 A/B/C 全部验收条件**。

## 维护者第二轮复查与修复

本轮按用户继续修复 #13/#14 的要求，从最新远端 `03cbedd6ad3233ba5f09170c0c8ea27d0470d0f1` 建立独立工作树并从根目录冻结安装，保留其 workspace/可信代理修复。新增四项客户端回归在该基线全部复现失败：超时后的迟到 ACK/执行通知会把 unknown 改回处理中；重复 ACK 会重置截止时间并使执行状态倒退；主动重连收到 welcome 后会暂时使用旧 owner 快照发出写入；撤销后的已排队 transport 回调仍可恢复 connected 状态。

本次修复让进度单向推进，超时结果只由真实结果确认；一次提交使用一个总截止时间。重连必须收到新快照才可操作，断开/撤销/换连接后丢弃旧回调，凭据仍仅在内存。

中继与电脑侧另外修复：非法 JSON/Schema 帧也计入 100 条/10 秒限流；每帧最多 32 KiB，网络待发缓冲最多 128 KiB，转发失败不会返回接受 ACK；大量中文卡片/画布摘要按 UTF-8 字节预算截断且保留当前画布；状态读取异常会明确暂停控制，恢复后重新报告可用，异常不会破坏请求队列；停止后的回调不再恢复会话。

Windows、Node 24.21.0、pnpm 12.11.2：手机模块 **53/53** 测试和类型检查通过，包含 13 项新增回归；独立 Chromium 浏览器 **4/4** 通过，覆盖真实本机 WebSocket + DEMO adapter 的配对、文字、固定、切换、离线、撤销、取消、刷新、双入口、窄屏与深浅色。截图仍为合成数据。最终提交的根目录检查和 CI 结果写在 PR 正文，下面保留作者上一轮验证，不把不同提交的数字合并为一次检查。

本次仍修复独立原型，正式 owner/模型/持久化完成回执接线、实体手机同网/异网和 TLS 部署没有新增完成声明。

## 维护者反馈与修订

[维护者 review](https://github.com/ECdison6227/vivic-canvas/pull/14#pullrequestreview-5601783741) 要求本轮不合并，暂停手机控制台及公网中继产品集成。后续须先用 Issue 明确目标、权限与验收，不进入 PLAT-01/02 或旅游卡片主线。本次仅修复 workspace 安装边界、代理后的限流身份和验证记录。

原文档的 Web 584/584 与全根检查结果来自个人开发工作区，不能作为本 PR head 的验证证据，现撤回。历史本机实测证据保留，不删除，但不用于替代本次干净 clone 验证。

## 旧 PR head 干净复现

旧 head：`9ea2496eb6cafe0b2e945a4e8ce905abe35ea83f`。从 Git 创建独立 clone，不复制任何 node_modules、不单独安装 contrib。Windows，Node 24.14.0，pnpm 12.11.2（根 packageManager 指定版本）。

| 命令 | 实际结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过，4 workspace，757 包 |
| `pnpm typecheck` | 失败；contrib `protocol.ts` 无法解析 zod，并引发隐式 any |
| `pnpm --filter @vivic/web test` | 58 文件：57 通过，1 个加载失败；524 项通过；`MobileConsole.test.tsx` 因缺 zod 未收集测试 |

本地日志保留在被忽略的 `evidence/mobile-console-feedback-20261022/baseline/`。验证后 tracked 工作区干净，contrib 无 node_modules。

## 修订后的验证

修订采用维护者允许的正式 workspace 方案：Web 声明包依赖，通过显式 exports 引用原型；根锁文件包含 contrib 的全部依赖，删除重复的嵌套锁文件。根 test/typecheck/build 命令包含原型对应检查，真实浏览器回归另行串行执行。没有放宽断言、删除或跳过原有测试。

代码修订提交：`adb4c2db753b4a7d1e5e511b9ecf0698d84eebac`。使用全新 `git clone --no-local --no-hardlinks`，checkout 该提交，从根锁定安装开始；不复制个人 node_modules、不单独安装 contrib、不引用其他分支结果。后续提交仅更新本验证文档；最终 PR head 与每步退出码另存本地验收日志。

环境：Windows，Node 24.14.0，pnpm 12.11.2；浏览器 Edge 155.0.4283.62。本机 Node 与 CI 固定的 24.21.0 不同；本记录不代替 GitHub 的 Linux/Windows CI。

| 命令（仓库根目录） | 实际结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过，5 workspace、758 包，只使用根锁 |
| `pnpm contracts:check` | 通过 |
| `pnpm typecheck` | contracts、local-api、web、原型及其浏览器用例全部通过 |
| `pnpm test` | Web：58 文件、529/529；API：38 文件通过、2 文件跳过，1070 通过、原有 3 项跳过；原型：3 文件、40/40 |
| `pnpm build` | 桌面 main/landing 与独立手机/电脑 DEMO 双入口构建均通过 |
| `pnpm --filter @vivic/web test:mobile:e2e` | 4/4 通过；静音、独立 context、`127.0.0.2:5174`，拒绝复用未知服务，无需本地 API |

浏览器运行设置 `VIVIC_MOBILE_TEST_HOST=127.0.0.2`，用 `VIVIC_E2E_CHROMIUM` 指向本机 Edge，以避开已占用的 `127.0.0.1:5174`。四项保留原有断言，覆盖窄屏/浅色/横屏/错误、真实本机 WS 配对及文字/固定/切换、owner 离线与撤销、执行中取消/刷新清空凭据、独立电脑 DEMO 与手机 context 联动。已查看连接态及浅色设置截图。

新增代理测试覆盖：可信代理后的不同 IP 分开计数；同一 IP 跨连接、IPv4/mapped IPv6 写法共享计数；非可信来源伪造转发头无效；缺失/非法/链式地址及非可信公网来源拒绝升级。nginx 示例使用 `$remote_addr` 覆写客户端转发头，可信代理列表默认空，公网模式要求显式配置。

完整日志、每步退出码、提交/环境元信息在被忽略的 `evidence/mobile-console-feedback-20261022/fixed/`，最终 head 复验另存 `final-head/`；截图在同轮证据目录。检查前后 tracked 工作区均干净。构建保留既有语音 wasm 路径、module externalization、大 chunk、`__dirname` 等提示，退出码为 0；不通过屏蔽提示或跳过检查制造通过。

## 证明范围与未完成项

| 部分 | 原型覆盖 | 未完成 |
| --- | --- | --- |
| 手机 UI/协议 | 配对、设备/画布、文字、固定卡片、设置/12 配色、取消/查询/撤销；严格 Schema | 实体手机系统键盘、安全区、触控 |
| 中继/connector | 本机真实 WebSocket、鉴权、单次码、权限/epoch/版本、心跳、去重、取消、恢复 | 公网 WSS/TLS 部署与真实异网 |
| 既有 owner adapter | 注入边界；内存 DB 上 ControlHost/DisplayClient 的固定、保存、切换、提交前 guard | 产品入口与生命周期未挂载；真实模型和生产保存失败回执 |
| 电脑 DEMO | 明确标注的内存画布与模拟文字执行器 | 正式 Vivic owner → 保存 → Display → 手机结果闭环 |

浏览器回归使用独立 context、静音、关闭 trace/video，不采集物理麦克风、不触碰个人画布。缩小 viewport 只能证明模拟键盘高度下的布局，两个 context 不能证明两台实体设备。代理头测试仅模拟 Node 的可信上游，不代表实际 nginx/TLS 配置已运行；同一 NAT 公网 IP 仍共享鉴权计数。

本次没有修改 App/ControlApp/owner/持久化/API/全局 CSS 或 CI 工作流，没有部署或合并。正式接线方向暂停；后续须按维护者的新 Issue 范围重新确认。不能使用 `Closes #12`。
