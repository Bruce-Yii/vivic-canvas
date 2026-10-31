# 图片输入：独立模块与主线接入契约

> 主线集成更新（2026-10-15）：控制端附件、共享请求契约、Sharp 完整像素解码、能力检测及 StepFun/GPT 图片请求均已接通；真实 GPT 图片算式返回 43，刷新后图片不进入画布。详见 [交付报告](../evidence/phase3-final/REPORT.md) 与 [真实浏览器记录](../evidence/phase3-live-browser/live.json)。下文按模块交付顺序保留历史范围及限制，早期「未集成」不代表当前状态。

对应交接包 PRD §1.2、§2.1、§7，以及 ACCEPTANCE C09/C10。本次只交付图片处理和 validator，没有接入 ControlApp、CommandSection、API 路由、模型或 contracts。

## 接口

浏览器 `apps/web/src/ai/attachments.ts` 导出：

```ts
type ImageMime = "image/png" | "image/jpeg" | "image/webp";
interface Attachment {
  type: "image";
  mime: ImageMime;
  data: string; // 纯规范 base64，不带 data: 前缀
}

prepareImageAttachment(files: readonly File[], options?: { signal?: AbortSignal }): Promise<{
  attachment: Attachment;
  previewUrl: string; // 本标签页生成的 blob: URL
  width: number;
  height: number;
  dispose(): void; // 幂等，释放预览 URL
}>;
```

选择只允许 1 张，原始文件非空且最多 **4 MiB = 4,194,304 bytes**，仅 PNG/JPEG/WebP。真实字节签名、容器边界、文件头尺寸均检查；非空 MIME 必须与真实格式相符，空 MIME 可以通过真实字节识别。文件名和扩展名不作为可信格式依据。每边最多 **8192**，总计最多 **16,000,000 像素**；先检查头部尺寸再解码，解码后再次检查。拒绝 APNG、动画 WebP、SVG、HTML、GIF、图片链接、路径和损坏/截断的容器。

浏览器必须成功解码像素，然后用 canvas 重绘、最长边缩到 **1600**，重编码为静态 PNG。这去掉原文件的 EXIF/GPS、文本元数据和文件名；请求与预览都只使用重编码字节。JPEG 的 EXIF 方向可能交换宽高，因此仅 JPEG 允许解码尺寸交换，其他不一致拒绝。输出仍须非空且不超过 4 MiB；无法重编码、超时、输出过大均明确报错，不回退上传原图。PNG 输出保留透明度，但缩图可能影响细小文字，用户可裁图后重新加入。

`imageFilesFromTransfer` 只提取当前粘贴/拖拽事件提供的文件，忽略 URL/HTML 字符串；不读 Clipboard API、不截图、不扫描文件系统、不下载 URL。

控制页组件 `apps/web/src/control/ImageAttachment.tsx`：

```tsx
<ImageAttachment
  disabled={disabled}
  ownerKey={`${canvasId}:${controllerEpoch}`}
  resetKey={attachmentResetVersion}
  visionAvailable={verifiedVisionAvailable}
  onChange={setDraftAttachment} // Attachment | null，父级标签页内存草稿
  onProcessingChange={setImageProcessing}
/>
```

`ownerKey` 必填：画布 ID 与控制权 epoch 的组合；画布切换、控制权转移都必须改变它。`disabled` 默认 false；`visionAvailable` 默认 false，尚未验证可用时始终显示“当前没有可用的视觉模型，无法分析图片”。即使视觉不可用，仍可在本地准备草稿，组件不发起分析，也不提供发送动作。复用项目已有 shadcn Button/Input 和 Lucide 图标，没有新 UI 依赖。

组件仅在区域内响应粘贴和拖拽，也提供显式文件选择。换图先丢弃旧图；多图明确报错，不静默截取第一张。文本粘贴留给普通文本输入处理；仅链接/网页内容的拖入明确拒绝，且阻止浏览器导航。选择文件对话框取消时保留已有草稿；组件的“移除/取消处理”清空草稿。

原始解码 ObjectURL 在成功、失败、取消或超时后均释放。输出预览在替换、移除、`ownerKey` / `resetKey` / `disabled` 变化和卸载时释放，并通知父级 `onChange(null)`。处理中用 AbortController 与任务代次阻止旧结果回流到新画布。解码与编码分别最多等待 15 秒。原生解码不能保证即时终止底层 CPU 工作，但迟到结果不会恢复附件。

## 后端安全边界

`apps/local-api/src/images.ts` 使用现有 Zod，不新增 Node 依赖：

```ts
ImageAttachmentSchema;  // 严格对象，仅 type/mime/data
ImageAttachmentsSchema; // 0 或 1 张，逐个运行上述结构校验
type ImageDecoder = (bytes: Uint8Array, mime: ImageMime) => Promise<{ width: number; height: number }>;

validateImageAttachment(input: unknown, decode?: ImageDecoder): Promise<{
  attachment: Attachment; bytes: Uint8Array; width: number; height: number;
}>;
assertImageAnalysisAvailable(visionAvailable: boolean): void;
imageInputErrorMessage(error: unknown): string;
```

Schema 拒绝未知字段（含 url/path/filename）、data URL、URL、路径、空白、base64url、非规范 padding/尾位；先限编码长度，再检查实际字节数，避免 4 MiB 边界被 padding 绕过。MIME 枚举必须与真实签名一致。PNG 遍历 IHDR/IDAT/IEND，JPEG 检查 SOF/SOS/EOI，WebP 检查 RIFF 长度、VP8/VP8L/VP8X 帧尺寸与动画标记；文件头尺寸须满足相同限制。原始字节和 schema 错误均不得记录或回显。

**Schema 与 `inspectImageBytes` 仅为结构预检，不能证明压缩像素有效。** 例如合法文件头包着损坏的压缩数据，必须靠真正解码拒绝；结构预检不验证全部 PNG CRC、JPEG 熵编码或 WebP 压缩流。不要把 `ImageAttachmentSchema.parse()` 成功当成可转发模型的许可。

**最终放行必须调用 `validateImageAttachment` 并注入真实的本机像素解码器。** helper 比较完整解码后的尺寸与头部尺寸，解码异常只返回固定安全错误；未配置解码器则明确拒绝“图片分析暂不可用：本机尚未配置安全的图片解码器”。本次没有 Node 像素解码库，因此没有声称后端完整解码已可用。主线若添加解码依赖，应先说明依赖及资源限制，再在此接口注入；解码器必须限制内存/耗时/并发、实际解码所有像素、禁外部资源引用、返回未应用方向交换的原始宽高，不得只读文件头。helper 不自行启动子进程、读宿主文件或发网络请求。

## 主线接入顺序与隐私责任

1. 组件仅挂载 `/control`。附件保存在局部 React state/ref，不挂载到 CanvasStore、全局持久化 store、Display、BroadcastChannel、IndexedDB、localStorage、sessionStorage、导出 JSON、日志、错误上报或长期上下文。
2. 发送按钮必须等待 `onProcessingChange(false)`，并且只有用户显式点击“发送”才构造当次附件请求。不要让语音自动发送、快捷规则或选图回调隐式提交图片。正在处理时 `onChange(null)` 是清空旧草稿，不能据此把图片操作当成纯文本命令直接发送。
3. 发送前验证当前 owner 与画布仍匹配，确认视觉模型真实可用。后端也调用 `assertImageAnalysisAvailable`，不可相信浏览器传来的 capability。无视觉模型或无解码器时拒绝图片分析；不得丢掉附件后让纯文本模型装作看过图片。
4. 主线扩展请求 schema/路由时先设置请求体大小限制（base64 上限 **5,592,408 字符**，另加严格限制的文本/JSON 开销），再执行严格 schema、完整像素解码与图片能力检查。不要全局调大所有请求体限制。错误响应只用 `imageInputErrorMessage` 这类受控消息，禁止记录请求体、原始 ZodError 或 decoder/provider 的原始异常。
5. 只把重编码后的 `Attachment` 放进这一次视觉请求。不要拼入普通 canvasContext、sourceDataSummary、聊天历史或后续轮次上下文；不要把 base64 当文字给模型。视觉请求的具体 provider 适配与现有 api/contracts 修改由主线负责，本次未增加模型或图片生成服务。
6. 用户发送完成/失败/取消、清空、画布切换或 owner 丧失时递增 `resetKey` 或修改 `ownerKey`，同时中止主线正在发送的请求并清除父级副本。组件取消只停止本地图片处理；已发出的网络请求必须由主线自己的 AbortController 中止。不要把 `disabled` 当成单纯冻结预览，它会清空附件。组件卸载会通知父级清空；父级不得保留其他附件副本。

浏览器没有主动联网、写存储或同步路径；主线接入后仍必须验证请求、错误处理、同步、导出、遥测和历史路径不收集图片。JS 不提供可靠的字符串/已复制请求内存擦除保证；这里的清理含义为撤销 ObjectURL、放弃引用与阻止迟到结果，不宣称物理清零。

## 验证与限制

本次离线验证：后端专属 **28** 项、浏览器/组件专属 **26** 项，共 **54** 项通过；两端 TypeScript 检查通过。只增加本说明、三个独立实现文件及 images/attachments 专属测试，没有修改主线集成文件、contracts 或 package，也没有引入依赖。当前会话无可调用的 subagent 工具，因此本组文件由当前 agent 直接完成，没有递归 spawn。

可重现的离线测试（不需要启动任何服务端口）：

```sh
cd apps/local-api
pnpm exec vitest run tests/images.test.ts
pnpm exec tsc -b --pretty false
cd ../web
pnpm exec vitest run src/ai/__tests__/attachments.test.ts src/control/__tests__/ImageAttachment.test.tsx
pnpm exec tsc -b --pretty false
```

所有 fixture 均由专属测试 helper 自生成，未读取或对外发送用户图片。PNG 使用 Node 自带 zlib 和自算 CRC 生成有效的 2×1 TEST 图片；JPEG/WebP 是用于容器预检的合成头部，不冒充完整有效压缩图片。大尺寸 PNG 仅修改头部以验证解码前限制，不分配大图片。

浏览器测试使用 jsdom，mock 原生 Image 与 canvas：验证重绘和编码调用、只使用重编码字节、格式限制、取消/超时、清理、owner 隔离、组件无网络/存储行为；它们**没有验证真实浏览器 codec、EXIF 旋转或视觉布局**。未启动 Playwright、端口、声音或麦克风。主线还需在 Chrome/Safari 手动验证真正的 PNG/JPEG/WebP、EXIF/GPS 去除、透明图、同图再次选择、拖拽/粘贴、发送/取消与切画布行为；本交付不宣称 C09/C10 全应用验收已完成。

## 更新：真实本机解码器（Sharp 0.35.5）

本节更新前述“本次没有 Node 像素解码库”的交付状态：主线现已安装 **sharp@0.35.5（exact，Apache-2.0）**，本次新增 `apps/local-api/src/imageDecoder.ts` 与 `apps/local-api/tests/imageDecoder.test.ts`，不修改 images/schema/app/pipeline/contracts/package。测试机器实际加载 Sharp **0.35.5**、libvips **8.18.7**（darwin arm64 预编译包），已运行真实 PNG/JPEG/WebP 完整像素解码。

主线接入接口：

```ts
import { decodeImage } from "./imageDecoder.js";
import type { ImageDecoder } from "./imageDecoder.js";

// decodeImage 的类型为 ImageDecoder；也可通过主线 AppDeps 注入同类型 decoder。
const validated = await validateImageAttachment(requestAttachment, decodeImage);
// validated.width/height 是完整像素解码结果，原始方向与文件头一致。
```

decoder 只接受内存 `Uint8Array`/`Buffer`，自身再次限制非空、最多 4 MiB、真实 PNG/JPEG/WebP 签名、容器、MIME 与每边 8192/总像素 16,000,000 的尺寸规则；字符串路径、URL、SVG/HTML 均不能交给 Sharp。输入先复制到独立 Buffer 再校验，防止调用者在异步等待期间改写已校验字节。没有文件输出、日志、网络调用或像素持久化。

实际 Sharp 配置：

```ts
sharp(inputBuffer, {
  failOn: "warning", limitInputPixels: 16_000_000, limitInputChannels: 4,
  sequentialRead: true, animated: false, autoOrient: false,
}).timeout({ seconds: 3 });
```

先读取 metadata，严格对比真实格式、原始方向宽高与结构预检结果，限制单帧、最多 4 通道，再执行 `.raw({ depth: "uchar" }).toBuffer({ resolveWithObject: true })`，强制解码全部像素。最后再次比较完整解码尺寸，并检查 raw 格式、通道数与 `data.byteLength === width * height * channels`；只返回 `{ width, height }`。官网明确 [metadata 不会解码压缩像素](https://sharp.pixelplumbing.com/api-input/#metadata)，所以没有 metadata-only 成功路径。

真实 fixture 暴露并已补强的边界：

- libvips 8.18.7 可成功解码带错误 IEND CRC 的 PNG。decoder 因此自行校验 **所有 PNG chunk 的 CRC32**，包括 IHDR/IDAT/IEND 与 ancillary chunk，而不是假设完整像素解码会检查每个结束块。
- 某些损坏的 1×1 JPEG 即使设置 `failOn: "warning"`，仍会 resolve 像素并发出 `warning`。decoder 额外监听 warning，仅保存布尔标志，metadata/完整解码后任一 warning 均拒绝，不保留或回显 native warning 文本。此行为由真实损坏 JPEG fixture 验证。严格等级按 [官方 constructor 建议](https://sharp.pixelplumbing.com/api-constructor/#new) 使用 warning。

资源与清理：

- 单进程模块最多 **2 个未结束任务**，同时包含 metadata 和 raw 解码阶段。第三个直接返回“图片解码繁忙”，没有等待队列，也不会为其创建 Sharp 任务。
- native 工作设置 **3 秒**处理超时；按 [Sharp `.timeout({ seconds })` 官方契约](https://sharp.pixelplumbing.com/api-output/#timeout)，计时不包含 libuv 等待。另设 **5 秒**调用等待期限，覆盖异步 metadata、队列等待与 raw 处理。若调用先超时，**native 任务实际结束前仍占用并发名额**；不得因 Promise.race 返回就接纳第三个任务。若 metadata 超时后才返回，不再启动 raw 解码。
- 5 秒是调用等待期限，native `.timeout` 是 libvips 协作式工作限时，均不等同于操作系统强杀。若 native 工作长时间未结束，名额继续占用，后续请求保持拒绝。这里没有额外 worker/子进程，也不声称可在任意 native 故障下精确终止 CPU。
- raw 输出固定 8-bit，最多 4 通道，因此单张 raw 输出不超过 **64,000,000 bytes**；两路最多 **128,000,000 bytes** 的 raw 输出，再加输入与 native 内部开销。这是 raw 输出限制，不是整个进程 RSS 的硬上限。
- 成功、失败、迟到解码结果都在任务结束时清零本模块持有的 raw Buffer、清零输入副本、销毁 Sharp 实例并释放引用。调用者原始输入不被修改。只返回宽高，不返回像素，也不保留图片任务缓存。
- 模块调用 `sharp.cache(false)`，这是 [进程级 Sharp/libvips 缓存设置](https://sharp.pixelplumbing.com/api-utility/#cache)，会影响本进程其他 Sharp 使用者；主线不要为用户图片重新启用该缓存。没有修改 `sharp.concurrency()`，因为它控制每张图使用的线程数，不能代替两个任务的并发门限。native 内部临时内存的回收由 Sharp/libvips 管理，不宣称能擦除其全部物理内存副本。

主线继续负责当次附件请求、真实视觉模型能力判定、AppDeps 注入与错误映射。默认无视觉能力的模型必须明确拒绝图片分析，不能丢弃附件后走文本；decoder 不选择模型、不发送图片，也不修改该行为。现有 `validateImageAttachment` 会把 decoder 异常映射为固定“图片无法解码或文件已损坏”，若主线需要区分繁忙/超时，可安全识别 decoder 的 `ImageInputError`，不要回显原始 Sharp 异常。

可重现验证：

```sh
cd apps/local-api
pnpm exec vitest run tests/imageDecoder.test.ts tests/images.test.ts
pnpm exec tsc -b --pretty false
```

decoder 专属 **25 项通过**，加既有 images validator **28 项，共 53 项通过**。有效 fixture 为本地 Sharp 从自生成 TEST RGB Buffer 编码的真实 1×1 PNG/JPEG/WebP；另有真实 EXIF 方向 JPEG、CRC 损坏、正确 CRC 的错误压缩流、JPEG scan 损坏、WebP 压缩数据损坏与伪造尺寸 fixture。没有读取或对外发送用户图片，没有 Playwright、服务端口、声音或麦克风。仅资源调度、迟到结果、metadata/raw 返回不一致及 native timeout 错误映射用可控 Promise/mock；有效和损坏格式的 codec 测试都使用真实 Sharp。native 3 秒限时验证了实际 API 参数及超时异常映射，没有伪称通过小图测试制造过真实 3 秒解码超载。

新增 decoder 与专属测试的独立类型检查通过，可单独复现：

```sh
pnpm exec tsc --ignoreConfig --noEmit --target es2023 --lib es2023 --module esnext --moduleResolution bundler --verbatimModuleSyntax --erasableSyntaxOnly --strict --skipLibCheck --types node src/imageDecoder.ts tests/imageDecoder.test.ts
```

当前整个 local-api 类型检查另有共享主线 `tests/gpt-http.test.ts` / `tests/gpt.test.ts` 的类型错误；新增 decoder 与专属测试未报告错误。这些主线文件未修改。
