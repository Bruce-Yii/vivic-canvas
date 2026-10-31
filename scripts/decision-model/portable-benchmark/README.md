# Vivic 决策模型测试包

把这个目录或压缩包发给测试同学即可。测试不依赖 Vivic、Node、Pi 登录、StepFun Key、麦克风或浏览器；需要 Python 3.9+，以及同学自己能运行的模型/推理服务。不自动下载模型，不执行候选动作。

本版日期：2026-10-16。283 条合成用例、69 个语义家族。默认开发集 231 条，留出集 52 条，同一家族的同义表达不会跨集。覆盖视图、语义目标、条目、提醒、日期时区、条件提醒、天气/搜索/表格/图表分流、交流、否定、歧义、复合指令、澄清续答与非可信内容。

## 要测什么

每条输入都有固定合成画布，以及若干完整的候选决定。模型选择其中一个。比如“删除13分钟的计时器”需要选对删除意图和目标；“不要删除待办”应不执行；“上海现在多少度”应选真实天气工具，而不是编造温度。

候选形如：

```json
{"id":"C03","decision":{"route":"local_action","intent":"card.focus","target_ids":["timer-13"],"slots":{}}}
```

期望模型只返回 `{"choice_id":"C03"}`，或由原生评分适配器返回所有候选的概率。每题候选顺序已打乱，答案和判定说明不会发送给模型。

**这是有限候选的语义选择测试。** 它可以验证不同说法是否对应同一意图、目标、参数和分流，不能证明模型能自由抽取任意时间/内容、生成合法 ActionEnvelope、完成实际联网或运行整个产品。候选里的参数属于题目给定选项；猜对选项不等于开放抽取成功。“速度更快”也要在同机、同输入上实测。

`local_action` 等字段是本测试的语义标签，**不是新的 Vivic API 或 Action 契约**。如 `note.expand` 最终应由程序映射为合法 `card.update.variant` 与 `canvas.fit`，不能直接发给 reducer。

## 最快开始

在解压后的目录打开终端。macOS/Linux 下使用 `python3`；Windows 可把命令中的 `python3` 换成 `py -3`。无需 pip install。

先检查资料和脚本：

```sh
python3 run.py --check-data --split all
python3 -m unittest -v test_runner.py
```

单元测试用假的本地 HTTP 服务验证统计和传输，不会调用模型；通过不能算模型通过。Windows若弹出本地Python网络提示，这仅来自该回环假服务；也可先只运行数据检查。

### 方式一：模型服务支持聊天式 HTTP 接口

先在自己的推理工具里加载模型、启动服务，确认模型 ID 和接口地址。以下是接口形状示例，端口和模型 ID 都要替换为自己服务的真实值；测试包不负责安装或启动服务。

先抽 20 条开发集检查连通与输出格式：

```sh
python3 run.py --url http://127.0.0.1:8000/v1/chat/completions --model YOUR_MODEL_ID --limit 20 --output results/smoke
```

完整开发集，重复 3 次；每个模型用新的输出目录：

```sh
python3 run.py --url http://127.0.0.1:8000/v1/chat/completions --model YOUR_MODEL_ID --split dev --repeat 3 --machine-label "CPU GPU RAM quantization" --output results/model-a-dev
```

冻结提示词、模型参数和阈值后，再测留出集：

```sh
python3 run.py --url http://127.0.0.1:8000/v1/chat/completions --model YOUR_MODEL_ID --split holdout --repeat 3 --output results/model-a-holdout
```

URL 是完整 POST 地址，脚本不追加路径。请求发送 `model/messages/temperature=0/max_tokens=128/stream=false`，读取 `choices[0].message.content` 中的 JSON。支持 `--timeout 30`、`--max-tokens 256`、`--warmup 1`。如果服务对推理模型另有参数要求，使用方式二的薄适配器，不把内部推理冒充最终答案。无格式约束时输出了Markdown或解释也会记为格式错误。

如果同学的本地服务要求凭据，只从运行进程的 `BENCHMARK_API_KEY` 环境变量读取，不把凭据写入文件、命令参数或返回报告；不需要 Vivic 的认证信息。远程服务同样可测，但网络耗时应与本地测试分开。

### 方式二：原生 choice/score 决策模型

不要求 Kev、Winnow 或其他模型原生支持聊天接口。先导出无答案输入：

```sh
python3 run.py --export-inputs results/dev-inputs.jsonl --split dev --repeat 3
```

同学用模型官方的 choice/score 调用方式，逐行处理 `system`、`input.utterance`、`input.context`、`input.choices`。必须把上下文、所有候选及其完整 decision 提供给模型，候选 ID 与分数一一对应。不要只对动作动词打分，也不要丢掉目标/参数。原生库所需封装取决于同学实际使用的服务版本，本包不假装三种模型有相同 API。

将结果存为 JSONL，每条格式如下：

```json
{"case_id":"V001","repeat":1,"choice_id":"C03","roundtrip_ms":18.2}
```

`C03` 仅为格式示例，请写实际输出。`roundtrip_ms` 可省略，不能用假数值补齐。若模型能给出每个候选的规范化概率，改为：

```json
{"case_id":"V001","repeat":1,"probabilities":{"C01":0.01,"C02":0.01,"C03":0.94,"C04":0.01,"C05":0.01,"C06":0.01,"C07":0.01},"roundtrip_ms":18.2}
```

候选个数以当题为准，必须覆盖所有 ID，概率须有限、非负、总和为1。未经归一化的 logits 不能直接当概率。模型原生多选评分不一定是校准概率，务必记录转化方法。程序验证格式，但无法验证这些概率是否真的来自模型，不要用模型自报“我有99%信心”代替分数。

```sh
python3 run.py --predictions results/model-a-predictions.jsonl --model MODEL_VERSION --split dev --repeat 3 --output results/model-a-native
```

导出和导入时保持相同 split/repeat/limit/seed。缺失输出会计入失败，重复或多余 ID 会报错。也可以搭一个薄 HTTP 适配器：`--protocol adapter --url http://127.0.0.1:8001/decide`；请求为 `{"schema_version":"vivic-decision-benchmark-1","system":"...","input":{...}}`，响应直接为上述 `choice_id` 或 `probabilities` 对象，不带 case_id/repeat/耗时包装。

### 方式三：先手工测

打开《决策模型测试表.xlsx》的“测试用例”。按“上下文与说明”设置合成画布，使用 `system-prompt.md`，把用户输入和当题候选送给模型。候选可从 `dataset.json` 或方式二导出的无答案输入取得。将实际选项 ID 填到黄色列，表格自动判通过/失败。没有该模型的推理接口也可以先逐条记录答案，语义对照预期列；若记录的是自然语言答案，在备注说明，不能用选项 ID 自动评分冒充自由生成评测。

## 如何判分

- 完整正确率：预测候选的分流、意图、目标、参数全对才通过；错误/超时/缺失输出仍在分母中。不能只看“识别到删除”而忽略删错目标。
- 分流正确率：local_action / clarify / main_llm / tool / noop / unsupported。另报类别与应用范围分项、分流混淆表。
- 目标正确率：只统计期望含目标的用例，避免大量无目标题把分数冲高。目标对不等于动作对。
- 错误执行选择数：错误选择可执行动作或工具的数量，包括不该执行、目标错、参数错、只做复合请求的一部分；本包从不实际执行。
- 关键边界：表中标记的删除、否定、歧义、注入和缺参等用例单独统计。普通正例总分不能掩盖这些错误。
- 概率门控模拟：只有完整候选概率时才计算。默认最高概率≥0.8且领先≥0.25，并且候选为动作/工具，计为离线接纳；报告接纳精度、覆盖率、接纳中的错误执行选择。阈值来自当前实验的起点，**不是跨模型的通用可靠阈值**；可用开发集调整，但必须锁定后测留出集。没有概率时字段为null，而不是0或100%。
- 延迟：报告HTTP请求端到端P50/P95/P99（nearest-rank），分别包含全部请求和成功请求；排除预热请求但单列预热耗时。包含排队、序列化和网络，不等于纯GPU推理。首次预热不等于权重冷加载时间。原生导入时以同学实际记录为准。

始终保留原始错误，不重跑到满意才挑最好一遍。不同模型固定数据哈希、提示词哈希、候选顺序、随机种子和重复次数。重复样例数不等于独立用户数。看过留出集结果再调参数后，留出集就不能再称为未见测试；最终还需要用户自己写的新句子。

## 返还哪些东西

每个模型的 `report.json` 和 `results.csv`，以及已填写的表格。“运行记录”页填写：模型完整版本/权重revision、量化、设备CPU/GPU/内存、推理引擎版本、线程/上下文设置、首次加载秒数、峰值内存MiB、是否OOM。没有实际测量的留空并说明。脚本会记录数据/提示词哈希、Python平台、重复数和阈值，不自动读取整个系统硬件或敏感环境变量。

`report.json` 包含逐条预测语义，不含服务凭据或真实画布。脚本用非空目录保护已有结果。退出码2表示运行/格式错误；退出码0仅代表流程跑完，**不是准确率达标**。目前没有真实新模型结果，表中结果栏均留空。

## 对 Vivic 的应用方式

表中“现有白名单范围”只表示当前Kev允许的意图范围，不保证该句能绕过现有过滤器；“扩展候选”表示想验证的下一步能力，不代表产品已接入该模型。目前Kev只可参与fit/restore/focus/Note展开收起，删除永不由Kev执行。

建议接入顺序：确定性规则继续处理已知精确指令；候选决策层处理规则没覆盖的表达，先验证视图/便笺，再逐类验证待办完成和提醒暂停/继续。日期计算、联网、schema和目标/状态校验由程序负责。问候、总结与复杂规划可快速分流主模型。缺参/多候选澄清；低置信度或超时交回原流程。没有后续执行校验前不能把离线接纳当成产品上线许可。

删除、批量删除和条件提醒等需另做接入评审与端到端验证。本次仅交付测试包，不更改当前白名单、阈值或线上路由。真实时间、联网、卡片布局/固定、撤销、Display事项合并与到时退出等行为，仍应在隔离测试画布里验收。

## 用例依据

来源是截至2026-10-16的仓库代码和最新产品要求，不是互联网模型榜单：`apps/local-api/src/decision/intent.ts`（现有白名单/门控）、`apps/web/src/commands/parse.ts`（规则/删除/待办/提醒状态）、`apps/local-api/src/intent/{prompt,reminders}.ts`（分流/提醒抽取）、`packages/contracts/src/{actionEnvelope,reminderSchedule}.ts`（契约）、`docs/{MANUAL_TEST,local-decision,remaining-plan}.md`及最新事项提醒约定。此处只用于说明设计依据，接收方无需这些仓库文件。

没有重新使用旧180条Kev合成数据作为新成绩，没有下载或实测新模型，没有把既往Kev结果当作本包结果。所有人物、卡片、时间和内容都是合成测试数据。`build_dataset.py` 可重建JSON/CSV；修改用例会改变数据哈希，应重新建立比较基线。
