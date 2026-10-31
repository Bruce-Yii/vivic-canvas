# 一句话到卡片评测

2026-10-21。数据集 `apps/local-api/evals/golden.ts` 共105条独立中文输入，覆盖21个内置场景、关键字段和12个缺事实/越权负例。固定时间2026-10-17 10:00 Asia/Shanghai。

运行 `pnpm eval:intents`；或 `pnpm --filter @vivic/local-api exec tsx evals/run.ts`。默认不联网，不读取真实模型凭据，以 golden 预期提取结果回放真实 Schema、grounding 和确定性 builder。输出场景/字段通过数与本地构建延迟，**不能用作模型理解准确率或模型耗时**。

实测105/105通过，p50约1ms、p95约3ms（仅本地构建，机器负载会改变），基础 system+场景表约6.4k字符。模型 prompt 明确输出闭集、完整处理复合要求、只问缺失字段、禁止实时事实捏造、服务结果只读，以及摘要不能覆盖原文。

真实模型评测需显式运行 `pnpm eval:intents --live`，并在当前进程中提供评测专用 `VIVIC_EVAL_API_KEY`、`VIVIC_EVAL_BASE_URL`、`VIVIC_EVAL_MODEL`。程序使用现有 chatJson 客户端，逐条发送输入；`--limit=5` 可先做小样本。只打印 case ID、聚合结果与延迟，不输出凭据或模型原文。没有这些变量直接失败，不自动借用本机模型连接。

本轮未运行真实模型模式，不能声称 prompt 提升了模型准确率。live 验收包含场景类型、关键数值字段与可构建性；负例要求模型明确 clarify。它不覆盖视觉质量、用户主观表达、真实飞猪库存/报价、端到端 UI 或开放域聊天质量。可继续在失败 case 上扩充自然表达与人工审阅标签。
