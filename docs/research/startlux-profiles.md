# StartLux 决策模型档位

核查日期：2026-10-23。用户所说的 Starlux 4B 对应 **StartLux-Decision**。本轮登记 v1.1 Instant 0.8B / 2B / 4B / 9B；4B 为 Vivic 主推荐，9B 仅手动候选。登记不代表已安装、实测或完成二次训练。

## 硬件建议

以下为 **Vivic 针对短文本决策的保守规划估算**，不是上游最低配置，不保证启动成功、速度或准确率。必须同时满足总内存和当下空闲内存；启动前重新检查。GPU、架构、驱动、引擎和磁盘另行检查。繁忙系统会建议更小档位；不自动切换正在运行的模型。

| 档位 | Q4_K_M 文件字节数 | 总内存至少 | 空闲内存至少 | 自动建议 |
| --- | ---: | ---: | ---: | --- |
| 0.8B Instant | 529,296,992 | 6 GiB | 2 GiB | 低配 |
| 2B Instant | 1,274,396,256 | 8 GiB | 4 GiB | 平衡 |
| 4B Instant | 2,708,804,064 | 16 GiB | 8 GiB | 主推荐 |
| 9B Instant | 5,629,108,768 | 32 GiB | 14 GiB | 仅手动 |

低于 0.8B 档估算或测量无效时，返回无自动本地建议，由现有明确降级路径处理。即使 256 GiB 机器也不自动升至 9B。所有阈值均是 Q4_K_M、短文本用途；不适用于训练、视觉推理或长上下文。Q4_K_M 是 Vivic 省内存候选，上游 GGUF **推荐 Q8_0**，并说明低比特量化会降低部分决策指标。不能把模型文件大小当成运行总内存。[官方量化说明](https://github.com/StartLuxLabs/StartLux-Decision/blob/83fe6c7d61a687a6e17f118b4f7d8f429f5d3a01/docs/quantization.md)、[4B GGUF 模型卡](https://huggingface.co/startlux-models/StartLux-Decision-v1.1-4B-Instant-GGUF/blob/a9ab4199fdff586f86e3baf8c9557f6c5ca0fdc0/README.md)。

## 固定权重与训练起点

元数据来自官方 Hugging Face API 的 `?blobs=true`：revision 是仓库提交，SHA256 是 LFS 内容哈希，非 Git blob SHA。核查仅下载元数据与小型模型卡/config，未下载 GB 权重。源码登记于 `apps/local-api/src/runtime/startluxProfiles.ts`；下载链接固定 revision，不能改回 `main`。

下列仓库都位于官方 `startlux-models/`，文件名为 `StartLux-Decision-v1.1-{尺寸}-Instant-Q4_K_M.gguf`。

| 尺寸 | GGUF 仓库 | 固定 revision | Q4_K_M SHA256 |
| --- | --- | --- | --- |
| 0.8B | [StartLux-Decision-v1.1-0.8B-Instant-GGUF](https://huggingface.co/startlux-models/StartLux-Decision-v1.1-0.8B-Instant-GGUF/tree/529edd1b9dae38fda3ba6a5ab0cbc785c91e8359) | `529edd1b9dae38fda3ba6a5ab0cbc785c91e8359` | `9a5d52f0d69e86994188aa5a58597e3d09ed602fef5c8a2d34a870b617541e94` |
| 2B | [StartLux-Decision-v1.1-2B-Instant-GGUF](https://huggingface.co/startlux-models/StartLux-Decision-v1.1-2B-Instant-GGUF/tree/afb95dbba67e648f4e1b5ad3f770a91f799f9496) | `afb95dbba67e648f4e1b5ad3f770a91f799f9496` | `d20a1270afe0cef5b29c4d5bb9872c743a9c5e9fcfc388d26645f1d9cfa0fd34` |
| 4B | [StartLux-Decision-v1.1-4B-Instant-GGUF](https://huggingface.co/startlux-models/StartLux-Decision-v1.1-4B-Instant-GGUF/tree/a9ab4199fdff586f86e3baf8c9557f6c5ca0fdc0) | `a9ab4199fdff586f86e3baf8c9557f6c5ca0fdc0` | `5fcfe9771db996a868f78215c08955c21cf5e8188609e17e9c653183d946e84d` |
| 9B | [StartLux-Decision-v1.1-9B-Instant-GGUF](https://huggingface.co/startlux-models/StartLux-Decision-v1.1-9B-Instant-GGUF/tree/951208c80943806346b55aed6b5bc2a1fff35d09) | `951208c80943806346b55aed6b5bc2a1fff35d09` | `d3015763493f625608c4c7743824b14eb4af92da279f1b814458f71a96b07756` |

二次训练从下列发布的 BF16 检查点开始评估，**不直接训练 GGUF**。这是当前检查点的精确来源记录，不代表上游完整训练集/训练脚本已发布，也不等于 Vivic 训练流程已实现。

| 尺寸 | BF16 仓库 | 固定 revision |
| --- | --- | --- |
| 0.8B | [StartLux-Decision-v1.1-0.8B-Instant](https://huggingface.co/startlux-models/StartLux-Decision-v1.1-0.8B-Instant/tree/6496ae641cc71b149ce9dad69bd97f2a44e7bf11) | `6496ae641cc71b149ce9dad69bd97f2a44e7bf11` |
| 2B | [StartLux-Decision-v1.1-2B-Instant](https://huggingface.co/startlux-models/StartLux-Decision-v1.1-2B-Instant/tree/f1e6cd147dda82c9ffa3e8e725d5c1f175566fb1) | `f1e6cd147dda82c9ffa3e8e725d5c1f175566fb1` |
| 4B | [StartLux-Decision-v1.1-4B-Instant](https://huggingface.co/startlux-models/StartLux-Decision-v1.1-4B-Instant/tree/416088f77cfce09633906a3675c7cd2e5dabcf10) | `416088f77cfce09633906a3675c7cd2e5dabcf10` |
| 9B | [StartLux-Decision-v1.1-9B-Instant](https://huggingface.co/startlux-models/StartLux-Decision-v1.1-9B-Instant/tree/18a17f734966b213b2f00fa9c915e8b9af2a9b20) | `18a17f734966b213b2f00fa9c915e8b9af2a9b20` |

4B BF16 原权重两片分别为：

| 文件 | 字节数 | SHA256 |
| --- | ---: | --- |
| `model-00001-of-00002.safetensors` | 5,356,493,792 | `425309b56b30ca905d7f41f77440b90334bc9cc46af8666bf917aef1dd5a5271` |
| `model-00002-of-00002.safetensors` | 3,963,334,448 | `7606b01d220a0242f1e0e837069e65b175134651f12e6b6d890770abb0687920` |

## 引擎与训练边界

Instant 不是普通聊天权重：全注意力层读取双向 prompt，线性注意力层仍因果；官方包负责 prompt 格式、选项 letter logits、问题类型温度与概率输出。4B 的 `decision_config.json` 为 `lodestar-letter-readout-v1`，且 `prompt_attention=bidirectional`。仅替换旧 Qwen GGUF 文件名、继续普通聊天补全会得到错误语义的模型。现有 Vivic 动作白名单、Schema、置信门控和明确降级仍必须保留。[4B 模型卡](https://huggingface.co/startlux-models/StartLux-Decision-v1.1-4B-Instant/blob/416088f77cfce09633906a3675c7cd2e5dabcf10/README.md)。

官方推理代码固定 `StartLuxLabs/StartLux-Decision@83fe6c7d61a687a6e17f118b4f7d8f429f5d3a01`，包版本 `startlux-decide 1.1.0`。部署路径可选：

- Windows / Intel Mac：支持该模型架构的 llama.cpp + 官方 `startlux-decide`。4B 官方 GGUF 卡注明实测 llama.cpp `b11549`；不能据此声称旧 `b9660` 已兼容。需另取固定 BF16 仓库中的 tokenizer、config 和 decision_config；GGUF 仓库不含这些文件。
- Apple Silicon：官方 MLX backend；MLX 不适用于 Intel Mac。使用官方包处理双向 mask，不能用普通 mlx-lm 聊天替代。
- Instant 的 stock llama-server 必须保持 non-causal GGUF flag、单槽 `--parallel 1`、`--ctx-checkpoints 0`、完整 prompt 的 `-b/-ub`，禁用 prompt cache，并按官方配置使用 `STARTLUX_LLAMACPP_BIDIR=server`。官方示例 `-b 16384 -ub 16384` 是示例上界，不表示 Vivic 接受无限输入。图片还需 mmproj 与额外验证，本轮档位只面向文本。

这些是官方支持路径，**不是 Vivic Windows / Mac 实测结论**。Instant 仅单次 readout，不接 `think_mode=auto/always`；若未来增加 AutoThink，应独立登记与评测。[官方部署要求](https://github.com/StartLuxLabs/StartLux-Decision/blob/83fe6c7d61a687a6e17f118b4f7d8f429f5d3a01/docs/deployment.md)、[引擎说明](https://github.com/StartLuxLabs/StartLux-Decision/blob/83fe6c7d61a687a6e17f118b4f7d8f429f5d3a01/docs/engines.md)。

后续 Vivic 二次训练需保留其 readout/双向注意力语义，在独立数据划分上评估动作准确率、拒答/none、概率校准与延迟；再评估导出后的每个量化档。不能把通用聊天 LoRA 训练成功当成决策模型验收，也不能用上游 H200/M5 Pro 的速度作为用户电脑保证。

## 许可

官方代码 Apache-2.0，**权重 CC BY-NC 4.0**；模型卡明确商业使用需 StartLux 单独许可。二次训练/量化不会自动移除原权重许可，发布派生权重需保留归属、许可及修改说明。当前仅登记官方来源；未宣称已有商业权重授权。[官方许可说明](https://github.com/StartLuxLabs/StartLux-Decision/blob/83fe6c7d61a687a6e17f118b4f7d8f429f5d3a01/README.md#license)、[4B 权重 LICENSE](https://huggingface.co/startlux-models/StartLux-Decision-v1.1-4B-Instant/blob/416088f77cfce09633906a3675c7cd2e5dabcf10/LICENSE)、[CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/)。

## 本轮验证

`pnpm --filter @vivic/local-api exec vitest run tests/startluxProfiles.test.ts`：4 项通过，覆盖主推荐上限、两种内存约束、档位边界、无效测量和固定下载元数据约束。另以只读脚本逐个访问固定 revision 的官方 HF API，4 个 GGUF 文件的字节数、LFS SHA256 和 4 个 BF16 来源 revision 全部匹配 registry。未进行权重大下载、真实推理、训练或 Mac 运行测试。
