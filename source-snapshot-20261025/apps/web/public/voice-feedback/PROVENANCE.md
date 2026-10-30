# 固定短反馈音频

三条文本由 Vivic 项目编写：「我看看」「稍等」「好的」。音频由开放权重模型离线合成，没有采集任何人的麦克风、没有克隆用户音色，也没有调用云语音或播放设备。音质和本人听感仍待允许发声后的人工验收。

- 原模型：[hexgrad/Kokoro-82M-v1.1-zh](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh/tree/01e7505bd6a7a2ac4975463114c3a7650a9f7218)，Apache-2.0；模型说明注明中文训练数据由 LongMaoData 授予。未使用许可标为 Unknown 的 Piper huayan。
- ONNX 转换：[csukuangfj/kokoro-multi-lang-v1_1](https://huggingface.co/csukuangfj/kokoro-multi-lang-v1_1/tree/914313412b607d95400bcd12446233fbd1248801)，revision 固定，Apache-2.0 全文在 `MODEL-LICENSE.txt`。未修改模型，选择 speaker 3、1.05 倍合成语速；这不是对任何具名个人的模仿。
- 开发时生成工具：sherpa-onnx 1.12.32（Apache-2.0）、NumPy 2.3.3、FFmpeg；预处理使用模型附带的 eSpeak NG 字典（GPL-3.0）。这些运行库、模型和字典未加入产品包，留在被忽略的 `.cache/`。产品只播放三个生成的 MP3，不提供新的本地 TTS 引擎。
- 后处理：24kHz 单声道、64kbps MP3；响度目标 -20 LUFS、真峰值 -3dB。音量继续受用户设置控制；不承诺设备上完全相同的听感。
- 文件 SHA-256、字节数、原始生成时长在 `manifest.json`。预录音没有词级时间戳，按句显示；不会用文字长度猜时间。

重新生成：先按固定 revision 准备 model.onnx、voices.bin、tokens.txt、lexicon-zh.txt、LICENSE 和 espeak-ng-data/，再用独立虚拟环境执行 `scripts/generate-short-feedback.py`。脚本验证模型文件散列，只输出文件。应用不会自动下载这些开发权重。
