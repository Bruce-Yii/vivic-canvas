# RUN-01 本地启动器验证记录

更新：2026-10-22。范围仅为 `contrib/local-connector/` 独立原型及配套文档；关联 PR #13、Refs #8，不关闭完整模型/产品集成任务。

## 维护者复查与追加修复（2026-10-22）

本轮从 PR #13 最新提交 `031264a7e9abfcacc78db0a1a9d0bcf5968a67af` 创建隔离工作树，未改共享入口、依赖或用户运行服务。原有 22 项测试在 Windows、Python 3.12.14 上全部通过；这证明此前的管道背压、Windows 必要环境和受管进程树修复已经存在，不重新声称这些是本轮新增。

追加 7 项回归测试后，以原始 head 的文件在临时目录重跑，7 项均未通过（其中重复 framing 测试含两个子场景），实际复现：

- 负 `Content-Length` 使处理线程等待客户端 EOF；重复长度与 chunked/长度混用未被拒绝。
- 缺少实际请求字节的客户端一直等待，持续少量发送也无总期限；提前 EOF 时，即使字节数小于声明长度，合法的短 JSON 仍被当作完整请求。
- 在复制最后一次读取/EOF 之后取消，任务仍进入 completed 并覆盖既有目标；关闭 HTTP 宿主也未取消在途复制。

现已拒绝不支持的 framing、给请求体加 5 秒总期限，并对每次响应关闭连接；读取超时返回结构化 `408/REQUEST_TIMEOUT`。复制的取消检查与最终替换共用锁，正常关闭宿主会取消复制并拒绝启动新工作。新增测试使用原始 loopback socket、0.25 秒测试期限和受事件控制的真实本地文件复制，覆盖慢速持续发送、EOF 取消和关闭竞争；不使用真实模型或网络下载。

最终验证环境为 Windows、Python 3.12.15（现有 uv 安装，无新增依赖）：

```powershell
& '<已安装的 Python 3.12.15 路径>\python.exe' -m unittest discover -s contrib/local-connector -p 'test_*.py' -v
```

结果为 **29/29 通过**（原有 22 项 + 新增 7 项）；`git diff --check` 通过。原始 head 的失败日志保存在忽略目录 `evidence/local-connector-maintainer-20261022/`。本轮仅更改独立 Python 原型和对应文档，不将上述结果等同于仓库根应用集成、真实模型、真实权重或 macOS/Linux 验收；根应用锁定安装和全量检查由维护者在最终集成分支另行记录。

正常关闭会在锁外合计等待复制线程最多 1 秒；系统 I/O 阻塞时取消仍阻止后续提交，强杀进程的 `.part` 清理与恢复未覆盖。真实模型适配器、凭据设计、后端桥接、设置 UI 和产品 Action 执行仍待独立集成。

## 本轮故障复现与修复

环境：Windows 开发机、Python 3.14.2（`py -3`）。测试使用随机 loopback 端口、隔离临时目录和合成子进程，token 仅保存在测试内存中；未占用用户的开发端口或画布。

修复前以真实子进程复现：

- provider 发出 ready 后不再读取 stdin；并发提交 24 个 4,000 字符请求填满 OS 管道，健康查询实际触发 0.8 秒 `TimeoutError`。原同步写入持有健康和停止共用的状态锁；此基线测试在健康查询失败后未继续调用停止，停止阻塞属于代码路径分析，不冒充独立测量。
- 原子进程环境缺少 `SYSTEMROOT`、`TEMP`、`TMP`、`USERPROFILE`、`APPDATA`、`LOCALAPPDATA`；网络探针 `getaddrinfo("localhost", ...)` 实际失败，返回 `gaierror: [Errno 11003] getaddrinfo failed`。这是本机复现结果，不将维护者报告的其他错误码混作本机证据。
- 原 stdout 读取遇到 JSON 数组 `[]` 会崩溃，健康状态仍显示 ready，请求无法结束；启动和推理也没有截止时间。
- 基线只强杀连接器父进程后，provider 和孙进程在 5 秒观察窗口结束时仍存活，之后才由测试清理回收。

修复后已执行：

| 命令/测试组 | 本轮结果 | 验证内容 |
| --- | --- | --- |
| `py -3 -m unittest discover -s contrib/local-connector -p "test_connector.py" -v` | 10/10 通过 | 原 8 项协议/生命周期/模型本地复制测试；新增旧进程退出监控与重启、停止之间的竞争回归 |
| `py -3 -m unittest discover -s contrib/local-connector -p "test_environment.py" -v` | 1/1 通过 | 真实子进程 DNS、TCP 监听/连接/收发；必要系统环境保留，合成 API key/OAuth 哨兵变量未传入 |
| `py -3 -m unittest discover -s contrib/local-connector -p "test_faults.py" -v` | 11 项通过（原 10 项与新增进程归属回归分别执行） | 真 CLI/HTTP 的 stdin 背压下健康/停止可响应、0.3 秒写入超时、满管道取消、启动/推理超时、数组/未知 action/多余字段协议错误、终态不被迟到结果改写、强杀连接器后 provider/孙进程回收、显式停止回收进程树且保留独立进程，以及 fixture 取消不拖延下一请求 |

测试路径统一通过 `Path.resolve()` 归一化，避免 Windows 8.3 短路径与长路径比较产生误判。Windows 父进程强杀回收测试先只杀连接器并断言子孙进程退出，再执行测试清理，不能由清理动作替代通过条件。故障回归不使用真实模型或网络模型服务。

以上合计 22 项测试。原始复现与重测材料保留在忽略目录 `evidence/20261022-local-connector/`（含 `fault-baseline.md`、`fault-regression.md`）；不会删除，也不上传 token、临时数据或本机绝对路径到公开仓库。最终 head 的干净 clone 与仓库根目录锁定安装、契约/类型/全量测试/构建结果，在 PR 验证段落记录其实际命令和结果；上表不预先声称这些尚未执行的检查已通过。

## 原型覆盖与交付边界

- 公开 `/healthz`，其余 `/v1/*` 需要进程会话 bearer；重复启动、端口占用、异常退出及显式重连有结构化结果。停止仅管理本会话启动的进程。
- stdin 独立写线程和 16 项有界队列；写入、启动、推理具有可配置截止时间。协议错误或超时会终止受管服务并使未完成请求失败；需显式重连恢复。
- 取消会立即终结本地请求状态并拒绝迟到结果；向适配器发送有界、尽力的取消通知。真实适配器的内部计算能否中断须由其自身实现并另测，fixture 的合作式取消不代表真实模型已通过。
- `mock_provider.py` 是无网络的真实子进程 fixture，只证明此有限协议和生命周期；不代表模型准确率、完整 Action 契约或在线事实能力。
- 模型“下载”仅为用户显式触发的受控本地文件复制，含进度和取消；没有网络下载、真实权重目录或真实模型适配器验收。
- 会话 token 在同一连接器进程内可重复使用，重启后重新生成。受控本机后端应在内存中捕获并持有，浏览器仅调用该后端。连接器无 CORS，本 PR 没有浏览器直连或后端桥接验收。
- 当前主线另有受控 decision HTTP provider；它不等于本连接器已接入核心。此 PR 不修改核心路由、owner/持久化、共享契约或启动脚本；`textPathAvailable: true` 是宿主提示，不证明已经执行产品 LLM 降级。
- 本轮实测平台为 Windows。macOS/Linux 有代码路径，尚无本轮真实设备运行记录；不能用设计审查或单个平台的测试替代跨平台验收。
- 未启用真实模型服务、真实密钥、物理麦克风、音频播放或公网监听；完整 issue #8 集成仍需后续独立验收。

## 本机协议复查

```powershell
py -3 contrib/local-connector/connector.py serve --port 8791
py -3 -m unittest discover -s contrib/local-connector -p "test_*.py" -v
```

命令行调试可使用启动输出的会话 token 调用健康、能力、启动、决策、查询、取消、重连和停止端点。受控宿主接入时应私下捕获启动 JSON，避免终端录制、应用日志和浏览器存储持有凭据。具体超时参数、环境白名单与消息校验见[协议](../local-connector/protocol.md)。
