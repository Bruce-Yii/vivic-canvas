# DEC-01 固定候选基准复验（2026-10-21）

Issue：[DEC-01 #7](https://github.com/ECdison6227/vivic-canvas/issues/7)。本文件先于正式评测写入冻结配置，随后只补实际结果，不根据开发集修改模型、引擎、提示、阈值或数据。

证据来源：以下实测在原开发工作区 `G:\vivic` 完成，原始文件仍保留在该工作区；本文随独立 PR 迁移，未在 PR 工作区重跑模型基准。PR 基于 `ea9fbe8`，没有修改原评测包、提示或数据。PR 分支的单测、构建和浏览器验证单独记录在 [验证记录](../verification/decision-provider.md)，不能与本轮模型指标混算。下文进程号是历史记录，模型进程已在评测结束后关闭。

## 冻结配置

- 模型标识：`MiniCPM5-1B`；本机 `llama-server` 进程 `29172`，端点 `http://127.0.0.1:8790/v1/chat/completions`。
- 模型文件：`MiniCPM5-1B-Q8_0.gguf`，`openbmb/MiniCPM5-1B-GGUF` revision `3d55fac80935ae6456986ad2384b5cbcc4d6c948`，`1,153,529,216` 字节，SHA-256 `0dc7638539067268774c275a14a6ec9c7e01f7eeb2cff606c8590361fa527e4c`。
- 引擎：`.cache/minicpm5/runtime/llama-b9660-vulkan/llama-server.exe`，版本 `9660 (7dad2f1a1)`，Clang `20.1.8` / Windows x86_64，SHA-256 `30181acd93201040b8d3ae36032015250ed3577c6270a60317e4b813f4f83a24`；设备 `Vulkan1: NVIDIA GeForce RTX 4060 Laptop GPU`。模型及引擎清单保存在 `.cache/minicpm5/model-manifest.json`。
- 主线程已核对模型和引擎文件哈希并完成真实连通冒烟，记录在 `evidence/dec01-live-20261021/report.json`；本文件中的基准只调用该已启动服务，不下载、修改或停止模型。
- 协议 `chat`，temperature `0`，max_tokens `128`，timeout `10` 秒，repeat `1`，每集 warmup `1`；沿用原脚本 seed `20261016`、threshold `0.8`、margin `0.25`。
- Python `3.14.2`，以 `py -3 -X utf8` 运行；仅在评测进程环境中移除 `BENCHMARK_API_KEY`，不读取/打印已有值，不修改环境文件。
- 开发集完整 `231` 条后原样运行固定留出集 `52` 条。历史上本模型是否接触过该留出集无法证明，因此称“固定留出复验”，不称新未见测试或中文泛化验收。
- 两个输出目录开跑前均不存在：`evidence/dec01-benchmark-20261021-dev/`、`evidence/dec01-benchmark-20261021-holdout/`。保留首轮全部输出和失败，不覆盖、不择优重跑。

冻结文件 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `scripts/decision-model/portable-benchmark/dataset.json` | `f4a1ddaf4f4bc78fdfe5f3640ab13ab2c76d5502653d9c43cbb7d8e040ee37cf` |
| `scripts/decision-model/portable-benchmark/system-prompt.md` | `580c4c62e83b6eed7e714651d67eda7f1d352f04147e0f16c4d038d46089c895` |
| `scripts/decision-model/portable-benchmark/run.py` | `888efdca6e09a5d8cdb937a610326de443619d9bda3302b4fbdff971b7780fcd` |

报告中的 `system_prompt_sha256=ea8fb0fa9b50c343071ab0f6cd6f0fe104f134332abdb584e7669bf9ba840724` 是脚本按文本读取并将 CRLF 规范化为 LF 后实际发送内容的哈希；上表是磁盘原始字节哈希。已重新计算 LF 文本哈希并确认一致，两次运行前后上述三个磁盘文件哈希均未变。

## 复现命令

仓库根目录，PowerShell；先开发集再留出集，两次运行间不调参：

```powershell
Remove-Item Env:BENCHMARK_API_KEY -ErrorAction SilentlyContinue
py -3 -X utf8 scripts/decision-model/portable-benchmark/run.py --protocol chat --url http://127.0.0.1:8790/v1/chat/completions --model MiniCPM5-1B --timeout 10 --max-tokens 128 --repeat 1 --warmup 1 --split dev --output evidence/dec01-benchmark-20261021-dev
py -3 -X utf8 scripts/decision-model/portable-benchmark/run.py --protocol chat --url http://127.0.0.1:8790/v1/chat/completions --model MiniCPM5-1B --timeout 10 --max-tokens 128 --repeat 1 --warmup 1 --split holdout --output evidence/dec01-benchmark-20261021-holdout
```

实际执行时先检查各输出目录不存在；复现者应另选全新目录，不覆盖本轮证据。

## 实际结果

开发集和留出集首次运行均 exit `0`，仅表示流程与格式通过，不表示选型达标。本轮结论为 **不支持将该配置用于执行决策**：开发集完整正确率只有 19.05%，固定留出复验只有 11.54%，留出关键边界题 0/28；离线输出中的错误可执行候选数分别为 97 与 26。这是候选选择错误，不是实际执行错误；没有实际执行任何模型动作。

| summary 指标 | 开发集 | 固定留出复验 |
| --- | ---: | ---: |
| `samples` | 231 | 52 |
| `valid_predictions` | 231 | 52 |
| `errors` | 0 | 0 |
| `exact_accuracy` | 44/231 = 19.047619% | 6/52 = 11.538462% |
| `route_accuracy` | 92/231 = 39.826840% | 16/52 = 30.769231% |
| `target_accuracy` | 32/76 = 42.105263% | 7/24 = 29.166667% |
| `target_samples` | 76 | 24 |
| `wrong_execution_choices` | 97 | 26 |
| `critical_samples` | 99 | 28 |
| `critical_accuracy` | 15/99 = 15.151515% | 0/28 = 0% |
| `probability_samples` | 0 | 0 |
| `simulated_accepted` | null，未测 | null，未测 |
| `simulated_precision` | null，未测 | null，未测 |
| `simulated_wrong_execution_choices` | null，未测 | null，未测 |
| `simulated_coverage` | null，未测 | null，未测 |
| `eligible_samples` | 143 | 28 |
| `eligible_exact_accuracy` | 29/143 = 20.279720% | 5/28 = 17.857143% |
| `latency_samples` | 231 | 52 |
| `latency_success_samples` | 231 | 52 |
| `latency_all.p50_ms` | 195.376900 | 209.330800 |
| `latency_all.p95_ms` | 232.665400 | 260.860300 |
| `latency_all.p99_ms` | 411.431300 | 282.432300 |
| `latency_success.p50_ms` | 195.376900 | 209.330800 |
| `latency_success.p95_ms` | 232.665400 | 260.860300 |
| `latency_success.p99_ms` | 411.431300 | 282.432300 |
| 预热 HTTP 耗时（不进上述分位数） | 547.886400 ms | 574.384300 ms |

其中 `latency_success` 的“成功”只指请求和格式无错误；不能理解为语义正确样本。HTTP 时延包含序列化、排队、网络与推理，不等于纯 GPU 推理；远程 API 时延未测。模型全部返回 `choice_id`，没有候选概率，故接纳覆盖、接纳精度、错误接纳均保持 null，而不是零错误或 100% 安全。

留出集保留的失败示例包括 `V162/weather-condition`、`V144/missing-time`、`V042/expand-ambiguous`，均输出错误可执行候选；`V039/expand-ambiguous` 也未选中正确澄清候选。完整分类分项、混淆表、候选选择和所有失败均见各 `report.json`，未改用例、未移除失败、未重跑择优。

独立集成冒烟记录 `evidence/dec01-live-20261021/report.json` 显示，真实模型的 choice-only 输出在 provider 中因 `missing_scores` 进入 `deferred`，没有绕过门控。无主模型连接的合成 `TEST-DEC-01` 上下文随后返回 `rules-offline` 未知请求；关闭 provider 后仍返回规则回退，普通“十分钟倒计时”保留 `rules` 路由。该记录只证明对应真实 HTTP 集成路径和回退行为，不补充本基准未测的接纳精度或浏览器交互证据。

进程 `29172` 工作集快照（字节）：

| 时点 | WorkingSet64 | PeakWorkingSet64 |
| --- | ---: | ---: |
| 基准开始前 | 1,103,556,608 | 1,596,162,048 |
| 两集完成后 | 9,153,441,792 | 9,206,108,160 |

峰值是 Windows 报告的整个进程生命周期峰值，包含此前启动和冒烟，不是独立测得的冷启动内存或 GPU 显存峰值。服务未出现可见 OOM，但本轮未进行系统/显存持续采样，不能据此声明设备容量验收通过。冷启动加载时间未测。

证据文件 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `evidence/dec01-benchmark-20261021-dev/report.json` | `5a45d715d10aacbbe8c92df7a53c25e54307cfbe2577450e8d6a33caaac51ebb` |
| `evidence/dec01-benchmark-20261021-dev/results.csv` | `ff9c0d2ce0da1fefb5cda06f445f5b0b98008169ff90eb4fa83b3494747c46cd` |
| `evidence/dec01-benchmark-20261021-holdout/report.json` | `c43aced88c067b0a4b4f7f36526b7834362cec008fb4f461492cf4fb3d0e7289` |
| `evidence/dec01-benchmark-20261021-holdout/results.csv` | `2ee7416e7de7fe437f8f794f50936f798c82e3bcb1163ebd2ac4ea5753b3ad98` |

`evidence/` 按仓库规则不入 Git，原文件保留本机；本摘要可随任务提交，但不能用摘要取代原始记录。

## 解释边界

这是合成画布和完整候选的封闭选择任务，模型输入不含金标；候选正确不等于任意参数抽取、真实资料检索或可执行 Action 正确。程序没有执行模型动作，也没有写用户真实画布。API 远程路径、产品浏览器交互、冷启动时间和 GPU 峰值未测。概率门控指标只有模型提供规范化全候选概率时才有意义；choice-only 不补造概率，不把未测写成 0 或 100%。
