# 本地规则与 Kev 决策

> 2026-10-19 需求更新：决策模型将作为正式接入能力，支持 API 或本地运行，默认优先引导使用，用户可明确关闭。下文记录现有 Kev 实验实现与历史实测，不代表这个新目标已完成；后续按 [路线 L04](LOCAL_ROADMAP.md) 实现，并评估 [JevHarness](research/jev-harness-assessment.md)。当前整理仓库和 GitHub 操作流程继续。

2026-10-15。在 `agent/next-iteration`，确定规则先处理视图、指代、删除澄清、便笺密度、待办条目完成和提醒暂停/继续。浏览器已经掌握目标时直接应用已校验 Action，不请求 `/api/intent`。日期/重复/条件提醒、天气和数字提取由对应适配器处理，不让模型计算日期或编造数据。

用户所说的项目已定位：

- [Winnow-E4B](https://huggingface.co/EldanRing/Winnow-E4B)，核对 revision `17871fd27a880b3f8dad94841774db70e59fca47`。上游 Q8 文件 8,005,437,472 字节、BF16 文件 15,053,096,992 字节；还有独立附件。仅 Q8 权重已接近本机 8 GiB 总内存，因此未下载、未接入，不能称本机可用。
- [Kev 官方仓库](https://github.com/jaredpalmer/kev)，使用 [Kev-0.8B](https://huggingface.co/jaredpalmer/kev-0.8b)。Apache-2.0；固定源代码 `dd375f27fd61486c52204205e10a0d2e10f3b34a`、适配器 `bf75a6a8848ea6960ff2ed108d9ed44c2941174f`、Qwen3.5-0.8B-Base `dc7cdfe2ee4154fa7e30f5b51ca41bfa40174e68`。不跟随上游 main 自动升级。

## 可选的产品入口

Control →「本地快速决策」。默认关闭、不自动下载或常驻，适用于 Apple Silicon Mac。准备需要 Python 3、uv、网络和模型/环境磁盘空间；固定模型约 1.83GB，独立 Python 3.12 环境另计。准备、加载、失败、停止和清理均有状态；停止释放本进程的模型，不动其他模型进程。后端退出也终止自己创建的进程组。

模型先只在固定选项中打分，不生成自然语言、参数或 ID。通过阈值（最高概率 ≥0.8、领先第二项 ≥0.25）、否定/引用/复合操作及动作词检查后，只能调整视图、聚焦、展开/收起便笺。程序从当前画布解析目标，多目标则澄清。模型的删除选项永不执行。规则已经处理的操作不加载/调用 Kev。

推理时源代码/权重逐个 SHA-256 校验，离线加载固定本地文件，拒绝运行期联网；没有 coding tools、会话、扩展、任意代码执行或训练入口。请求最多 500 字符，固定编码预算；超长/不确定则放弃，单次超过 1 秒自动卸载并回到原有流程。模型加载校验和 Metal 预热最多 60 秒，加载期间不阻塞其他指令。StepFun Plan 与 GPT/Pi 仍是仅有的两种远程 LLM。

## 实测与边界

这仍是**中文小范围实验**，不能把高置信度视为普遍正确。固定 180 条合成中文指令（含模板变体）不是独立用户测试：原始分类正确 124/180（68.89%）。原始结果曾把「不要删除待办」判为删除，故不能直接执行模型分类。

最终生产过滤器在同一 180 条数据上只接纳 25 条，25 条均正确，覆盖 13.89%；其余交回规则/已连接 LLM 或明确澄清。阈值与词表是在合成样例上选定，不能宣称泛化准确率 100%。程序仍需验证目标，部分分类会进一步放弃执行。

独立 MLX PoC 的温热 P95 约 198ms；产品桥接在并行浏览器回归期间的 180 条 P95 约 559ms，加载约 14.4 秒。实际产品桥接已返回有效 Action，并验证停止。GPU active 1,504,791,242 字节，独立 PoC peak 2,572,572,364 字节；Python RSS 不包含全部共享 GPU 内存。不同负载表现不能混为同一次基准。

证据：`.cache/kev-evaluation/benchmark.json`、`evidence/next-plan/kev-product-bridge.json`、`evidence/next-plan/kev-evaluation-2026-10-15T13-00-47-525Z.json`。旧 Laya NO_GO 记录保留，不把 Kev 成功改写成 Laya 已修好。

## 复现

```sh
python3 scripts/decision-model/prepare.py --cache-dir .cache/decision-model/kev-0.8b
pnpm --filter @vivic/local-api exec tsx ../../scripts/decision-model/evaluate.ts
```

模型 manifest、运行环境锁、合成样例和许可证在 `scripts/decision-model/`。准备过程只安装固定运行依赖，不安装上游训练/服务包。缓存默认忽略；清理产品模型不会删除 `.cache/kev-evaluation` 或历史证据。
