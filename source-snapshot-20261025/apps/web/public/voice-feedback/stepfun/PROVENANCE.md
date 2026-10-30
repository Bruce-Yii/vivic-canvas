# STEPFUN 温柔女声反馈

16 段自编通用中文短句于 2026-10-22 通过用户授权的 StepFun Plan 生成，使用 `stepaudio-2.5-tts`、官方 `wenrounvsheng` 音色、1.0 语速。没有克隆真人声音。仅生成文件，尚未做扬声器听感验收。

来源：[官方语音合成接口](https://platform.stepfun.com/docs/zh/api-reference/audio/create-audio)，本次核对其 `.md` 文档。请求固定使用 Plan 接口；无按量接口回退。manifest 保存每段自编文本、字节数与 SHA-256，不含凭据、请求头、账户信息或用户对话。

生成器：`scripts/generate-stepfun-feedback.mjs --key-stdin`。凭据只从标准输入进入进程内存，不写入制品。已有 Kokoro 三段素材及其原始来源仍保留在父目录，未改写历史来源。

应用仅在真实反馈文字完全相等、用户选中温柔女声且已开启语音时复用；其他音色与自定义内容走原选择的服务。试听始终使用所选服务，不把预生成文件冒充实时合成。完成、保存等短句不会自行触发业务成功状态。
