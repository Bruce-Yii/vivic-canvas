# MOB-01 手机控制台：最小接线方案

关联：<https://github.com/ECdison6227/vivic-canvas/issues/12>。更新：2026-10-22。

## 当前授权与基线

原 [PR #14 review](https://github.com/ECdison6227/vivic-canvas/pull/14#pullrequestreview-5601783741) 暂停的是原型阶段自动集成。2026-10-22 用户已明确授权正式 owner/保存/文字接线和本人服务器中继，维护者另建集成分支并完成真实浏览器闭环，见 [本轮更新](../updates/2026-10-22-local-runtime-mobile.md)。PR #14 未自动合并。下面保留原先接口设计供追溯，待核定清单以本轮实现为准。

本轮先交付独立手机界面、运行时协议、中继和电脑 connector，不改共享核心接线。Issue B.6 与“代码边界”要求**程佳锐在工单/PR 明确确认准确文件，再做共享接线**。本文件是待核定的最小方案，不能视作已批准。真实手机与跨网络验收仍需可访问的 WSS 测试环境和实体设备。

PR #14 使用独立任务分支 `feat/mobile-control-console`，初始基线为 `ea9fbe82cfa0a64ac0ecbd86e9917931c262b54b`，目标为 `ECdison6227/vivic-canvas:main`。只带本项改动，不覆盖个人工作区、不修改 remote；验证从该任务提交创建的干净 clone 执行，不引用其他开发分支的结果。

## 消息流与边界

```text
电脑现有 owner ─ 注入 ComputerHostAdapter ─ connector ─ WSS ┐
                                                        鉴权中继
手机独立 React 页面 ─ MobileClient ─ WebSocketTransport ─ WSS ┘
```

手机不调用 `getControlHost()`，不打开电脑 IndexedDB，不持有模型 Key 或本地 API bearer。中继只看必要的设备、画布摘要、控制指令与执行结果，不接触完整画布文件、图片、模型连接或本地 API。电脑仍负责 Action 校验、执行、保存和既有 Display 同步。

首版允许 `text.submit`、`canvas.switch`、`card.pin`，以及只读快照、执行结果查询和取消请求。每条写入带 session、device、epoch、requestId、目标画布和预期版本；电脑在当前 owner 上复核。取消只能中止尚未提交的执行，不能撤回已提交动作。发送/中继 ACK 与实际执行结果分开。

## 待核定的共享文件（本轮未修改）

| 文件 | 最小接入点 | 原因 |
| --- | --- | --- |
| `apps/web/src/App.tsx` | 独立 `/mobile` lazy 入口，在 ControlApp 之前分流 | 手机不启动第二个 owner |
| `apps/web/src/control/ControlApp.tsx` | 设置中启停电脑 connector；给现有文字提交入口增加可等待的执行结果、AbortSignal 和提交前 guard | 复用已有本地/模型请求，只有真实 owner 提交成功才回执；不能把 void 提交入口当执行成功 |
| `apps/web/src/sync/remoteControlBridge.ts`（新增） | 生命周期薄包装，注入现有 host、store 只读视图和文字执行 callback | owner 丢失/切换/退出时失效，不重写 owner |

独立模块中的 `vivicHostAdapter.ts` 提供可注入适配器；它不获取 owner，不加载持久化，不注册生产生命周期。`browserRuntime.ts` 预计无需改动；若最终需要，须更新本表并再次确认。不改本地 API、共享 contracts、owner/channel 协议、画布存储或全局 CSS。按维护者允许的 workspace 方案，此次修订将原型纳入 workspace、声明 Web 包依赖并统一根锁及检查命令；不修改 CI 工作流。

已发现的文字接线细节：现有 `showLookupCandidate()` 会先通过 host.dispatch 新建占位卡，推进画布版本。独立 connector 的提交前 guard 严格检查初始预期版本，不能直接包住现有 void callback，否则占位卡可能使请求自身失效。待核定的最小做法是在现有文字入口增加远控执行选项，走无占位的单次最终提交并返回真实结果；若必须保留远控占位，则需维护者明确请求自身版本推进的授权规则和回归，不能直接关闭版本检查。现有异步保存也需明确失败回执语义。

## 新依赖、运行与回退

中继使用 `ws`，协议使用 `zod`；依赖在 `contrib/mobile-console/package.json` 声明，统一由根锁文件安装。Web 显式依赖 `@vivic/mobile-console-prototype` 并使用包 exports，不再跨目录引用 contrib 源码或 node_modules。TypeScript、tsx、Vitest 与 Playwright 用于原型开发/验收。手机端复用现有 React、Radix/shadcn、Lucide、Geist 和流光以太，不新增设计系统。根测试/类型/构建命令覆盖原型相应检查；浏览器测试另行串行运行。

生产要求可信 HTTPS/WSS 域名、TLS 反向代理、精确 Origin 白名单、独立中继 admission secret、进程与内存限额。TLS 在代理终止；中继可读取消息内容，因此不宣称端到端加密。首版同局域网也依赖互联网、中继和在线电脑 owner。

回退：独立进程停止即不再接受远控；凭据和配对码只在内存，重启需重新配对。待正式集成时移除设置中的启用项/生命周期挂载即可关闭，不迁移/删除用户画布。详见模块 README 与传输决策文档。

## 完成判定

独立协议/中继/模拟浏览器通过只能证明相应阶段；不能关闭 Issue #12。正式 owner 接线批准并实现、真实手机同网与异网闭环、刷新/锁屏/休眠恢复验收完成后，才能使用 `Closes #12`。目前应使用 `Refs #12`。
