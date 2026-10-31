# DEC-01 集成验证（2026-10-21）

对应 [Issue #7](https://github.com/ECdison6227/vivic-canvas/issues/7)，接口见 [decision-provider.md](../decisions/decision-provider.md)。提交分支 `codex/decision-provider` 基于主仓库 `main` 的 `ea9fbe82cfa0a64ac0ecbd86e9917931c262b54b`，在独立工作区 `G:\vivic-pr-dec01` 整理并复验，原 `G:\vivic` 的其他未提交工作完整保留。

Issue 初始范围为独立适配/评估；用户随后明确要求“集成并验证”和“上传 PR，由他在 GitHub 上确认”，因此本次增加最小核心接线和设置页启停。新增核心范围逐项见 PR 文件清单，交由维护者确认，不自行合并或部署。未改 Action 白名单、阈值、原评测数据、依赖锁文件、CI、owner 或持久化。

## PR 分支已完成的检查

| 命令/检查 | 实际结果 |
| --- | --- |
| API 目录 `node node_modules/vitest/vitest.mjs run` | 1,130 通过、3 项既有跳过；40 文件通过、2 文件跳过 |
| Web 目录 `node node_modules/vitest/vitest.mjs run` | 524 通过；57 文件通过 |
| API 定向 `vitest run tests/decision-provider.test.ts tests/decision-provider-http.test.ts` | 60/60：45 契约/安全单测 + 15 真实 loopback HTTP |
| Web `LocalDecisionSettings.test.tsx` | 4/4，已包含在全量内；provider 启停/只读、既有 Kev 准备与启停 |
| API、Web 各目录 `node node_modules/typescript/bin/tsc -b` | 均通过；等价完成两个应用的类型检查与 API 编译 |
| contracts 目录 `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | 通过 |
| API 目录 `node node_modules/tsx/dist/cli.mjs ../../scripts/generate-contract-schemas.ts --check` | 通过；生成契约无变动 |
| Web 目录 `node node_modules/vite/bin/vite.js build` | 通过，保留既有 Vite native config、WASM/浏览器 externalization、大 chunk 警告 |
| `py -3 -X utf8 -m unittest discover -s contrib/decision-evaluation -p 'test_*.py' -v` | 16/16 |
| `git diff --check` | 通过 |

工作区中的 `pnpm` 安装尝试遇到网络连接重置，未取得一次干净安装成功结果。随后以 junction 复用原工作区已安装依赖，运行上表直接 Node 命令，避免 pnpm 对 junction 的重装保护错误。两工作区 `pnpm-lock.yaml` 的 SHA-256 均为 `73590b730ac5d39915ef3df93f5a38296cbfe699cec98da0dbc19ee5d708d435`，本次不修改依赖。上述结果是本地已有依赖验证；GitHub CI 的锁定全新安装结果需单独查看，不能以本地结果代替。

原开发工作区此前全量为 Web 575 / API 1,628（另 3 跳过），包含其他未提交功能，不是本 PR 的测试数量。原评测 runner 的 9/9 和数据检查 283/283 也在原工作区完成；PR 未修改评测包，不重复宣称本分支重跑了模型基准。

HTTP 集成测试使用真实本机 socket 和合成分类响应，覆盖规则优先、合法便笺展开、歧义澄清、否定/复合/引用/模型删除拒绝、原明确删除规则、503/挂起响应回退、默认禁用后启停、生命周期鉴权、失败才 fallback、choice-only/local-chat 放弃及凭据隔离。合成响应证明程序行为，不能证明模型准确率。未删除必要测试或放宽门控。

最终复核补齐异常后的状态：非取消超时/异常为 `phase=error`，取消回到 `ready`；停止后旧请求不能覆盖禁用状态。上表 PR 全量测试已包含此修复。

## 原工作区的真实本地模型与 HTTP API 证据

本节及下一节是先前在 `G:\vivic` 完成的真实模型证据，随 PR 保留结论与哈希；未在独立 PR 工作区重跑。PR 工作区另外跑完上述合成 HTTP、契约和全量测试。以下证据路径相对于原工作区。

已校验现有 `MiniCPM5-1B-Q8_0` 和 llama.cpp b9660 的 SHA-256，并实际启动服务、核对 `/health` 与 `/v1/models`。模型/引擎版本、数据、提示、内存及原始报告哈希见 [冻结基准](../decisions/decision-evaluation-20261021.md)。无模型下载或参数训练。

`contrib/decision-evaluation/live-integration.ts` 创建独立 8788 API、随机进程内令牌和合成 `TEST-DEC-01` 上下文，不读取用户画布或模型账号。原始证据：`evidence/dec01-live-20261021/report.json`，SHA-256 `1cc199e26117686d80e8bee8456d4dbc083ffe88fb039d6a91a4ac042e8a96bc`。

| 真实检查 | 结果 |
| --- | --- |
| 本地聊天模型：展开便笺 | `expand`，438.057 ms；缺少概率，`deferred/missing_scores` |
| `/api/intent`：展开便笺 | 110.746 ms；`unknown/rules-offline`；无已连接主规划模型，未伪造展开成功 |
| 状态 | `mode=provider, lastState=deferred`，最近评分 65.015 ms |
| 停用后同一请求 | `enabled=false`，10.578 ms，保留原规则回退 |
| 停用后“十分钟倒计时” | 16.144 ms，原 `rules` 返回合法 CountdownCard envelope |

上表是单次冒烟端到端耗时，不是分位数、冷启动或模型准确率。重跑前确保 8788 空闲，保持 8790 模型服务可用并使用新的输出目录：

```powershell
pnpm --filter @vivic/local-api exec tsx ../../contrib/decision-evaluation/live-integration.ts ../../evidence/dec01-live-NEW
```

## 原评测包的固定复验

先完整开发集 231 条，再原样固定留出集 52 条；未改模型、提示、参数或金标，未择优重跑。全部请求和格式通过，完整候选正确率分别 **19.05% / 11.54%**；P50/P95 分别 195.38/232.67 ms 和 209.33/260.86 ms。留出关键边界 0/28，不支持该配置用于执行决策。

全部 choice-only，没有概率；接纳覆盖、错误接纳保持 `null/未测`，不写成零错误或 100% 安全。离线错误可执行候选为 97/26，实际未执行。未证明留出集从未被模型或既有实验接触，因此称固定留出复验。完整失败和硬件内存快照保存在上述冻结基准及 `evidence/dec01-benchmark-20261021-{dev,holdout}/`。

## PR 分支的真实浏览器

使用 Playwright CLI 驱动独立、无持久化用户资料的 Edge context，1440×1000、`--mute-audio`、不授予麦克风；TTS 未开启。测试 API8788/Vite5174 仅用于本轮，未触碰用户日常服务及真实画布。

实际打开独立 PR 工作区的 `/control`，确认空画布、provider 标题、未启用状态、隐藏 Kev 下载/清理控件；点击启用后按钮与状态切换，再点击停用恢复未启用。默认深色主题与切换浅色后均核对设置区文案与按钮。没有发送模型查询或音频。Console 为 0 error / 0 warning；开发提示不计错误。

截图已目视核对，控件和说明无裁切；仅截取决策设置区，不含个人数据或凭据。原始快照/截图保留在原工作区 `output/playwright/dec01-pr-preview/`，本 PR 附以下脱敏预览：

- 启用截图：[enabled.png](decision-provider-preview/enabled.png)。
- 停用截图：[disabled.png](decision-provider-preview/disabled.png)。
- 浅色停用截图：[disabled-light.png](decision-provider-preview/disabled-light.png)。
- 对应原始页面快照：`enabled.yml`、`disabled.yml`、`light.yml`。

这次浏览器覆盖设置启停和当前深浅配色；完整画布模型操作由 HTTP 合成响应验证，未宣称真实 MiniCPM 自动展开成功。超时/错误状态由 API 测试覆盖，本次未另做浏览器错误注入、任意长内容、移动端、多浏览器或全部配色验收。

## 边界与最终复核

配置 URL 后默认启用入口，无配置保持旧 Kev 行为；本轮测试实例从显式关闭开始。`local-chat` 保持观察与回退，真实模型效果未达标，未启用为用户的自动动作决策器。尚未验证真实远程 API/评分桥、JevHarness、冷启动加载时长、独立 GPU 峰值；xlz 原始测试未收到。上述未测项均未用假服务或离线基准替代。

最终交付以本文件第一节的 PR 分支全量测试、类型、契约与构建结果为准。真实模型基准只是保留的历史实测，不证明当前配置适合自动执行。维护者仍需确认新增核心范围、真实评分服务选型和未测指标；本阶段使用 `Refs #7`，不自动关闭 Issue。

本机原始 `evidence/`、模型缓存和浏览器产物保留且不入 Git；本 PR 仅附上述三张脱敏区块截图。已关闭本轮独立浏览器和 API/Vite 进程，原模型 PID 29172 已在先前实测结束后关闭。没有停止用户原有进程或删除本机证据。
