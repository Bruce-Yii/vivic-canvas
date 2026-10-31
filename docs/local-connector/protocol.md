# 本地启动器协议（RUN-01）

版本：`0.1`。启动器是本机 Web 应用与一个**由本会话启动的决策子进程**之间的最小桥接层。它不是 MCP server，也不把 localhost 端口或模型 API 称为 MCP。

## 传输与会话

- 启动器只绑定 `127.0.0.1`，使用 HTTP/1.1 JSON；每次响应使用 `Connection: close`，每个连接只处理一个请求，不监听公网，不发送 CORS 头。
- 启动时创建随机 `sessionId` 和进程会话 bearer token。同一进程中的请求重复使用该 token，重启后重新生成。受控本机后端启动连接器、在内存中捕获首行 stdout 的启动 JSON，并在请求中发送 `Authorization: Bearer <token>`；token 不能写入源码、日志、浏览器 storage 或画布，也不交给页面。
- 浏览器调用受控本机后端，由后端代理连接器请求；当前原型未实现该桥接，也不支持跨源浏览器直接访问连接器。命令行 HTTP 调试不证明浏览器接入完成。
- 每个启动器进程只有一个 owner session。服务管理只使用该进程保留的 `Popen` 句柄，不按进程名或端口杀进程，因此不会结束其他程序。
- `/healthz` 只返回无敏感信息的存活信号；其余 `/v1/*` 端点均需本地会话凭据。

## 端点

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/healthz` | 无凭据存活探针 |
| GET | `/v1/health` | 服务状态、异常和文字链路可用性 |
| GET | `/v1/capabilities` | 版本、loopback 传输、能力和操作列表 |
| POST | `/v1/service/start` | 启动一个受管决策服务；重复启动返回 `ALREADY_RUNNING` |
| POST | `/v1/service/stop` | 停止本会话启动的服务；未运行返回 `NOT_RUNNING` |
| POST | `/v1/service/reconnect` | 停止并重新启动本会话服务 |
| POST | `/v1/decide` | 提交文字，返回 `202` 与 `runId`；服务离线返回 `503/OFFLINE`，发送队列满时返回 `503/BACKPRESSURE` |
| GET | `/v1/runs/{runId}` | 查询一次决策的 queued/running/completed/failed/canceled 状态 |
| POST | `/v1/runs/{runId}/cancel` | 取消仍在运行的请求 |
| GET | `/v1/models` | 返回模型名称、大小、受控显示路径和是否已下载 |
| POST | `/v1/models/download` | 用户显式选择模型后开始下载；不会默认下载 |
| GET | `/v1/downloads/{taskId}` | 查询下载进度 |
| POST | `/v1/downloads/{taskId}/cancel` | 取消下载并删除 `.part` 文件 |

错误统一为：

```json
{"error":{"code":"OFFLINE","message":"本地决策服务不可用；文字主链路可以继续使用 LLM","retryable":true,"textPathAvailable":true}}
```

已定义的主要错误码包括 `UNAUTHORIZED`、`PORT_OCCUPIED`、`ALREADY_RUNNING`、`NOT_RUNNING`、`PROVIDER_START_FAILED`、`PROVIDER_EXITED`、`OFFLINE`、`PROVIDER_UNAVAILABLE`、`RUN_NOT_FOUND`、`MODEL_SOURCE_UNCONFIGURED` 和 `DOWNLOAD_ALREADY_RUNNING`。

请求体最多 64 KiB。`Content-Length` 必须为非负十进制数；重复的长度头、`Transfer-Encoding`、声明长度不足以及无效 JSON 均被拒绝。没有长度头表示空对象请求，不支持 chunked 请求。读取请求行/头的空闲超时为 5 秒，请求体另有总计 5 秒的截止时间；持续少量发送也不能延长请求体期限。请求体超时返回 `408/REQUEST_TIMEOUT` 并关闭连接；格式错误返回 `400`，未读取的请求字节不会复用为下一个请求。

## 有界生命周期与取消

管道 I/O 由独立写线程处理，不在状态锁内等待子进程读取 stdin。待发送队列最多 16 项；满时拒绝新增请求，健康查询和停止仍可处理。`--write-timeout`（默认 2 秒）、`--startup-timeout`（默认 15 秒）和 `--inference-timeout`（默认 30 秒）均须为正数。

写入超时、未按时发出 ready、推理超时或无效的子进程协议消息分别产生 `WRITE_TIMEOUT`、`STARTUP_TIMEOUT`、`INFERENCE_TIMEOUT`、`PROVIDER_PROTOCOL_ERROR`。连接器将服务设为错误，使未完成请求失败并回收当前受管进程；不会自动重试用户请求，恢复须显式 `/v1/service/reconnect`。

取消使请求立即进入终态 `canceled`，随后不会接受迟到结果；尚未发出的 decide 消息尽可能跳过，已发送请求的取消通知以同一有界写通道尽力发送。真实适配器必须自行实现合作式取消，连接器不能保证任意适配器立即中断内部计算。默认 fixture 实现合作式中断，用于验证协议；它不证明真实模型的取消能力。

本地文件复制在最终替换目标文件之前再次检查取消，并与取消操作使用同一状态锁：复制读到 EOF 后才接受的取消也不能覆盖已有文件。停止决策服务不影响用户另行启动的文件复制；正常关闭整个连接器会拒绝新服务/复制任务、取消在途复制，并在锁外合计等待最多 1 秒。若系统文件 I/O 尚未返回，取消标记仍阻止其之后提交目标文件；强杀连接器时 `.part` 的自动清理未作保证。

## 子进程协议

默认 fixture `mock_provider.py` 是真实启动的子进程，仅通过 stdin/stdout JSONL 通信：

```json
{"event":"ready","protocolVersion":"0.1"}
{"op":"decide","runId":"…","text":"显示全部"}
{"event":"result","runId":"…","result":{"action":"fit","source":"local-fixture"}}
{"op":"cancel","runId":"…"}
```

实际模型适配器实现这组 JSONL 消息，仍由启动器负责进程生命周期。启动器不会执行结果中的代码，也不代替产品的 Action/数据 Schema 校验；真实模型仍须通过受控后端集成和验收。

每行必须是完整的 JSON 对象并带字符串 `event`；ready 必须声明 `protocolVersion: "0.1"`。result/error 必须带字符串 `runId`。result 数据只接受 `action`、`source` 两个字段，`source` 为字符串，`action` 只允许 `fit`、`restore`、`expand`、`collapse`、`other`；多余字段、未知 action、数组或错误类型都会使受管服务进入 `PROVIDER_PROTOCOL_ERROR`。error 必须带字符串 `code` 和 `message`。这是本原型的有限协议，不是 Vivic 全量卡片 Action 契约。

启动器仅按白名单传递 `PATH`、`SYSTEMROOT`、`WINDIR`、`TEMP`、`TMP`、`USERPROFILE`、`APPDATA`、`LOCALAPPDATA`（父进程已设置的项），另固定 `PYTHONIOENCODING=utf-8`、按配置传入 `VIVIC_PROVIDER_PORT`。环境变量名按大小写不敏感匹配，不整体继承 API key/OAuth 等凭据。Windows 系统目录、临时目录和用户运行目录用于网络适配器及本机运行时初始化。

## 与文字主链路的关系

决策服务未启动或已离线时，`/v1/decide` 返回 `503/OFFLINE` 和 `textPathAvailable: true`；该字段只是给宿主的可降级信号。当前原型未接入核心路由，不会自动执行 Vivic 的文字/LLM 降级；宿主桥接、真实模型和产品路径仍须单独集成验收。因此本 PR 仅关联 `Refs #8`，不关闭完整集成任务。
