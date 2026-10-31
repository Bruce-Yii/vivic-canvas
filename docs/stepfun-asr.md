# StepFun Plan 按住说话 ASR 后端

核实日期：2026-10-15。该模块只做音频转文字，不调用 intent、不执行转写中的指令。复用现有 `CredentialStore` 的同一 StepFun Plan 内存凭据；无第二把 Key、环境变量读取、落盘或音频/凭据日志。

## 官方依据与准确协议

通过官方 [文档索引](https://platform.stepfun.com/docs/llms.txt) 定位并使用 `curl -fsSL` 读取下列 `.md` 正文：

- [Plan 语音模型接入](https://platform.stepfun.com/docs/zh/step-plan/integrations/audio-api.md)：当前 Plan ASR **仅支持 HTTP + SSE、`stepaudio-2.5-asr`**，路径明确为 `POST https://api.stepfun.com/step_plan/v1/audio/asr/sse`。语音用量折算消耗 Plan 额度；账户是否有权限仍以实际响应为准。
- [语音识别 SSE API](https://platform.stepfun.com/docs/zh/api-reference/audio/asr-sse.md)：明确 Plan 专用路径、JSON/Base64 请求、格式字段及 SSE 事件。通用文档推荐的较新模型不能覆盖 Plan 页当前列出的模型限制，因此固定使用 `stepaudio-2.5-asr`。
- [音频文件识别](https://platform.stepfun.com/docs/zh/api-reference/audio/asr.md)：这是普通 API 异步 URL 文件任务接口，不适用于本次内存上传。当前 Plan 文档没有授权 `/audio/transcriptions`，因此不猜测该路径，不回退普通 `/v1`。

实际发送的一次请求（此处 Base64 仅为占位符）：

```http
POST https://api.stepfun.com/step_plan/v1/audio/asr/sse
Authorization: Bearer <后端内存中的同一 Plan Key>
Content-Type: application/json
Accept: text/event-stream
```

```json
{
  "audio": {
    "data": "<仅PCM采样字节的Base64，不含WAV头，不含data:前缀>",
    "input": {
      "transcription": {
        "model": "stepaudio-2.5-asr",
        "language": "zh",
        "enable_itn": true
      },
      "format": {
        "type": "pcm",
        "codec": "pcm_s16le",
        "rate": 16000,
        "bits": 16,
        "channel": 1
      }
    }
  }
}
```

官方事件的 JSON discriminator 为 `type`：

| type | 使用的字段 | 本模块行为 |
| --- | --- | --- |
| `transcript.text.delta` | `delta: string` | 验证字段类型，不交付部分转写。 |
| `transcript.text.done` | `text: string` | 只使用这一完整最终文本；`meta`、`usage` 不向客户端转发。 |
| `error` | 官方有 `message` | 返回本地固定错误，不泄漏上游 message。 |

支持 UTF-8 跨 chunk、SSE 注释、LF/CRLF/CR 和多行 `data:`；必须收到完整分隔的 done 事件才成功。未知事件、损坏 JSON、仅 delta、提前结束、空白/不可见文字、超长文字都失败，不拼接 delta 猜测最终内容。读到 done 后取消剩余响应。上游响应累计最多 64 KiB，流读取受同一时限限制。

## 主线程挂载

公开导出：

```ts
import { createAsrRoutes } from "./asr.js";

// config: LocalApiConfig & { asrTimeoutMs?: number }
// credentials: 已有 CredentialStore 实例，必须与连接/断开路由共用
// fetchImpl?: typeof fetch，供离线测试注入
app.route("/api", createAsrRoutes({ config, credentials, fetchImpl }));
```

子应用只注册 `POST '/transcribe'`，最终地址 `POST /api/transcribe`。主线程在挂载之前统一执行 session auth 和 origin 防护；子应用不重复读取/创建本地 token，不提供凭据路由。

**集成注意：**原 `app.ts` 的全局 POST `Content-Length` 限制为 `config.bodyLimitBytes`（默认 64 KiB），会提前拒绝较长录音。主线程负责仅对转写路径放宽到 `5 MiB + 64 KiB`；模块内仍采用下面更严格的文件/请求体限制，自行逐 chunk 限制实际请求体，不能只依赖 Content-Length。本次未修改 app/config/schemas/package 文件。

`stepfunBaseUrl` 仅接受 `https://api.stepfun.com/step_plan/v1`（允许尾部 `/`），代理、自定义 host、HTTP、查询参数、普通 `/v1` 全部拒绝。测试也使用该官方地址字符串，但始终注入 mock fetch，不联网。请求 `redirect: 'error'`，无重试、模型切换、普通计费或其他 provider 回退。

## 本地上传与输出契约

请求只能是 `multipart/form-data`，恰好一个名为 `file` 的文件字段。拒绝重复文件、文本 file、额外字段和任何 URL 查询参数，包括 URL/path/prompt/model/apiKey/duration 等。文件名不作为路径使用，也不转发到上游；本地 multipart 在内存中解析，再构造固定的上游 JSON。

- MIME 白名单：`audio/wav`、`audio/wave`、`audio/x-wav`。不接受 WebM、MP4、裸 PCM、JSON、octet-stream。
- 文件上限 **5 MiB**；完整请求体上限导出为 `ASR_BODY_LIMIT_BYTES = 5 MiB + 16 KiB`，额外部分仅为 multipart framing allowance。即使没有 Content-Length 或声明不实，实际读取超限也会取消流并返回 413。
- 要求规范 RIFF/WAVE，RIFF 总长度精确匹配；只接受顺序为 `fmt ` + `data` 的两个 chunk，`fmt ` 长度为 16。不接受其他元数据 chunk、重复 chunk、截断数据或尾随字节。
- WAV `audioFormat=1`（PCM）、`channels=1`、`sampleRate=16000`、`byteRate=32000`、`blockAlign=2`、`bitsPerSample=16`；数据非空且长度为偶数。
- PCM 最大 **1,920,000 字节**，精确对应 **60 秒**（`dataSize / 32000`）；60 秒可接受，超过一个采样即拒绝。服务端因此可以独立证明时长上限，不相信客户端 duration 字段。
- 提取 `data` 中的 PCM 采样字节，上游不携带任何 RIFF/fmt/data 头。

成功为 `200 application/json`，`Cache-Control: no-store`，仅返回：

```json
{ "ok": true, "text": "创建一个十分钟倒计时" }
```

最终文字先 trim，长度为 **1–500 个 UTF-16 码元**，必须有可见内容，拒绝控制字符/格式字符。失败统一为 `{ "ok": false, "code": "asr-...", "error": "中文原因" }`，无 text；400 表示非法 multipart/WAV/超过 60 秒，413 为字节超限，415 为 content type 不支持，502 为无效/空/超长上游结果，503 为未连接/Plan 配置/上游或网络拒绝/取消，504 为超时。父中间件负责未授权 401 和来源拒绝。

默认总时限 **30 秒**，可通过局部扩展的 `config.asrTimeoutMs` 设置为 1–90,000ms；非法值恢复默认。时限覆盖上传 body、multipart/文件读取、上游请求及 SSE 读取，原始请求 abort 同样传递。读取卡住会取消 reader；忽略 abort 的 mock transport 也不能让路由无限等待，迟到响应会取消。

在上传前保存当前凭据对象身份；上传结束再次检查，阻止以已经失效的连接发新请求。上游完成后再次检查对象身份，断开或重新连接后丢弃旧转写，即使新连接使用相同 Key 字符串。现有 store 无变更事件，因此这里保证不交付旧结果，不声称凭据变更会即时中断已发出的上游请求。

## 浏览器集成约定（由主线程实现）

主线程已决定使用 AudioWorklet 采集 PCM，最后封装规范 WAV。官方 SSE 支持 `ogg/mp3/wav/pcm/m4a`，没有列出 WebM；本地契约主动统一 WAV，不直接接收 MediaRecorder 的 WebM/Opus 或 MP4/AAC，也不在服务端引入 ffmpeg/子进程。

工作节点输出必须是真实 **16kHz、mono、signed little-endian PCM16**。不要只把任意采样率的 Float32 数据写成 16kHz WAV；检查实际 AudioContext sampleRate，在浏览器内正确重采样和混为单声道。浏览器从录音开始计时强制停止于 60 秒，累计 PCM 字节不得超过 1,920,000，最终文件也检查 5 MiB；在取消、失去控制权、切画布、断开/重连时停止麦克风 tracks/工作节点、abort 请求并递增本地 generation，丢弃旧回调。

下面是将已经采集好的 PCM16 字节封装为本契约 WAV 的最小函数，供主线程复用（不承担采集或重采样）：

```ts
function pcm16Mono16kToWav(pcm: Uint8Array): Blob {
  if (!pcm.length || pcm.length % 2 || pcm.length > 1_920_000) {
    throw new Error("录音应为非空、最多60秒的PCM16 mono 16kHz");
  }
  const bytes = new Uint8Array(44 + pcm.length);
  const view = new DataView(bytes.buffer);
  const tag = (offset: number, value: string) =>
    [...value].forEach((char, index) => { bytes[offset + index] = char.charCodeAt(0); });
  tag(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); tag(8, "WAVE");
  tag(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  tag(36, "data"); view.setUint32(40, pcm.length, true); bytes.set(pcm, 44);
  return new Blob([bytes], { type: "audio/wav" });
}

const body = new FormData();
body.append("file", pcm16Mono16kToWav(pcm), "recording.wav");
const response = await fetch("/api/transcribe", { method: "POST", body, signal });
// 浏览器不要手动设置 multipart Content-Type，保留自动生成的 boundary。
// 本地会话认证由现有同源代理/中间件注入，浏览器不持有 StepFun Key。
```

ASR 成功仅得到待确认文字。失败必须展示原因并保留文字输入途径；未知/空/大/错误/超时结果不得自动执行。是否提交文字给 intent 由主线程明确的人机流程控制，ASR 模块没有自动执行路径。

## 离线验证

```sh
pnpm --filter @vivic/local-api exec vitest run tests/asr.test.ts
pnpm --filter @vivic/local-api test
pnpm --filter @vivic/local-api typecheck
```

适配器单测直接组合 `createAsrRoutes` 与测试父级 auth/origin 中间件，不要求 app.ts 已挂载；使用假内存凭据和 mock fetch，不读取真实 Key/env、不启停服务。覆盖 WAV 签名与采样规格、真实60秒边界、未知/重复字段、无Content-Length大包、官方参数、SSE分块/错误/最终文本、响应上限、上传/请求/响应体超时、取消、连接变更及错误脱敏。单测本身不代表真实账户或浏览器录音行为；后续主线程的真实验证另列如下。

适配器子任务阶段：ASR单文件55/55通过；当时搜索子任务尚在编写，因此曾有范围外测试/类型错误。主线程集成后已解决，最终API397/397、web101/101通过，类型检查与构建通过。

后续真实验证也已完成：当前Plan Key实际识别合成中文录音，HTTP200、556ms，返回「十分钟后提醒我喝水。」；独立浏览器原生AudioWorklet采集合成麦克风并调用真实ASR，转写检查后成功创建600秒喝水提醒。原始硬件麦克风和现场人声没有采集。完整记录见 `evidence/phase2-voice-input/REPORT.md` 与 `live*.json`，不是mock成功。2026-10-21 起默认自动发送，用户可关闭后检查文字再发送；ASR 模块本身仍只返回文字。
