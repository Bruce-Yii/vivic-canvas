# 原规格目录的维护约定

本目录保存 v0.6 产品规格、示例、参考素材和生成的 JSON 契约。当前产品与协作规则以根 [AGENTS.md](../AGENTS.md)、[当前交接](../docs/AGENT_HANDOFF.md) 为准。

- 旧背景、阶段顺序、模型候选和入口描述是设计历史，不要求重新开发已完成模块。
- `contracts/*.schema.json` 由 `packages/contracts` 的运行时 Schema 生成；不要手改。修改协议后使用 `pnpm contracts:generate` 并执行 `pnpm contracts:check`。
- `examples/` 和契约文件被自动测试引用，保留路径；原 PRD、组件来源、参考 HTML 与 Word 原稿保留供追溯。
- 本目录涉及共享协议与产品规格，变更由维护者统筹；伙伴任务需要修改时须明确接口和集成范围。

原始开发规约已保存为 [历史规约](../docs/archive/2026-10/original-agent-rules.md)。
