# StepFun Coding Plan + TTS 最小接入

核实日期：2026-10-15。仅接入 StepFun Plan API Key，LLM 与 TTS 共用后端内存中的同一凭据。其他 provider、OAuth、ASR 与音色复刻暂缓。

同日增量：既有二进制接口兼容保留，新增可选 `timestamps`，通过同一 Plan SSE 响应取得音频与词轴；前端已接实际播放时钟/PCM 包络及本地固定短句。当前模型连接、独立语音和验收状态以 [架构](provider-voice-architecture.md) 与 [语音增量](voice-feedback.md) 为准；下文原「未提供词级时间戳」「OAuth/ASR 暂缓」描述为历史模块交接，不能覆盖当前实现。

## 官方依据

| 事项 | 官方来源与结论 |
| --- | --- |
| Plan 推理地址 | [推理模型接入](https://platform.stepfun.com/docs/zh/step-plan/integrations/reasoning-api)：OpenAI 兼容 base 为 `https://api.stepfun.com/step_plan/v1`，生成请求为 `POST /step_plan/v1/chat/completions`。 |
| Plan TTS 地址和模型 | [语音模型接入](https://platform.stepfun.com/docs/zh/step-plan/integrations/audio-api)：明确列出 `POST https://api.stepfun.com/step_plan/v1/audio/speech`、`stepaudio-2.5-tts` 与 `cixingnansheng` 示例；语音按实际用量折算为 Plan 额度消耗。 |
| TTS 参数与返回 | [语音合成 API](https://platform.stepfun.com/docs/zh/api-reference/audio/create-audio)：明确注明 Plan 专用地址；默认返回音频二进制，支持 MP3；上游文本最多 1000 字符。本项目主动限制为 200 字符。`stepaudio-2.5-tts` 会把括号内内容视作指导语，未必朗读。 |
| 音色白名单 | [官方音色清单](https://platform.stepfun.com/docs/zh/guides/developer/tts#官方音色清单)逐项列出适用模型；本项目仅提供其中明确支持 `stepaudio-2.5-tts` 的 8 个音色，详见下表。静态清单不证明个人账户的套餐权限。 |
| 语速与音量 | [语音合成 API](https://platform.stepfun.com/docs/zh/api-reference/audio/create-audio)确认 `speed` 为 `0.5–2`、默认 `1`，`volume` 为 `0.1–2`、默认 `1`。本项目向上游传语速；音量选择使用浏览器 `Audio.volume`（`0–1`，含静音），不向服务端传 volume，不叠加两次音量或语速调整。 |
| Key 校验与模型目录 | [查询 Model 列表](https://platform.stepfun.com/docs/zh/api-reference/models/list)：文档地址为 `GET https://api.stepfun.com/v1/models`。该请求仅查询目录，不是 LLM/TTS 生成；没有猜测未文档化的 `/step_plan/v1/models`。 |
| 套餐与独立余额 | [Step Plan 概述](https://platform.stepfun.com/docs/zh/step-plan/overview)：Plan 路径消耗套餐额度，普通按量 API 使用独立账户额度。模型目录不能证明某个账户已开通 Plan 或具有 TTS 权限。 |
| 历史 Coding Plan | [升级公告](https://platform.stepfun.com/docs/zh/announcements/step-plan-upgrade)及[最新调整公告](https://platform.stepfun.com/docs/zh/announcements/step-plan-usage-adjustment)：历史 Coding Plan 按次数，新 Token Plan 按 Credit；旧权益保留、续订和升级有区别。当前语音文档没有单独承诺每个历史 Coding Plan 的 TTS 权益。 |

文档通过官方站点公开的 `.md` 版本读取；入口索引为 [llms.txt](https://platform.stepfun.com/docs/llms.txt)。未使用真实 Key 验证个人账户套餐。

## 路由与失败行为

- 默认 `STEPFUN_BASE_URL=https://api.stepfun.com/step_plan/v1`。LLM/TTS 都使用此 base。
- Key 连接测试先读取官方 `/v1/models` 目录，再用选中的模型在 Plan 地址执行一次短 JSON 推理（最多 256 输出 tokens，消耗少量套餐额度）；两步都成功才保存 Key、显示已连接。TTS 权限仍需实际语音请求确认。默认 Plan 只在官方列出的推理模型中选取规划模型，语音专用模型绝不回退为对话模型。目录只有 TTS/ASR 时连接失败并清除旧凭据。
- 403 等上游错误仅提取有界 JSON 中的 `code/message` 和 `X-Trace-Id`，隐藏当前 Key、Bearer 与其他 `sk-` 字段后显示；不转发 HTML、完整请求/响应体或 headers。连接失败原因仅暂存本机后端内存，便于控制页刷新后继续查看；重新连接成功或断开时清除。403 不再一律提示断开重连。
- `STEPFUN_BASE_URL` 显式覆写保留，用于已有本地 stub；覆写时目录仍请求 `${base}/models`。TTS 拒绝将官方 StepFun base 配为普通 `/v1`，不跟随 HTTP 重定向，不尝试其他模型、普通计费路径或其他 provider。
- Plan TTS 的权限拒绝、404、额度不足/限速、网络错误或超时均返回明确的“语音不可用”；不保证历史 Coding Plan 具备 TTS 权益，不自动升级套餐或切换计费渠道。
- Key 只存在服务端进程内存。错误不透传上游正文、异常详情或 Key；不新增日志或持久化。后端重启清空凭据，需要重新连接。
- 连接验证使用 `connectionTimeoutMs ?? 12000`；TTS 使用 `speechTimeoutMs ?? 15000`，不随 planner 的 `requestTimeoutMs`（默认 45 秒）延长。TTS 的时限覆盖响应正文读取，正文卡住时会取消 reader。`/api/intent` 把原始请求 signal 作为 `runIntent` 第三参传入，既有意图行为由 pipeline 保持。

## 已核实的可选音色

以下是官方清单的安全子集，不声称列出全部音色。后端 `voices.ts` 与前端公开静态清单由离线测试核对一致；添加音色必须重新核实模型兼容性。

| 名称 | Voice ID |
| --- | --- |
| 磁性男声 | `cixingnansheng` |
| 温柔男声 | `wenrounansheng` |
| 儒雅男士 | `ruyananshi` |
| 经典女声 | `jingdiannvsheng` |
| 温柔女声（默认） | `wenrounvsheng` |
| 元气少女 | `yuanqishaonv` |
| 邻家姐姐 | `linjiajiejie` |
| 知性姐姐 | `zhixingjiejie` |

控制页使用已安装的 Radix Select，Input 调节语速、音量，Button 触发/取消试听。试听用当前音色和语速对固定短句执行相同的 Plan `/audio/speech` 合成，消耗套餐额度。未使用普通收费 API、复刻接口或第三方音频链接；无需猜测复刻试听接口是否接受官方音色。

## 本地 HTTP 接口

`POST /api/speech`，沿用现有本地会话 Bearer 鉴权；浏览器经同源代理调用，不持有后端令牌或 StepFun Key。

```json
{ "text": "已聚焦", "voice": "linjiajiejie", "speed": 1.2 }
```

JSON 仅接受 `text`、可选 `voice`、可选 `speed`。`text` 原始长度最多 200 个 UTF-16 码元，去除首尾空格后至少 1 个，拒绝控制字符、不可见格式字符和换行分隔符；`voice` 必须属于上述白名单；`speed` 必须是 `0.5–2` 的有限数值。原有 `{ "text": "已聚焦" }` 请求仍兼容，默认温柔女声和 1.3 倍速。前端未保存设置或重置语音偏好时采用相同默认值，已有有效偏好继续保留。请求体最多 4 KiB；客户端不能指定 Key、URL、模型、volume 或其他字段。

成功：`200 audio/mpeg` 二进制，`Cache-Control: no-store`，音频最多 4 MiB。固定使用 `stepaudio-2.5-tts` 和 `mp3`。失败：`{ "ok": false, "code": "speech-...", "error": "可读错误" }`；未连接/Plan 不可用为 503，超时为 504，无效音频为 502，输入错误为 400/413/415，未鉴权为 401。请求取消传递给上游；合成期间连接变更会丢弃旧音频。

`GET /api/speech/voices` 使用同一本地会话鉴权，无需连接 StepFun，也不发上游请求。返回 `{ model, voices: [{ id, name }], defaultVoice, speed: { min, max, default }, source, verifiedAt }`。此接口是有来源的静态安全子集，不是账号权限探测。

## 控制端调用签名

```ts
import {
  speakText, previewSpeech, cancelSpeech,
  setSpeechEnabled, setSpeechPreferences, subscribeSpeech, getSpeechSnapshot,
} from "@/ai/speech";

const result = await speakText("已聚焦", { requestId: "unique-command-id", signal });
// signal?: AbortSignal
// result: { status: "completed" | "skipped" | "cancelled" }
//       | { status: "error"; error: string }

cancelSpeech();                  // 中止请求、播放并释放资源
setSpeechEnabled(false);         // 关闭时同时取消
setSpeechPreferences({ voice: "linjiajiejie", speed: 1.2, volume: 0.6 });
// 返回 boolean：无效设置为 false，不修改状态；存储失败仍更新内存，另报 preferenceError
await previewSpeech({ requestId: "optional-preview-id", signal });
// 两项均可选；自动生成唯一 ID。即使 enabled=false 也可试听，不开启自动语音
const unsubscribe = subscribeSpeech(() => { /* 读取 getSpeechSnapshot() */ });
unsubscribe();
```

`SpeechSnapshot` 公开字段：

```ts
{
  enabled: boolean;
  status: "idle" | "loading" | "playing" | "error";
  loading: boolean;  // 严格等于 status === "loading"
  playing: boolean;  // 严格等于 status === "playing"
  requestId: string | null;
  text: string | null;
  kind: "feedback" | "preview" | null;
  error: string | null;
  preferences: { voice: SpeechVoiceId; speed: number; volume: number };
  preferenceError: string | null;
}
```

`loading` 表示请求/缓冲中，播放 Promise 成功后才进入 `playing`；进入这两种状态时同时带本次 `requestId`、已 trim 的 `text` 和 `kind`。自然结束时 `status` 回到 `idle`，两个布尔值均 false，保留本次 ID/文字/类型，便于识别结束事件；服务/播放失败同样保留本次身份。取消会清空 ID、文字、类型和错误；新请求先清空旧状态，再发布新请求身份。重复或已禁用的调用会返回 skipped，不伪造播放事件。

主线程根据 `status` 同步字幕/Orb：`loading` 表示准备语音，`playing` 表示实际说话并延长活动 lease，`idle/error` 清理显示；用 `requestId` 关联请求。试听同样发布 ID 与全文，正常显示字幕，仅 control owner 广播，其他窗口不重复播放。此接口未提供词级时间戳，不能声称逐字同步。完成/错误也保留身份，订阅者不能仅凭非空 `text` 判定正在播放。

浏览器 `speakText` 接受纯文本：去首尾空格，超过服务端 200 个 UTF-16 码元上限时截断，边界不切断 emoji 的代理对；仍拒绝控制/不可见格式字符。snapshot 的 `text` 始终等于实际提交合成的全文，160 字提醒不受影响。字幕显示上限（如 120 字）由主线程处理，本轮整句同步。多条到期提醒由调用方串行 `await speakText(...)`，本模块仍保持 latest-wins，不新增内部队列。

AiSection checkbox 与模块使用同一个内存开关；默认关闭、页面刷新恢复关闭，不写入 storage、BroadcastChannel 或画布。开启 checkbox 本身不请求音频；成功结果由 ControlApp 调用 `speakText`。取消/新指令/切画布/失去控制权时由调用方执行 `cancelSpeech()`，或 abort 对应 signal。语音模块与同步协议、舞台无耦合。AiSection 卸载时仅 abort 自己的试听 signal。

仅 `{ voice, speed, volume }` 写入浏览器 `localStorage["vivic.speech.preferences.v1"]`，重新加载时逐字段校验白名单和数值范围；损坏/非法字段恢复默认，其他字段全部忽略。无 Key、token、文本、请求 ID、开关或播放状态持久化，也不枚举其他 storage 项。读写被拒绝时内存设置仍可使用，控制页显示无法保存的提示。音量实时应用于当前音频，调节不发请求；改变音色/语速会取消旧合成或旧音频，下次播放使用新设置。

重复 `requestId` 在最近 128 条记录内直接跳过；不同 ID 可以朗读相同短句。新口播会中断旧口播。请求取消、关闭开关、播放结束、解码/自动播放失败、页面离开均清理音频事件、音频 source 和 object URL，不自动重试播放。浏览器自动播放限制会作为错误显示在开关旁。

## 离线验证

```bash
pnpm --filter @vivic/local-api test
pnpm --filter @vivic/local-api exec vitest run tests/speech.test.ts tests/speech-player.test.ts
pnpm typecheck
```

API 测试全部注入 fetch；播放器生命周期与偏好测试使用 Audio/fetch/storage mock，覆盖刷新恢复、开关不恢复、保存失败、白名单、上下限、音量实时调整、试听、字幕身份与取消清理。不启动或停止 web/API 服务，不占用端口。配置测试只在空临时目录注入假令牌，不读取项目 `.env`。本轮未运行 web e2e 或 `test:live`，也未用真实 Key 发起请求；真实音质、延迟、浏览器视觉/实际音频输出及具体旧套餐权益由主线程继续验收。
