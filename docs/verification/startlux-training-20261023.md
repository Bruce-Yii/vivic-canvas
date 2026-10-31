# StartLux 小档训练实际验证

此记录只证明本轮开发训练链路与生成的候选，不宣称完成4B正式特调。

- 固定官方源码 `83fe6c7d61a687a6e17f118b4f7d8f429f5d3a01` 和0.8B BF16 checkpoint `6496ae641cc71b149ce9dad69bd97f2a44e7bf11`，权重 SHA256 `f788c8e01fd453dfbf2effb23a06148d38238b9e8a872ab8faacbb49a03cecd1`。
- 独立 Python3.12.15 / PyTorch2.9.1+cu128 / Transformers5.8.0 / PEFT0.21.0，RTX3060 12GB；不停止其他GPU程序，不修改运行中的Vivic。
- 90条自造指令，训练58/验证12/测试20。初始12步烟测验证训练/评测流程；随后固定一轮58步，训练阶段只计算验证集，冻结后另做重载和测试。小合成集不是独立真实用户集，不能由其推导泛化提升。
- LoRA rank4，159,744个训练参数、58次真实反向传播和优化更新，权重确实改变；约115.8秒，峰值分配2,741,380,608 bytes。完整梯度和loss记录在本机报告。
- Windows官方torch wheel无原实现限定的fused attention kernel，初次明确失败；显式启用训练限定的 `--allow-math-sdpa` 后保持原SDPA/GQA/双向逻辑并通过官方自检。只允许0.8B/640token，不改生产引擎。这是D环境适配，不声称官方对Windows训练的原生支持。
- 已保存并重新加载适配器；重载后所有验证样例概率与保存前差值小于1e-6。

| 指标 | 基线 | 一轮候选 |
| --- | ---: | ---: |
| 12条验证准确率 | 7/12 | 8/12 |
| 验证其他任务召回 | 2/6 | 3/6 |
| 验证原模型误接收（不计宿主额外保护） | 1 | 1 |
| 20条测试准确率 | 14/20（初始烟测基线） | 14/20 |

测试准确率没有提升，验证中仍有误接收，温度尚未用足够数据重新校准。**候选未推广、未合并为正式GGUF、未替换用户的本地模型**；宿主的否定/删除/歧义保护和Action限制不变。4B训练配置与同协议脚本已提供，4B实际训练、合并量化等价和产品质量验收仍待后续资源与数据。

适配器 `adapter_model.safetensors`：642,472 bytes，SHA256 `91f1ce4150416e730cce7d734c28d89bc1fe06c1ec53bdfa51c7ef2ff08db916`；按基础模型CC BY-NC4.0保留来源。训练脚本、数据及复跑步骤在 `scripts/training/`、`training/startlux/`。

本机证据 `.cache/startlux-training/`：environment.json、summary.json、candidate-0.8b-epoch1-20261023/training-report.json、reload-validation-20261023/evaluation-report.json、heldout-20261023/evaluation-report.json。数据重复、跨split组泄漏、标签覆盖与误接收指标4项单元检查通过。未调用模型API、上传数据、播放声音或提交/发布。
