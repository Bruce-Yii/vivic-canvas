# Laya multilingual 本机决策 PoC

2026-10-15。状态 **MEASURED / NO_GO / MODEL_OR_ADAPTER_UNCERTAIN**：M1 / 8 GiB 已完成 CPU、MPS 各 108 次真实推理，当前组合不接入生产。首轮 action+target 同时正确均为 **5/36（13.9%）**；热调用中位数/P95：CPU **545.6/922.0 ms**，MPS **436.9/539.7 ms**。追加官方 sanity 仅 1/2，与文档不完全一致，因此模型/运行时/适配不确定性仍存在，不能将低分完全归因于 Vivic 任务，也不能推断 Laya 整体能力。完整事实及失败样例见 [本机报告](../evidence/phase2-decision/REPORT.md)。未使用上游跑分替代本机结果。

本轮只写 `scripts/laya-poc/**`、本文件、`evidence/phase2-decision/**` 和 `.gitignore` 的一条 cache 忽略；授权缓存放在 `.cache/laya-poc`。没有修改 app/API/web/package 锁，没有启动或停止服务、访问 `.env`/Key、录音或发声。生产仍沿用已有路径。

## 已核实的身份、来源与接口

- 原项目是 [NandhaKishorM/laya](https://github.com/NandhaKishorM/laya/tree/432312b36714d8889eba405507b37eda25257d9c)，固定 commit `432312b36714d8889eba405507b37eda25257d9c`，代码版本 0.4.7，源码 [Apache-2.0](https://github.com/NandhaKishorM/laya/blob/432312b36714d8889eba405507b37eda25257d9c/LICENSE)。不是 Llama；它用编码器和决策头为有限候选打分。
- 官方 [convaiinnovations/laya-multilingual 模型卡](https://huggingface.co/convaiinnovations/laya-multilingual/blob/1720e3e3357cfe1e281542e223f8273b0890ca34/README.md)，固定 revision `1720e3e3357cfe1e281542e223f8273b0890ca34`，标注 Apache-2.0。基于 mmBERT-base；本机参数计数 **321,908,995**。全部所需模型/配置/分词器文件 **678,211,120 bytes**，其中 safetensors **643,835,514 bytes**。逐文件尺寸和 SHA-256 在 [artifacts.lock.json](../scripts/laya-poc/artifacts.lock.json)。
- 实际 Python API 是 `laya.load(local_directory, device="cpu"|"mps", fast=False, compile=False, backend="eager")`，然后 `agent.predict(state, questions, max_len=1024, head_max_len=384)`。`questions` 为包含 `type="choice"`、`instructions`、`criteria={候选ID: 描述}` 的字典；读取 `result["answers"][问题ID]["choice"]` 和 `probabilities`。参考 [固定版本 agent.py](https://github.com/NandhaKishorM/laya/blob/432312b36714d8889eba405507b37eda25257d9c/laya/agent.py)。不是普通文本生成接口；`Router` 是 checkpoint 路由，不等于 Vivic 的意图路由。
- 没有运行 Hub 内的 Python 或安装上游 setup 脚本。固定源码下载后审查本地加载/推理路径，校验源码哈希再通过本地 import 使用；权重仅 safetensors。模型 config 为内建 ModernBERT，无 `auto_map`。推理进程设离线模式并用 Python audit hook 拒绝网络连接；没有 hooks、MCP、HTTP server、训练、系统工具或编程工具。审查细节见 [source-review.md](../evidence/phase2-decision/source-review.md)。

## 下载与复跑

从仓库根目录执行；需要 `uv`、联网下载和 macOS arm64。首次准备不自动推理、不起服务。脚本限定这一款已审查模型；没有 Winnow 大权重下载入口。

```sh
python3 scripts/laya-poc/prepare.py
python3 scripts/laya-poc/run.py --device both --timeout 240
python3 scripts/laya-poc/verify.py
.cache/laya-poc/venv/bin/python scripts/laya-poc/sanity.py
python3 scripts/laya-poc/summarize.py
```

本机默认 `python3` 是 3.9.6，现有 Torch 2.8.0 在该解释器的 user-site 中；它与 Python ≥3.10 环境的二进制 ABI 不兼容。因此本次通过 `uv` 创建独立 **Python 3.11.13**，在 `.cache/laya-poc/venv` 安装固定依赖；没有全局 pip 修改、卸载或替换任何已有包。依赖为 Torch 2.8.0、Transformers 4.57.6、Hub 0.36.2、Safetensors 0.6.2、NumPy 2.2.6、psutil 7.1.0，全部传递依赖精确版本在 [requirements.lock](../scripts/laya-poc/requirements.lock)，仅安装二进制 wheel。复用系统包方案仅适用于兼容的 Python，当前机器不满足。

权重、源代码、约 118.93 MB 的依赖 wheel、uv 日志所示约 18.1 MiB 的 Python 下载，主体下载合计约 **0.824 GB**，低于 1.5 GB；这是核实的 artifact 大小加 Python 日志估算，未抓包计算 HTTP 元数据/重试。下载清单见 [dependency-downloads.json](../evidence/phase2-decision/dependency-downloads.json)。磁盘展开占用与下载量不同。模型逐文件验 hash，成功的缓存会复用；下载失败会删除未完成的单文件，下次重试该文件，不支持 HTTP 断点续传。

缓存位置可配置，两条命令使用同一目录；准备脚本的 `--model` 目前只接受 `laya-multilingual`。版本由审查后的 lock 固定，更换版本需要重新核实接口、许可证和文件哈希，不静默跟随 main。

```sh
python3 scripts/laya-poc/prepare.py --cache-dir /path/to/laya-cache --model laya-multilingual
python3 scripts/laya-poc/run.py --cache-dir /path/to/laya-cache --device cpu --timeout 240
```

可单独用隔离解释器运行 `benchmark.py --device cpu|mps --run-id 自定义英文ID` 保存新一组证据；直接调用没有外部总时限，日常复跑优先 `run.py`。默认复跑会覆盖同名 cpu/mps 证据，保留历史时先用不同 run-id 或复制证据。`verify.py`/`summarize.py`针对默认的两设备、三轮协议；自定义次数/设备需要另行汇总，不能冒充完整协议通过。

准备失败返回退出码 2，并将准确原因写入 `evidence/phase2-decision/prepare.json` 的 `BLOCKED`；单文件下载总时限 300 秒、网络读超时 60 秒、每次 uv 操作上限 300 秒。`run.py` 为每个设备设置 240 秒总时限；缺依赖、设备不可用、进程失败/超时会落盘 `BLOCKED`。进程采样 RSS 超过 3 GiB 会停止；不自动扩大内存限额或改跑其他设备。该 RSS 限额不覆盖所有 Metal/系统内存，不能当作完整内存保护。本次没有触发这些 BLOCKED 条件。

## 评测边界与后续门槛

[cases.json](../scripts/laya-poc/cases.json) 使用现有 `CanvasContext` 数据结构的合成画布；三张提醒分别喝水/取茶/吃药，剩余 300/490/780 秒，另有待办、便签及 DEMO 搜索卡。另测 470/500 秒双近似对象、空画布和一条卡片内容注入。两道 choice 独立选择 action/target；没有主 LLM、规则替代模型或真实工具调用。预先固定用例/期望，不将期望标签输入模型；没有训练或校准。这是 36 条小型工程诊断集，不代表一般中文能力；低分也不能推断任何改写或微调方案必然失败。

本机原顺序恢复后结果稳定，但翻转卡片和动作候选顺序后 **30/36** 改变。全部 216 次输入状态无截断；额外 tokenizer 诊断确认候选无 token 碰撞，未触发选项预算压缩。高概率仍可能选错。说明性 gate 的保护效果单列，未计入模型准确率；其中仍有错误聚焦候选，gate 的否定、复合指令和更新时长语义也未完整覆盖，禁止复制到生产。

追加的 [official-sanity.json](../evidence/phase2-decision/official-sanity.json) 原样运行固定模型卡印地语退款例子和原仓库西班牙语技术问题例子：前者期望 billing，实际 sales=0.5811（billing=0.4168；refund noul=0.9597），后者 technical=0.9894 正确。sanity 返回码 2/状态 MISMATCH，表示未完全复现官方示例，不是下载受阻。检查确认 `question` 不是 `instructions` 的别名，PoC 字段符合真实接口；head/编码器/词表与 checkpoint 严格匹配，tokenizer 派生 JSON 与上游原转换一致，4.x RoPE 两个 base 均正确映射为 160000。尚未与官方参考运行栈比对数值，结构一致不等于端到端适配已经证明正确。原冻结 cases/阈值/216 条记录未改、未重跑；sanity 未挑选重跑。

接入前先解决官方 sanity 的参考运行栈复现/数值一致性，再要求：独立至少 200 条中文留出集联合准确率 ≥95%；歧义/无目标/否定/复合删除误执行为 0；顺序一致率 ≥99%；独立概率校准；本机共存环境热 P95 ≤500 ms、启动至首结果 ≤10 秒，并完成 30 分钟浏览器/PTT 共存的内存与服务劣化检查。当前样例准确率、顺序稳定性和冷启动均未达标，暂不把下载器扩展成产品设置或接入生产决策层。未来的安全适配器、schema/真实目标校验、加载/卸载策略及 StepFun 回退需单独验收。

**Winnow 未下载、未运行、不支持本轮接入；未来可配置选择需求仍保留。** 本 PoC 的新建仅判断意图，不承担多提醒内容/时长抽取；搜索仅判断意图，不证明搜索后端可用。主线程 PTT/STT、搜索及其他服务的验收结果由各自报告负责。
