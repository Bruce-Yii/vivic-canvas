# Phase 3 独立长期稳定性验证

此处保留原 Phase 3 稳定性记录。后续增量已经修改主线功能；每次脚本都重新生成冻结的生产 snapshot，不能把旧结果当作当前源码验收。

运行命令：

```sh
node scripts/verify-stability.mjs
```

当前默认 Chromium、真实 30 分钟 soak、每 60 秒采样、`127.0.0.1:5174`；历史运行使用 5190，仍可显式选择。脚本直接调用已安装 Playwright 的浏览器 API，不加载项目配置或 webServer，不访问/清理用户 5173/8787。必须与其他使用 5174/8788 的浏览器命令串行运行。

`--no-video` 关闭完整 session 录屏，保留截图与采样，并记录 `recordVideo:false`。仍有采样/浏览器开销，不代表无测量开销的硬件 GPU 基准。

## 数据、权限与构建隔离

- 所有卡片通过真正的 Control 输入框和发送按钮创建，内容包含 `SYNTHETIC TEST … · backend offline`。不调用 `__vivic`、`__vivicControl` 或内部 store/dispatch；会检查 production 不暴露这些 DEV hooks。
- IndexedDB 仅通过 readonly transaction 验证卡片数量、顺序、拖动后的布局及非秘密偏好；测试脚本不写数据库。
- 静态服务对 `/api/*` 返回明确标记的 HTTP 503 backend offline。规则解析在浏览器执行；不调用真实后端、Key、模型、搜索或音频服务。其它 origin 请求被隔离 context 拦截。
- 浏览器独立无持久 profile、permissions 为空、静音，getUserMedia 与音频播放另有只存在于测试 context 的拒绝/静音护栏。不授权麦克风，不启用自动语音。
- 每次先运行 web typecheck，成功后 Vite production build 到操作系统临时目录。保留 asset SHA-256 manifest、typecheck/build 日志和浏览器版本；不覆盖 `apps/web/dist`。
- 退出时关闭本脚本 context/browser/server 并删除它自己的临时 snapshot，证据与视频保留。所选测试端口被占用时失败退出，不终止占用者。

## 覆盖与计时

准备阶段依次通过 UI 累积创建 10、30、60 张待办卡，在每个规模验证同源 Display 数量、刷新恢复、真实鼠标拖动经 owner 落盘、刷新后的布局保留，并截图。

随后从 `soak-start` 开始额外运行完整 30 分钟。时长以 Node `performance.now()` 的真实单调时间计算，与真实 ISO 时间交叉记录。不设置 Playwright clock，不修改 Date 或 performance 时间，不用模拟时间替代 soak。

定时操作如下：

| 实际 soak 分钟 | 路径 |
| --- | --- |
| 3 | Chromium 真正 freeze/active 生命周期操作；另外明确标记的 document.hidden/visibilitychange 路径注入与恢复 |
| 5 / 6 | 通过 Control 打开/关闭减少动效，检查同步偏好与 WebGL draw 调用差异 |
| 8 | Display 刷新恢复 |
| 10 | 关闭 owner，保留 Display 画面，然后重新打开 Control 恢复 |
| 12 / 13 | 原生 WEBGL_lose_context 触发实际 context loss，检查背景 fallback；刷新恢复 |
| 15 / 18 | 60 卡下切 800×600，再回 1440×900，并通过「显示全部」fit |
| 20 | 通过 Control 切深/浅主题，验证 Display 同步 |
| 22 | 运行后期真实拖动、持久化与刷新检查 |
| 25 / 27 | 系统 prefers-reduced-motion 模拟与恢复、刷新；这只修改媒体偏好，不修改时间 |
| 29 | 最后一次刷新与 60 个唯一 cardId 完整性检查 |

Headless 并不等同于真实操作系统窗口隐藏，因此报告将真实 CDP freeze/resume 与合成 visibilitychange 分别标记，不能把合成事件伪称人工最小化验证。WebGL 扩展若不可用明确记为 unsupported，不能算 context-loss 通过。可安装浏览器不含 WebKit/Firefox 时不下载、不声称覆盖；用 `--browser=webkit` 或 `--browser=firefox` 可复用同一隔离脚本执行独立后续运行。

## 指标含义与证据

每个运行目录包含：

- `report.json`：启动/结束/实际 elapsed、检查结论、错误、资源清理、浏览器/构建信息。
- `events.ndjson`：真实时间戳、Node elapsed、soak elapsed 与每条检查记录，实时追加。
- `samples.ndjson`：每分钟 Control/Display 的加载数据、卡片/DOM 数、rAF 间隔分位数、long tasks、JS heap、WebGL/可见性状态。
- `pageerrors.ndjson`、`console-errors.ndjson`：实际捕获记录；离线 HTTP 503 console error 单独记录，不等同于应用未捕获异常。
- `typecheck.log`、`production-build.log`、`snapshot-manifest.json`：构建身份与门禁。
- `screenshots/` 与 `videos/`：规模、刷新、降级/恢复、最终画面与完整 session 录屏。

`jsHeapBytes` 是 Chromium `performance.memory` 的 JS heap，CDP `JSHeapUsedSize/JSHeapTotalSize` 是补充观测，**都不是浏览器进程 RSS**。rAF 记录为帧回调间隔，不宣称等于 GPU 呈现 FPS。long tasks 基于 PerformanceObserver 的主线程事件，不覆盖所有 GPU 延迟。

刷新会重置文档 timeOrigin 和 JS heap，分析时必须分段，不能把刷新后的下降当作没有内存泄漏的证据。截图、视频、rAF sampler 和 WebGL 计数本身有开销；这些是带记录器的 headless 压测数据，不能直接当作真实电视或硬件 GPU 基准。

## 本次结果

原 30 分钟运行：`evidence/phase3-stability/2026-10-15T08-04-07-253Z-chromium/`，真实 soak 从上海时间 16:05:22 开始，已完成并清理，原始证据不覆盖。首次因 networkidle 等待不合适而退出的预跑位于 `2026-10-15T08-03-13-915Z-chromium/`，不是长测。

原长测的主题检查使用了错误的 `getByRole(button)`：Radix 单选项实际是 BUTTON 元素、`role=radio`，导致 30 秒超时。原 `false` 保留。`theme-followup.json` 记录了同一冻结 snapshot、独立短会话中正确 radio 选择器下深/浅主题都同步成功；此短复核只有 1 张 TEST 卡，不冒充原 60 卡长测内的主题切换。

本轮采集 pageerror 与 console.error，未完整采集 console.warning；不能用零 error 排除 warning-only 的 React Flow #015。主线修复后短专项模式会加强这部分采集：

```sh
node scripts/verify-stability.mjs --focused
node scripts/verify-stability.mjs --analyze-run=evidence/phase3-stability/RUN
```

`--focused` 会重新 typecheck、独立 production build、5190 静态服务、UI 创建 10/30/60 卡，再做主题、拖动、800×600 最终边界与减少动效的短专项；仍不访问主线服务。只在原长测关闭其 5190 后启动。它默认额外持续 1 分钟，完整执行耗时包含准备与检查，**不能当作另一次 30 分钟测试**。

运行中对 harness 的修正不会改变已经启动的进程。`verification-notes.json` 明确记录原脚本版本的采样间隔、warning 覆盖、fit 截图限制，以及 event elapsed 字段碰撞。`normalized-events.ndjson` 从原 ISO 时间生成一致时间线，不改写原始日志；实际 soak 以最终的单调 elapsed 和开始/结束时间交叉确认。

## 原 30 分钟长测最终事实

| 项目 | 结果 |
| --- | --- |
| Production bundle | `index-BdWXTzHB.js`；SHA-256 `e0edbf14134c14c4b2da4dc1e191fc62e50646550d2e90eb1e1cbfe45a0bb83c` |
| 浏览器 | 已安装的 Chromium 156.0.8078.4；未下载或运行 Firefox/WebKit |
| 真实 soak 开始 | 2026-10-15 08:05:22.592 UTC / 上海 16:05:22.592 |
| 真实 soak 结束 | 2026-10-15 08:35:24.400 UTC / 上海 16:35:24.400 |
| 单调实际 elapsed | 1,801,749ms，即 **30 分 1.749 秒**；不含准备与退出封存 |
| 完整进程结束 | 08:39:04 UTC；含准备和录屏封存约 2,096.7 秒 |
| 测试检查 | **23 true / 1 false**；唯一 false 为 Radix 主题选择器错误，原结果保留 |
| 数据 | Control UI 创建的 10/30/60 张 SYNTHETIC TEST 待办卡；backend offline；最终 60 个唯一 cardId |
| 恢复 | 三种规模刷新 0.788–0.879s；长测中的刷新约 1.248–2.889s；owner 关闭重开后保留 60 卡 |
| WebGL | 原生 WEBGL_lose_context 成功；fallback 保留卡片，刷新恢复 |
| 减少动效 | UI preference 打开时 1.5s 内 WebGL draw=0；关闭后恢复绘制；系统偏好刷新路径通过 |
| 页面异常 | 原采集范围内 pageerror=0；不能据此排除未采集的原生 rendering 诊断 |
| JS heap | soak 样本约 13.14–26.46 MiB，最终约 16.06 MiB；是 JS heap，非 RSS；刷新分段后分析，不宣称排除泄漏 |
| 帧间隔 | 正常背景窗口 rAF P95 常在 180–380ms，加载/刷新窗口可更高；减少动效窗口约 16.7–16.8ms。**不判定流畅度达标** |
| 记录器 | 34 组样本；有恢复操作导致的间隔延后，保留实际采样时间，不伪装严格 60s |
| 录屏 | Display VP9 960×600 / 25fps，时长约 1873.08s；Control 关闭重开产生两段；ffprobe 元数据验证通过，见 video-metadata.json |
| 退出清理 | context/browser/server 关闭，原临时 snapshot 删除，原 PID 不再存在；见 resource-audit.json |

`report.json` 的 `state=failed` / `ok=false` 是忠实保留原主题 selector 失败的总体退出状态，不能改写为全 PASS；也不能把它解读为 prod 业务主题失败。带录屏的 headless 性能结果明显较差，需主线另做真实硬件 GPU 与无录屏基线。浏览器原生日志在后续运行中还显示 CVDisplayLinkCreateWithCGDisplay 失败，进一步限制其性能外推。

## 新 snapshot 与运行时诊断

1. `2026-10-15T08-40-23-220Z-chromium/` 是一次误启动的后续运行：旧 CLI parser 没正确处理无值 `--focused`，所以实际进入 full 模式；在发现后只终止了这个新 PID，标记 `interrupted`。它不是第二次 30 分钟通过。原 30 分钟目录不变。交付脚本已修复参数解析。
2. 该后续 snapshot 为 `index-DTRe0BT-.js`，SHA-256 `a1e77c850c0c353872614e81baef5f92178061fa025f38b4ec9d57bd03bb7b78`。关闭时 Chromium 原生日志明确包含多条 **ResizeObserver loop completed with undelivered notifications.**，位于其 `report.json → cleanup.contextError`。同轮 Playwright pageerror/console error/window error 为零，说明这些渠道不足以排除此类 rendering 诊断。
3. `2026-10-15T08-48-07-000Z-chromium/` 为显式 `--focused=true --duration-minutes=1` 的正确短专项：重新 typecheck、production build 后通过真实 UI 再创建 10/30/60 卡，专项验证 role=radio 深/浅主题、拖动落盘、800×600 最终视口边界和减少动效。最终具体检查与清理结果见该目录 report.json，不能将它当作 30 分钟长测。
4. 交付脚本进一步增加 Chromium CDP `Log.entryAdded` 收集到 `browser-diagnostics.ndjson`，以覆盖仅出现在原生日志/rendering 域的告警。这一采集补强在上述进程启动后加入，不能倒推为这些旧运行已完整采集 Log 域。

主线提供的真实 GPT 图片/天气/表格/图表/搜索 5 项 PASS 属于主线的 live 验证，本报告不混入本线程的 synthetic/backend-offline 结果。

## CanvasView #015 / ResizeObserver 只读定位与建议

没有修改任何 prod 文件。依据当前项目安装的 `@xyflow/react@12.12.0` 与 `@xyflow/system@0.0.83` 源码：

- `CanvasView.tsx:72` 由 cards/dragOverrides 等依赖每次 map 出全新 node 对象；拖动更新 override 时全部 node 的对象引用变化。
- `CanvasView.tsx:117` 的 onNodesChange 仅保存 position，未消费 dimensions / measured / dragging 等变化。传回 nodes 只有 width，没有保留测量结果。
- system 的 `adoptUserNodes`（esm/index.mjs:1669）在 userNode 引用变化时重建 internal node，并从 `userNode.measured?.width/height` 重建 measured。当前输入没有 measured，因此重新变为 undefined；源码注释明确说明移除 measured 会重置 handleBounds 并要求重新测量。
- system 的 `calculateNodePosition`（esm/index.mjs:454）发现 measured.width 或 measured.height 为 undefined 就调用 `onError('015', ...)`。报错文本正是 “trying to drag a node that is not initialized … use onNodesChange”。这是 **#015 的直接、高置信度原因链**，不需要从功能拖动成功推断它没有问题。
- React 的 `useNodeObserver` 对未初始化节点重新 observe；`updateNodeInternals` 再通过 dimensions change 回传测量。dimensions 被忽略、下个拖动 render 再次清空 measured，会形成重复测量/重新注册链。它与已观察到的 ResizeObserver loop 高度一致，但**没有单独 trace 证明所有 loop 都来自此链**，因此这部分保留为根因假设。
- system 的默认 `createDevWarn`（esm/index.mjs:600）仅在 NODE_ENV=development 时 `console.warn`，故 production 没看到 #015 不能证明同一错误状态不存在。

建议主线后续统一修复：

1. 在 CanvasView 维护本地 React Flow nodes；使用公开 `applyNodeChanges` 消费所有允许的 view changes，尤其 dimensions/measured 与 dragging，再与 owner 的 record/position 合并。
2. 合并时复用未变化节点对象；保留本地 measured/dragging，owner snapshot 只更新业务字段及被确认的坐标，不每帧把节点初始化信息丢掉。
3. 对 pinned、失联和 stale drag 的限制继续保留；dimensions/dragging 只是本地 view 状态，不广播、不持久化、不授予 Display DB 写权限。
4. wrapper ResizeObserver 的 viewportSize 上报可加尺寸相等短路，减少无效 store 通知；不要通过硬填 layout.height 或吞掉 onError/window error 来“修复”初始化问题。
5. 回归应在真实 Chromium/Firefox 中连续拖动、snapshot 到达、Pin 切换和 resize 场景断言稳定：无 #015，measured 不被清空，RO 原生诊断不再持续；现有 renderer mock 单测不能覆盖浏览器测量循环。


## 最终短专项与交付

正确短专项目录 `2026-10-15T08-48-07-000Z-chromium/` 最终为 **14/14 PASS**、退出码 0，额外真实 soak 60,682ms，含 UI 准备与清理的进程总时长约 234.8s。它与被终止的误启动 run 使用同一新 production bundle `index-DTRe0BT-.js`。

- role=radio 深/浅主题在 60 卡下同步通过，已保留两张截图；原主题失败不再复现。
- 10/30/60 卡刷新与拖动落盘、60 卡后期再次拖动通过。
- 800×600 下等待最终 fit 后，断言 `count=60, clipped=0` 通过，截图 `focused-800x600-bounds.png`。
- 减少动效偏好同步，1.5s WebGL draw=0。
- 本轮采集的 pageerror/window error/unhandled rejection 记录为零；因为同 bundle 的 Chromium 原生日志已证实存在 RO loop，不将它写成“production 无任何告警”。默认 production 又会隐藏 devWarn #015，根因仍需主线修复。
- 脚本 `node --check`、限定 oxlint 通过；新 snapshot 的 web typecheck 与 Vite production build 通过。

`evidence/phase3-stability/final-resource-audit.json` 验证四个 runner PID 均已退出、所有本次临时 snapshot 已删除、5190 无监听；没有停止或修改主线 5173/5174/8787/8788 服务。失败预跑、误启动、原 30 分钟和正确短专项全部分别保留。此任务到此结束，不等待后续集成；主线可按上述只读定位统一修复节点测量链。


## 最终增量源码的不录屏运行（2026-10-15 晚）

`node scripts/verify-stability.mjs --no-video`，应用源码 `4db5446`。正式 soak 13:40:21.218–14:10:23.912 UTC，单调 **1,802,577ms**。`recordVideo:false`、`videos:[]`；**24/24** 检查通过，60 个唯一 TEST 卡片恢复完整，页面异常/已列运行时诊断为 0，麦克风/播放尝试为 0，所有自建资源关闭。静态 API 的预期 HTTP 503 单独记录，不说 console error 为零。

原生 GL loss 真正触发并成功降级，之后 500ms 窗口背景绘制次数为 0；刷新恢复。最新包装不从驱动事件触发 React 更新，也不额外申请探测 context，保留真实 Grainient 与原有降级样式。

正式证据和分析：`evidence/phase3-stability/2026-10-15T13-39-03-281Z-chromium/{report,analysis}.json`。`2026-10-15T13-33-29-088Z-chromium` 是旧反馈断言导致的准备失败，`2026-10-15T13-36-11-808Z-chromium` 为最后来源字段过滤修正而中断，两者均保留，不冒充完整长测。

Display soak JS heap 约 14.6–31.2MB（不是 RSS），文档刷新分段；rAF 各窗口 P95 16.7–700ms。Headless、采样和同机负载下的这些数值不证明物理 GPU 流畅度，也不证明无泄漏。摘要见 [next-plan.json](verification/next-plan.json)。
