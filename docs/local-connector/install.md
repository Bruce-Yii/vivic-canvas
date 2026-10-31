# 本地启动器安装与运行

RUN-01 是独立原型，不要求 Electron、Tauri 或桌面客户端。需要 Python 3.10+，仅使用标准库。

## 启动

在仓库根目录执行：

```powershell
py -3 contrib/local-connector/connector.py serve --port 8791
```

macOS/Linux 使用 `python3` 代替 `py -3`。
Windows 若未安装 `py` 启动器，可改用已安装的 Python 3.10+ 的 `python` 命令或其绝对路径；Windows Store 占位别名不等于已安装可用的解释器。

启动器的首行 stdout 是本次进程会话的 JSON（包含 `sessionId`、端口和 bearer token）。该 token 在同一连接器进程内可重复使用，重启后重新生成，并非一次性请求凭据。受控本机后端应启动连接器并在内存中捕获这行 JSON，不把它转发给浏览器、持久化或记录到日志。手工终端运行仅用于本机协议调试；不要复制 token 到 issue、浏览器存储或仓库文件。

浏览器应调用受控本机后端，由后端代为发送下列请求。连接器不提供 CORS；本原型尚未实现该后端桥接，不能将以下命令行接口当作浏览器直连方案。默认决策服务是无网络的 `mock_provider.py`，用于验证真实子进程生命周期：

```sh
curl http://127.0.0.1:8791/healthz
curl -H "Authorization: Bearer <token>" http://127.0.0.1:8791/v1/capabilities
curl -X POST -H "Authorization: Bearer <token>" http://127.0.0.1:8791/v1/service/start
curl -X POST -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"text":"显示全部"}' http://127.0.0.1:8791/v1/decide
```

返回的 `runId` 用 `/v1/runs/{runId}` 查询，服务控制使用 `/v1/service/stop`、`/v1/service/reconnect`。退出终端时按 `Ctrl-C`，启动器只清理自己的子进程。

可用 `--write-timeout`、`--startup-timeout`、`--inference-timeout` 设置正数秒数，默认分别为 2、15、30 秒。写入、启动或推理超时会把本次受管服务设为错误、结束未完成请求并回收进程，随后需显式重连。待发送消息队列最多 16 项，队列已满时新请求返回 `503/BACKPRESSURE`。

HTTP 每次响应关闭连接；请求体最多 64 KiB，并有 5 秒总读取期限。客户端应发送单个有效 `Content-Length`，不发送 chunked 请求；慢速或不完整请求会被结束，不能持续占住处理线程。

## 接入真实适配器

用 `--provider-command` 指定实现上述 JSONL 子进程协议的适配器：

```sh
python3 contrib/local-connector/connector.py serve --provider-command python3 path/to/provider.py
```

不要把 API key 放在命令行参数、仓库文件或浏览器中。真实适配器的凭据读取/安全存储应由受控本机后端单独设计；本原型仅按白名单传递必要的系统环境，不会把父进程中的 API key/OAuth 等变量全部传入子进程。具体白名单见协议文档。

## 模型下载

`GET /v1/models` 只显示模型大小、受控相对路径和是否配置下载源。当前“下载”仅指从受控本地目录复制文件，尚无网络下载适配；默认目录只有 fixture，未配置真实模型源。只有用户明确调用 `/v1/models/download` 才会复制模型文件，支持进度查询和取消；没有下载源时返回 `MODEL_SOURCE_UNCONFIGURED`，不会静默下载全部模型。

取消在最终替换前生效时保留原目标文件。正常关闭整个连接器也会取消在途复制；单独停止决策服务不会取消复制。强杀连接器时可能留下 `.part` 文件，当前原型不提供崩溃恢复或真实权重完整性校验。

## 平台边界

- Windows 使用受管 guardian，在启动适配器之前加入设置了 `KILL_ON_JOB_CLOSE` 的 Job Object；连接器异常退出时，guardian 通过父进程句柄观察退出并回收其 Job 内的适配器进程树。显式停止同样只处理本会话保存的受管进程，不按进程名或端口选择程序。
- macOS/Linux 使用独立 process group 与父进程退出观察器，在退出时回收受管进程组。
- 自动化使用随机端口和隔离目录；平台实测、清理验证及尚未覆盖的边界见验证文档，不把代码路径设计或 CI 结果称为未实测平台通过。
