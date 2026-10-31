# 决策模型需求复核

复核日期：2026-10-15。结论：保留“规则 → 专用决策层 → 主 LLM”的职责设计；当前仅推进 StepFun Coding Plan key 的文本闭环及同凭据语音能力核验。Laya/Winnow 暂为研究候选，其他 provider、Jev API 和 Pi OAuth 接入暂缓。

## 原始意图与当前约束

- PRD D06、§5、P2 明确：确定指令先走规则；Winnow 优先判断 `intent / targets / needsSearch / needsLLM / confidence`；复杂理解、信息压缩及结构化动作生成交给 StepFun/Pi 主 LLM。未接入 Winnow 必须明示，不能将规则或普通 LLM 调用冒称为 Winnow。
- 指定会话用户正文第 60 行：主要痛点是按“13 分钟的倒计时”等语义定位卡片，不能只认左中右；机器跑不动时愿意考虑远程决策 API。助手第 61 行也将规则称为占位，并重述上述分层。
- 用户第 66 行：希望以后可按设备配置选择 Laya/Winnow 版本下载，也考虑远程决策 API；语音优先 StepFun。这是可行性需求，“占用很低”尚非本机测量事实。助手第 67、88 行提出的通用 provider/OAuth 方案属于建议。
- 用户第 95、109 行后来明确收窄：现在只兼容 StepFun Coding Plan API key，TTS 也走它，其他先不急；并要求重读 PRD 与本会话。该最新指令覆盖此前多 provider 的推进安排。本次不实现本地模型、不下载权重。
- 上述相关正文未出现 `llama`。用户写的是 `laya`，不能擅自更名为 Llama；Winnow 推理实现使用 llama.cpp，也不代表模型属于 Llama 系列。

## 名称与能力核实

| 名称 | 原始来源确认的身份 | 对 Vivic 的意义与限制 |
|---|---|---|
| Laya | Convai Innovations 的结构化决策引擎；原仓库 `NandhaKishorM/laya`。英文、multilingual、typed-decisions 三种 checkpoint；前两者分别约 421M、322M 参数。以单次前向计算回答 choice、score、noul（是/否概率）。 | 适合将指令与画布摘要映射到有限候选；中文优先评估 multilingual。库内 Router 主要选择 checkpoint，不自动等于 Vivic 的意图路由。仓库提供自托管 HTTP 接口，但本次未确认可直接购买的官方托管 API。见 [Laya 原仓库](https://github.com/NandhaKishorM/laya)、[路由说明](https://github.com/NandhaKishorM/laya/blob/main/docs/routing.md)。 |
| Winnow | 与决策模型描述吻合的是 EldanRing 的 Winnow 系列；已核实 E4B、12B，分别基于 Gemma 4 E4B IT、12B IT 微调。作者推理仓库以 `/v1/systemone` 对候选答案打分，也保留普通聊天接口。 | 能作为快速判断层候选，但不是无需资源的轻量分类器：E4B Q8 权重约 8.01 GB、12B Q8 约 12.67 GB，运行还需额外内存。见 [E4B 模型卡](https://huggingface.co/EldanRing/Winnow-E4B?hardware=apple-m5-max-48gb)、[12B 模型卡](https://huggingface.co/EldanRing/Winnow-12B)、[作者推理仓库](https://github.com/EldanRing/winnow-inference)。 |

身份边界：上述原始项目真实存在且用途吻合，但交接包与指定会话均未提供用户选型链接、版本或测试数据，因此“用户当时测的 Winnow 就是 EldanRing 的某个版本”仍属待确认推断。同名的 [GhalebDweikat/winnow](https://github.com/GhalebDweikat/winnow) 是依赖 Jev/其他模型的工具结果裁剪插件，不能当作独立决策模型安装。当前机器能否流畅运行、中文目标解析准确率、可信阈值及远程服务可用性均未知；上游性能数字不是本项目验收结果。

## 决策层与 StepFun 主 LLM 的分工

决策层回答“执行什么、指向谁、是否需要搜索/大模型”，候选卡片 ID 与动作均由程序给定；例如从三张卡及其剩余时长中选择最符合“8 分钟左右”的目标。它不负责生成自由文本卡片内容，也不承担 TTS/STT。低置信度或多个近似目标应澄清，不能因返回了概率就直接删除。

主 LLM 负责复杂或复合语义、提炼信息、生成受约束的 ActionEnvelope；仍需 schema、权限和真实目标校验，再由 reducer 执行。当前可先由 StepFun 兼任语义规划，但这不等于独立专用决策层已经完成。TTS 将反馈文字变成声音，STT 将声音变成文字；同一 key 的期望不意味着可以把语音模型送入聊天接口。

StepFun [官方平台](https://platform.stepfun.com/)展示统一 API 及语音能力，[Step Plan 页面](https://platform.stepfun.com/step-plan?from=codingplan)说明订阅服务。它们不足以证明用户这把 Coding Plan key 在当前端点上的 TTS/STT 权限、额度与计费归属；这些仍须分别实测。`/models` 出现某个语音模型也不能代替成功的语音请求。

## 代码现状（静态核对）

以下记录本轮开发开始时的代码。等待反馈、StepFun Plan 与 TTS 的后续实现及验收见 `evidence/phase2a/REPORT.md` 与 `docs/stepfun-plan-tts.md`。

- `apps/local-api/src/intent/{rules,pipeline,prompt}.ts`：确定规则命中后直接返回；否则以当前画布摘要调用 StepFun JSON planner。schema 不合格最多再试一次；无 key、请求失败或无法理解有显式结果。不存在 Laya/Winnow 运行时或独立决策适配器；“预留”目前是注释和可扩展位置，不是已落地接口。
- `apps/local-api/src/{app,credentials,config,stepfun}.ts`：已有凭据验证、状态、断开及 `/api/intent`；key 存服务内存，默认通用端点为 `https://api.stepfun.com/v1`，可配置覆盖。没有专用 Coding Plan 能力协商，也没有语音路由或 OAuth 接入。
- `stepfun.ts` 已优先选择 `step-3.5-flash` 等聊天模型，`tests/model-pick.test.ts` 有 TTS 排首位的回归用例；但筛选无结果仍回退 `ids[0]`，仅返回语音模型时仍可能误选，尚不能保证所有情况下排除语音模型。用户第 95 行称“可以删”，支持当时删除操作恢复；不代表语音或全部模型能力已验收。
- `apps/web/src/control/ControlApp.tsx` 已调用后端意图服务并在离线时回退浏览器规则；所读版本未将请求等待接成独立 thinking 状态。`stage/OrbLayer.tsx` 已按卡片屏幕位置避让，显示仍主要由字幕/舞台状态驱动。
- README 与 `evidence/phase2a/REPORT.md` 记录了 mock 验证及真实调用待验证状态；它们不是本次重新运行的结果。本次仅静态阅读，未使用凭据、启动服务或运行会写缓存的测试。

## 推荐最小下一步与改动路径

本机读取结果为 Apple M1、8 GiB 统一内存（`sysctl -n hw.memsize machdep.cpu.brand_string`）。据此推断，上述 Winnow E4B Q8 权重几乎占满整机内存，无法为系统、浏览器和推理运行时留下足够空间，暂不作为本机默认方案。更低量化的可运行性仍未实测；若继续本地决策 PoC，优先评估 Laya multilingual 的中文准确率、延迟与实际内存，再考虑下载器。这是硬件条件下的工程判断，不能代替模型实测。

1. 先在现有 StepFun 适配器上，使用用户已授权 key 分别验证正确端点、可用聊天模型及 JSON 动作生成；用“唯一约 8 分钟目标／多个近似目标／无匹配目标”核验删除、澄清、不执行。修正仅有语音模型时的默认回退。建议后续改动：`apps/local-api/src/stepfun.ts`、`tests/model-pick.test.ts`、`tests/live/stepfun.live.test.ts`。
2. 将请求发起、完成、失败接到可见等待反馈，结束时清理；随后对同一 key 单独验证 TTS，STT 按需再验证。权限不支持时明确报告，不自动新增其他 provider。建议后续涉及 `apps/web/src/control/ControlApp.tsx`、状态/同步/Orb 层及本地 API 语音适配。
3. 专用路由暂记未完成。后续确认用户原选型的仓库和版本，再定义小型决策结果契约、中文样例及延迟/内存门槛，决定是否开展独立 PoC；不以本次研究触发下载器、权重安装或额外 API key 配置。

## 实际来源与本次改动

- 已先读交接包：`Vivic_Kimi_Handoff_v0.6/README_FIRST.md`、`AGENTS.md`、`PRD.md`（重点 D06、§5、P2）、`COMPONENT_LOCK.md`、`ARCHITECTURE.md`；另读 `SOURCE_MATRIX.md`，确认原包未独立验证 Winnow 身份。
- 唯一访问的会话：`/Users/cjr/.codex/sessions/2026/10/15/rollout-2026-10-15T03-49-08-c52b42ea-f41a-44f7-ac30-6fdbeb05122d.jsonl`。仅按 user/assistant message 正文提取与 Laya/Llama/Winnow/决策/路由有关段落；关键原始行号为 60、61、66、67、75、88、95、109、129，不采用工具输出作为聊天证据，不摘录凭据。
- 当前进度来源：上述本地 API/前端源码、`apps/web/src/ai/api.ts`、`apps/web/src/control/{CommandSection,AiSection}.tsx`、`apps/local-api/tests/model-pick.test.ts`、根 `README.md`、`evidence/phase2a/REPORT.md`。网络依据仅采用正文所链官方页面、作者仓库和作者模型卡；网络访问失败的文档页未作事实依据。
- 本次仅新增 `docs/decision-model-review.md`；其余路径均为阅读依据或后续建议，未修改。未访问其他聊天、读取凭据文件、实现本地模型或下载权重。
