# 本地启动器、StartLux 与语音分工

2026-10-23。用户指定 StartLux 4B 作为 Vivic 二次训练的首选决策模型，并要求启动器兼容 Windows / Mac、按电脑配置选模型。以下区分本轮代码与尚待运行的模型工作。

## 本轮代码

- Windows x64 保留原启动器；新增 macOS arm64 / x64 原生打包、安装、启动、停止与手动 CI，见 [跨平台启动器](2026-10-23-cross-platform-launcher.md)。Mac 构建需要对应架构 Mac；没有在 Windows 制造 Mac 成品。
- 现有 Qwen 0.5B 验证运行时补齐两个固定 Mac 引擎档、SHA256、tar 解析、执行权限和动态库路径；同一 IPC guardian 负责回收。新 receipt 绑定引擎档哈希，保留旧 Windows receipt 兼容。尚未在 Mac 执行推理。当前“清理模型”删除下载压缩包和权重，保留已安装引擎。
- 新增 StartLux `/v1/decisions` / `/v1/systemone` 原生协议：固定七种候选，只请求 `choice`、`think_mode=never`，沿用概率校验与现有 Action 限制。`choice=null` 或 `none_probability>=0.2` 拒答；不把移除 none 后归一化的概率误当可执行信心。失败、超时和不确定返回原流程。
- 新增四档固定模型清单及纯内存建议。`GET /api/decision/models` 为已认证电脑 API 返回建议及候选元数据，不下载、不启动、不宣称权重已安装；实际状态以 `/api/decision/status` 为准。4B 是产品主推荐；内存阈值是 Vivic 保守规划值，不是官方最低配置或延迟保证。
- 启动器模型名称、下载大小改为后端实际值，停止说明适用于两平台；不增加主界面面板。

| 建议档位 | 总内存 / 当前空闲内存估算 | Q4_K_M 文件约大小 |
| --- | --- | --- |
| 0.8B，低内存 | 6 / 2 GiB | 529 MB |
| 2B，平衡 | 8 / 4 GiB | 1.27 GB |
| 4B，首选 | 16 / 8 GiB | 2.71 GB |
| 9B，仅手动候选 | 32 / 14 GiB | 5.63 GB |

不符合最小档时不自动推荐本地模型；空闲内存不足时也会降档。当前没有 GPU/显存探测或实测速度评分，不能将建议当作整机联合性能验收。

## 连接官方 StartLux 服务

本轮增加的是 Vivic 的原生协议接入和选型基础，**没有把官方 Python 推理栈及 StartLux 权重集成成一键准备**。现有“准备模型”仍准备已验证的 Qwen 0.5B，不能把它改名为 StartLux。官方服务需先按 [固定版本引擎文档](https://github.com/StartLuxLabs/StartLux-Decision/blob/83fe6c7d61a687a6e17f118b4f7d8f429f5d3a01/docs/engines.md) 单独启动。

StartLux Instant 使用专用双向提示注意力、模型 tokenizer / decision_config 和温度 readout；现有 b9660 不是其已验证引擎。官方 GGUF 验证版本为 b11549；非 causal GGUF 配合单 slot、whole-prompt batch、关闭 checkpoints，并由官方 Python 包完成推理协议。Apple Silicon 另有官方 MLX 路径，Intel Mac 不能用 MLX。不要把模型塞进现有七字母 Qwen prompt 作为等价替换。具体来源、固定 revision / SHA256 和边界见 [模型清单](../research/startlux-profiles.md)。

官方服务已经在本机 8090 运行后，新的 Vivic API 可用以下环境配置连接。地址是完整接口路径；密钥只通过独立 `VIVIC_DECISION_PROVIDER_TOKEN` 传给后端，不放 URL 或浏览器。配置需要在启动新 Vivic 进程之前生效；不自动重启当前保存了内存凭据的用户服务。

```powershell
$env:VIVIC_DECISION_PROVIDER_URL='http://127.0.0.1:8090/v1/decisions'
$env:VIVIC_DECISION_PROVIDER_KIND='local'
$env:VIVIC_DECISION_PROVIDER_PROTOCOL='startlux'
$env:VIVIC_DECISION_PROVIDER_TIMEOUT_MS='5000'
# 然后从同一终端启动新安装的 Start-Vivic.ps1
```

```sh
export VIVIC_DECISION_PROVIDER_URL=http://127.0.0.1:8090/v1/decisions
export VIVIC_DECISION_PROVIDER_KIND=local
export VIVIC_DECISION_PROVIDER_PROTOCOL=startlux
export VIVIC_DECISION_PROVIDER_TIMEOUT_MS=5000
./Start-Vivic.command
```

端口由实际官方服务决定；示例不是服务已启动的声明。推理服务负责选择并加载某一模型规格，Vivic 的建议 API 不会替操作者切换正在运行的服务。

## 二次训练与语音

4B Instant 的原始 checkpoint 作为微调起点；量化文件仅用于推理候选。先建立 Vivic 专属训练/留出评测（含否定、复合、缺目标、危险操作、拒答），保持官方注意力/温度/选项顺序约定，再验证校准、低置信回退、量化损失和不同电脑的资源开销。本轮没有训练数据产物或新权重，不能标为“Vivic 微调完成”。代码 Apache-2.0 与模型权重 CC BY-NC 4.0 不同；训练和发布应遵守模型许可，商业使用需另行获得 StartLux 授权。

决策选型与语音模型分开。现有 Sherpaw 已接 ASR / KWS / VAD；继续复用。动态本地 TTS 尚未接入，计划使用独立 Sherpa-ONNX TTS worker；STEPFUN 云 TTS 与预生成温柔女声保持可用。现有唤醒受前台/失焦停止约束，不是全系统常驻唤醒。来源、平台支持和许可见 [语音核查](../research/2026-10-23-local-speech-stack.md)。

## 验证范围

本轮定向单元测试、类型检查及构建结果以交付消息为准。两个真实 macOS 引擎压缩档已下载核对 SHA256，并在 Windows 用解析器/安装器做文件级验证：正常安装回执有效、架构不匹配和二进制篡改拒绝。未执行 Mac 二进制，未将这些文件测试记作 Mac 运行验收。

没有重启或替换用户正在运行的 18787 服务，没有更改手机两页交互，没有采集麦克风、播放声音或推送 GitHub。Mac 原生 CI、StartLux 真实推理、微调、一键权重准备及动态本地 TTS 是明确的后续运行工作。
