# Vivic StartLux 决策微调

这是开发用训练和独立评测入口，不会替换用户已安装模型、修改原权重或上传训练数据。当前数据为90条自造中文指令，58条训练、12条验证、20条测试，覆盖七种受限意图及否定、复合、引用、缺参和其他任务。它是流程验证集，不能证明实际用户分布上的质量。

保留官方 Instant 的完整 chat template、空 think 后缀、双向 prompt attention、8个字母读出（七个候选+None）以及 choice temperature。使用 LoRA 训练 q_proj/v_proj；不把 Instant 当普通 causal chat 模型训练。宿主的删除/否定/歧义拒绝和 Action 校验保持不变。

来源固定：

- [StartLux 推理源码](https://github.com/StartLuxLabs/StartLux-Decision/tree/83fe6c7d61a687a6e17f118b4f7d8f429f5d3a01)，代码 Apache-2.0。
- [0.8B Instant](https://huggingface.co/startlux-models/StartLux-Decision-v1.1-0.8B-Instant/tree/6496ae641cc71b149ce9dad69bd97f2a44e7bf11)；[4B Instant](https://huggingface.co/startlux-models/StartLux-Decision-v1.1-4B-Instant/tree/416088f77cfce09633906a3675c7cd2e5dabcf10)，权重 CC BY-NC 4.0。
- [PEFT 自定义模型 LoRA](https://huggingface.co/docs/peft/v0.21.0/en/developer_guides/custom_models)。模型适配保持原 attention，不改写其语义。

## 独立环境

用 Python 3.12 建项目 `.cache` 下独立虚拟环境；无需修改系统 Python。将上述固定 revision 的官方源码放到 `.cache/startlux-upstream`。Windows CUDA 示例以 [PyTorch 官方安装源](https://pytorch.org/get-started/previous-versions/)为准：

```powershell
uv venv .cache/startlux-training/python --python 3.12.15
uv pip install --python .cache/startlux-training/python/Scripts/python.exe torch==2.9.1 --index-url https://download.pytorch.org/whl/cu128
uv pip install --python .cache/startlux-training/python/Scripts/python.exe -r training/startlux/requirements.txt .cache/startlux-upstream
$py='.cache/startlux-training/python/Scripts/python.exe'
& $py scripts/training/test_startlux.py
& $py scripts/training/startlux.py validate
```

在 macOS/Linux 用 `.cache/startlux-training/python/bin/python`。CPU 安装使用官方 CPU 源；GPU/Mac 训练能力须在对应机器验证，当前不宣称 Mac 训练已通过。

## 训练、重载与留出评测

```powershell
& $py scripts/training/startlux.py train --profile 0.8b --model .cache/startlux-training/model-0.8b --download --output .cache/startlux-training/candidate --device cuda --max-steps 58
& $py scripts/training/startlux.py evaluate --profile 0.8b --model .cache/startlux-training/model-0.8b --adapter .cache/startlux-training/candidate --output .cache/startlux-training/reload-validation --split validation --device cuda
& $py scripts/training/startlux.py evaluate --profile 0.8b --model .cache/startlux-training/model-0.8b --adapter .cache/startlux-training/candidate --output .cache/startlux-training/heldout --split test --device cuda
```

下载固定 revision 的完整原始 checkpoint，不拿 GGUF 训练；所有 blob 校验长度、LFS SHA256 或原始 Git blob SHA1，报告再记录 SHA256。未使用登录 token。模型目录必须是本命令指定路径，输出不能覆盖已有候选。

Windows 的 PyTorch2.9.1 CUDA wheel 没有本模型所需 fused attention kernel 时，可以显式加 `--allow-math-sdpa`，只允许0.8B、最多640 token和受限GPU内存。它是 **D：仅训练环境兼容选择**：放开官方保护内存的 fused-kernel 限定，仍执行官方相同 SDPA/GQA、非因果行长度与双向自检；不修改源码、生产引擎或 attention 语义。不自动回退或默默关闭自检。4B不允许此小档验证选项，须在有合适CUDA kernel/足够资源的环境训练，或显式使用CPU。

训练只计算验证集，不读取测试集 logits；候选冻结后单独执行测试评测。评测保留None质量、其他任务召回、原模型误接收、Brier、ECE与混淆矩阵。原模型误接收在报告中可见，不能用宿主额外保护掩盖模型本身的错误。现有小集温度不重新拟合，不得宣称已完成生产校准。

`--profile 4b` 会选择固定4B checkpoint，需同时指定独立 `--model` 路径；它是后续主训练配置。当前实跑对象是0.8B，4B正式训练及更大独立数据集仍需后续验收。适配器标为 `development-candidate`，没有自动安装/发布入口；只有质量和许可验收完成后才另做合并、量化、推理等价检查与显式版本升级。
