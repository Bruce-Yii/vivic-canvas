# DEC-01 决策 provider 接口与核心集成

对应 [Issue #7](https://github.com/ECdison6227/vivic-canvas/issues/7)。用户于 2026-10-21 明确要求“集成并验证”，因此在独立适配层之外完成最小核心接线；未改 Action 白名单、阈值、原评测数据或既有 Kev 路径。实际证据见 [验证记录](../verification/decision-provider.md) 和 [冻结基准](decision-evaluation-20261021.md)。

## 行为与门控

未配置 provider 时保留原 Kev 行为。配置后默认启用，可通过环境变量初始关闭，也可在设置页启停。确定规则仍优先；未被已有路由处理的指令才经过决策服务，再回到原规划/澄清流程。

服务只能输出有限候选评分，不能输出或执行 Action、代码、工具参数。只有完整评分通过原有 `0.8` 最高分、`0.25` 分差及语义保护后，核心才继续解析目标并校验 `ActionEnvelopeSchema`。否定、复合、引用、危险操作仍拒绝；歧义目标仍澄清；模型选择 `delete` 不会执行删除。原先明确删除指令的规则行为保持不变。

仅返回 `choice_id` 时，产品状态为 `deferred/missing_scores`，不会补造 one-hot 概率或执行许可。远程生成模型自报“信心”也不能视作经过校准的候选评分；桥接服务的评分来源需单独验收。

## 固定 wire 契约

请求内容如下，包含全部七个候选；不含金标、凭据、图片或用户画布内容。本次核心只发送原话，`context` 固定为空，目标由核心后续解析。

```json
{
  "schema_version": "vivic-decision-provider-1",
  "request_id": "生成的 UUID",
  "input": {
    "utterance": "展开便笺",
    "context": {},
    "choices": [
      { "id": "fit", "decision": { "intent": "fit" } },
      { "id": "restore", "decision": { "intent": "restore" } },
      { "id": "focus", "decision": { "intent": "focus" } },
      { "id": "delete", "decision": { "intent": "delete" } },
      { "id": "expand", "decision": { "intent": "expand" } },
      { "id": "collapse", "decision": { "intent": "collapse" } },
      { "id": "other", "decision": { "intent": "other" } }
    ]
  }
}
```

响应可以只给候选，或给完整评分。以下评分仅是合约示例，不是实测模型输出：

```json
{
  "choice_id": "expand",
  "probabilities": {
    "fit": 0.01, "restore": 0.01, "focus": 0.01,
    "delete": 0.01, "expand": 0.94, "collapse": 0.01, "other": 0.01
  }
}
```

wire 使用 ID 字典，拒绝数组、NaN、负值、缺失/多余候选、额外顶层字段及候选与最高分冲突。所有概率必须有限、在 0–1 内，总和与 1 的差不超过 `0.0001`。数组仅用于核心内部原有 `score(): Promise<number[] | null>` 契约。

状态为 `accepted/deferred/error/timeout/cancelled/disabled`。TypeScript 的 `accepted` 表示通过评分与原语义保护，尚不代表目标合法或已执行；独立 Python 的 `accepted/usable` 只表示离线可评分，choice-only 的概率仍为 `None`。两者通过 `contrib/decision-evaluation/contract-fixtures.json` 核对 wire 一致性，不能混用状态语义。

## 失败、关闭和隔离

只有 `error/timeout` 尝试本地 fallback；`deferred/cancelled/disabled` 不换模型强行决策。每次 HTTP（含响应体）默认 2 秒，配置有效上限 10 秒；管理器总预算为两次额度，最多 20 秒，并受原请求总时限约束。即使注入传输忽略 AbortSignal，调用也按预算退出。单次只允许一个在途评分，输入最多 500 字符；响应最多 32 KiB。

停用会取消在途请求并增加代次，迟到结果不得恢复状态；用户取消和主模型会话切换后也丢弃旧结果。错误只返回固定原因，不记录输入、原始响应或令牌。HTTP 禁止重定向及 URL 凭据/query/fragment；本地服务仅允许 loopback，远程 API 必须 HTTPS。远程凭据由进程环境提供，只发送给主评分桥，不传给 fallback。

`/api/decision/status|enable|stop|prepare|clear` 继续受现有 API 鉴权保护。provider 模式增加 `mode: "provider"` 和 `lastState`，原有字段保留；`phase: ready` 仅表示请求入口启用，不代表健康探测通过。`lastMs` 包含管理器端到端等待，`bytes/gpuBytes=0` 表示此管理器不加载模型，不可用作外部服务内存指标。

设置页在 provider 模式显示服务启停，隐藏 Kev 下载和缓存清理。`prepare` 不做模型操作；`clear` 只停用 provider。停用请求入口不会结束外部模型进程或释放它的显存。

## 配置与复现

配置项：`VIVIC_DECISION_PROVIDER_URL`、`KIND=api|local`、`ENABLED=false`、`TIMEOUT_MS`、`PROTOCOL=adapter|local-chat`、`MODEL`、`TOKEN`，均以 `VIVIC_DECISION_PROVIDER_` 为完整前缀。可选 `FALLBACK_URL` 固定指向本地 **adapter** 协议桥；不能直接填写聊天端点。TOKEN 只用于已配置评分桥，不新增 StepFun/GPT 之外的通用对话 provider，不写入文件或浏览器。

本机已有 MiniCPM 模型时，可在独立测试 PowerShell 进程运行：

```powershell
$env:PORT='8788'
$env:VIVIC_PREFERENCES='off'
$env:VIVIC_DECISION_PROVIDER_URL='http://127.0.0.1:8790/v1/chat/completions'
$env:VIVIC_DECISION_PROVIDER_KIND='local'
$env:VIVIC_DECISION_PROVIDER_PROTOCOL='local-chat'
$env:VIVIC_DECISION_PROVIDER_MODEL='MiniCPM5-1B'
$env:VIVIC_DECISION_PROVIDER_ENABLED='false'
pnpm --filter @vivic/local-api dev
```

另开测试进程，设置 `VIVIC_LOCAL_API=http://127.0.0.1:8788`，运行 `pnpm --filter @vivic/web dev --port 5174 --strictPort`，访问 `/control`。需事先启动已校验模型服务；本配置不下载模型、不修改用户日常服务。退出上述进程即结束本次配置。

`local-chat` 只在 loopback 启用，用指定模型、temperature 0、128 tokens、非流式聊天协议读取最终 `choice_id`；拒绝工具调用、截断回答和生成式概率。它用于真实连通与安全回退验证，当前 MiniCPM choice-only 不会直接产生画布动作。真正使用候选评分执行的桥接路径已用合成 HTTP 服务验证，真实评分服务及远程 API 尚未验收。

JevHarness 未确认为具体可运行模型/项目，不是运行时依赖；xlz 的既有测试未收到。本次不据框架开源推断模型可用，也未引入 coding tools、任意代码执行、发布或部署。
