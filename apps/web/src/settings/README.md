# 模型平台设置（Model Platform Settings）

让用户自带模型服务（BYO）：选预设或填自定义 Base URL + Key，点「获取模型」从平台拉取模型列表并选择，测连接、保存、按角色分配。

## 现状

**已集成**：渲染在 `/control` 设置页 →「连接」分组，位于原有 StepFun / GPT 连接面板下方（`apps/web/src/control/ControlApp.tsx` 的 `renderPanels` 里，`connections` 槽位）。原有 StepFun 界面与默认行为不变。

## 组件

```tsx
import { ModelPlatformSettings } from "@/settings";

<ModelPlatformSettings
  disabled={readonly || !snap.ready}
  onConnectionChange={(connected) => { /* 可选 */ }}
/>
```

## 后端端点（`apps/local-api/src/providers/`）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/providers/presets` | 预设目录（平台名、Base URL、鉴权方式、默认模型） |
| GET | `/api/providers` | 已保存平台 + 连接状态（**不含 Key**，只给掩码提示） |
| POST | `/api/providers` | 新建 |
| PATCH | `/api/providers/:id` | 修改（`clearApiKey: true` 清除 Key） |
| DELETE | `/api/providers/:id` | 删除 |
| POST | `/api/providers/:id/test` | **真实推理**探针（不是 /health） |
| POST | `/api/providers/:id/models` | 代理 `GET {baseUrl}/models`，解析 `data[].id` 并分类 |
| POST | `/api/providers/preview/test` | 未保存配置的探针（UI 里"先测后存"） |
| POST | `/api/providers/preview/models` | 未保存配置的模型发现 |

旧的 `/api/providers/status|select|model` 保持原样、优先匹配，老客户端不受影响。

## 协议

| 协议 | 请求形状 | 典型模型 |
|---|---|---|
| `openai-compatible` | `POST {base}/chat/completions` | GPT / DeepSeek / Qwen / 本地 vLLM、Ollama、LM Studio |
| `stepfun-v1` | 同上，`https://api.stepfun.com/v1` | StepFun 普通 API Key |
| `stepfun-plan` | 同上，`https://api.stepfun.com/step_plan/v1` | 需 Step Plan 订阅 |
| `startlux-native` | `POST {base}/decisions` + `{state, questions}` | `startlux-decision-4b` |
| `legacy-2b` | `POST {base}/decisions` + `{input, labels}` | `startlux-decision-2b`、GLiNER、Laya |

**4B 与旧协议、2B 与原生协议在保存/测试前就被拒绝**，并给出明确原因——这正是"本地模型连不上"的真正根因（同一端点混两套协议），不允许再配出这个组合。

## 安全

- Key 用 AES-256-GCM 加密后写入 `providers.json`（文件 0600，密钥在同目录 `.secret-key`，0600）。本地模式目录为 `~/.vivic`；线上模式为部署数据目录（`VIVIC_PROVIDER_DATA_DIR`，未设时用 `VIVIC_SPACE_DATA_DIR`）。
- API 响应永远不含 Key，只给 `hasApiKey` 与 `apiKeyHint`（如 `2v0U••••T4Bb`）。
- Key 不进日志、不进测试 fixture；测试用注入的假 codec 与内存文件系统。
- 线上模式（`mode: "online"`）默认持久化；没有提供数据目录时保持内存 store（测试/误调用不会碰宿主机 home）。`VIVIC_PROVIDER_PERSIST=off` 可显式关闭线上持久化。

## 线上部署种子

服务器环境变量可直接注入 StepFun Key，应用启动时把它变成一条普通的 `roles: ["main"]` 平台（`StepFun (seed)`），之后由设置接管：

| 变量 | 必填 | 默认 |
|---|---|---|
| `VIVIC_STEPFUN_API_KEY` | 是（不设则不种子） | — |
| `VIVIC_STEPFUN_BASE_URL` | 否 | `https://api.stepfun.com/v1` |
| `VIVIC_STEPFUN_MODEL` | 否 | `step-3.5-flash` |

- 只在 store 没有任何 `main` 平台时创建一次；已有平台不覆盖，设置优先于 env。
- Key 只从进程 env 读取，交给 store 加密，不写日志、不进响应。
- 回滚：删除这条种子平台，或去掉 env 后重启。

## 设置优先于 env

存在 `roles: ["main"]` 的平台时，它覆盖 `VIVIC_MAIN_PROVIDER` / `DEEPSEEK_API_KEY` 的主模型 Key、模型与 Base URL；存在 `roles: ["decision"]` 时覆盖 `VIVIC_DECISION_*`。**没有保存任何平台时行为与原先完全一致。**

## 测试

```bash
pnpm --filter @vivic/local-api test tests/providers.test.ts tests/provider-routes.test.ts
pnpm --filter @vivic/web test src/settings
```

真实验证脚本（一次性、不提交）：`work/verify/mock-provider.mjs`、`work/verify/mock-gateway.mjs`。
