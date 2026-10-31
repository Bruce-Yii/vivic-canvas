# DEC-01 独立决策适配器

本目录的 Python 模块是与 Vivic 核心解耦的 API/本地决策 provider 薄适配层。它只接收有限候选并返回候选 ID，不执行 Action、不访问画布、不发送答案给模型。本次 PR 另提供 TypeScript 核心接线与 `live-integration.ts` 冒烟脚本，范围和安全门控见 [接口说明](../../docs/decisions/decision-provider.md)。

## 运行

```text
py -3 -X utf8 -m unittest discover -s contrib/decision-evaluation -p 'test_*.py' -v
```

需要 Python 3.9+；非 Windows 可用 `python3` 替换 `py -3`。

`api_provider(url)` 和 `local_provider(url)` 都发送 `schema_version: vivic-decision-provider-1` 与 `input: {utterance, context, choices}`。每个候选含 `id` 和完整的 `decision`；请求不含答案标签。响应为 `choice_id`，或以候选 ID 为键的完整 `probabilities` 字典；两者同时出现时必须一致。概率必须有限、在 0–1 内且总和为 1，不接受数组、NaN、缺少候选或额外字段。聊天式响应包装必须包含 `finish_reason: stop`，但该模块仍发送适配协议请求，不负责构造通用聊天模型的 `messages`。

`accepted` 和 `usable` 只表示可用于离线候选评分。只返回 ID 时 `probabilities` 保持 `None`，不得转成 100% 信心、套用执行阈值或当成可执行 Action。即使服务返回完整概率，也需要独立校准、产品安全门控和目标校验。

凭据只从 `BENCHMARK_API_KEY`（或显式选择的环境变量名）读取，不写报告、错误正文或结果对象；原始响应不保留。端点拒绝 URL 内嵌凭据、query 和 fragment，HTTP 重定向一律拒绝，避免 Authorization 被转发。远程 API 必须使用 HTTPS；本地 provider 仅允许回环 IP 或 `localhost`。

`DecisionRouter(primary, fallback, enabled=True)` 的行为固定为：显式关闭返回 `disabled`；只有主 provider 的 `error` 或 `timeout` 才尝试回退；成功、不确定（`deferred`）、取消和关闭均直接终止。provider 抛出的异常转换为固定 `provider_error`，不复制异常正文。回退结果会保留 `fallback_after:<state>` 原因。接入核心时仍必须重新校验 Action、目标和权限。

`contract-fixtures.json` 是 Python 与 TypeScript 共用的 wire 样例；测试逐条核对请求形状及响应合法性。`choice_only` 在离线 Python 中可评分，在产品核心中应为 `deferred`，不能误当概率已经通过门控。

`urllib` 是同步传输：取消会在发请求前和读取/解析结果后检查，迟到的成功结果会丢弃，但不能即时中断正在阻塞的 socket。默认 socket 超时 2 秒，可配置为大于 0 且不超过 30 秒；该值约束单次阻塞 I/O，不是严格的总墙钟时限。读取结束后还会拒绝超过时限的响应。要求即时取消和绝对期限的产品链路使用核心异步适配器，不能把本模块的隔离测试当成真实模型或产品验收。
