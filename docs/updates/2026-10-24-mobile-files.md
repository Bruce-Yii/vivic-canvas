# 手机传送门、子卡片与只读文件卡

本轮在已有 Hark 组件和唯一电脑 owner 上增量实现，未推送、发布或改动公网服务。

## 手机

- 聊天 / Space 仍是两个主页面。Space 卡片「移到聊天」移动同一张共享卡片；原 Space 与电脑展示页消失，聊天与电脑用户页显示。支持移回，正文、进度、固定、子卡片均保留。
- 新 `card.surface` 操作独立授权，检查设备会话、owner epoch、当前画布与版本；复用 host.setCardSurface 和 durable flush。执行或保存不明确时显示未知、查询同一请求，不重发移动。
- 卡片右上角气泡展示安全投影的子卡片；手机底部面板只读。旧行锚点失效的子卡片不投影，不转发原始 metadata。
- 手机按电脑提供的顺序和单层分区标题纵向展示。没有画布编辑器、手机 owner 或第二份画布数据库。
- 文件卡显示正文摘要与原件预览 / 下载。配对电脑以 16 KiB 分段提供原件，保持每帧 32 KiB 上限；每段及最终 SHA-256 后均检查当前授权、owner、画布版本与文件摘要。换控制权、撤权、断连或换文件取消下载和待完成的原生保存。
- 旧中继未授予新操作时隐藏传送门 / 下载，owner 同时剔除旧严格协议无法理解的新字段。新版服务与新版手机配套使用；没有改造或重发已有公网中继。

## 文件卡与存储

- 每次最多 **5 个**，合计 **10,000,000 字节**；每个 Space 最多 **100,000,000 字节**。容量在同一 IndexedDB 写事务内检查，两个并发批次不能一起超过上限。
- 支持 TXT、MD、CSV、JSON、DOCX、PDF。原件只读，支持预览、下载、Agent 问答。TXT/MD/CSV/JSON 使用纯文本预览；DOCX 提取段落，PDF 可逐页 canvas 预览及提取文字。没有编辑原件或执行文档脚本。
- 文本 / DOCX 解压在 Worker 内完成；DOCX 仅解压 word/document.xml，实际输出最多 4 MB，禁用 DTD / ENTITY。PDF.js 使用独立 Worker；最多提取 100 页、80,000 字，部分提取显式标注。扫描 PDF 暂不包含 OCR，加密 / 损坏文件仍保留原件下载。
- 原件按当前浏览器、Space 存于独立 `vivic-files` IndexedDB。相同 SHA-256 原件在同一 Space 只占一次容量；文件卡删除保留原件以支持撤销。管理面板显示含保留原件的容量，永久清理未使用原件需明确确认。永久删除 Space 与本地数据重置会删除对应原件。
- 手机原件只在内存中接收，始终由配对且在线的电脑提供；不自动云备份，不在手机创建文件数据库。手机本轮提供预览 / 下载，上传入口在电脑聊天页和 Space 文件管理。
- 新 `/api/files/read` 走当前选中的 StepFun 或 GPT，文本最大 80,000 字；1 MiB 请求体硬上限，线上会话仍独立鉴权。文件内容作为不可信资料，只生成回答，没有工具或卡片操作。来源短引文必须能逐字匹配当前文件片段；切换模型连接后丢弃旧结果。

## 安卓安装包

`apps/android/AndroidManifest.xml` 为 **0.1.7 / code 8**，生产包输出 `.cache/android-build/artifacts/Vivic-Remote-0.1.7.apk`。

新增 `saveFile / cancelSave` 受限桥接：仅打包的可信 UI 可请求，不超过 10 MB，校验无路径文件名及 SHA-256；打开 Android 系统「另存为」，只写用户选择的 content URI。最多一个待保存文件，不新增存储权限、导航或 iframe 能力。PDF Worker 的 `.mjs` 资源按 JavaScript MIME 从本包读取。PDF.js Apache-2.0 许可随包保留。

## 本轮验证

- 移动协议单测 **119/119**：包含独立传送授权、同请求去重、保存失败不报成功、文件分段校验、跨设备拒绝、取消，以及最终文件响应 / SHA 校验期间 owner、画布、版本、权限、摘要变更的竞态。
- Web 手机及文件定向单测 **67/67**，包括实际 owner + Display + 数据库移动、原件容量原子性、去重、跨 Space 隔离、永久清理缓存失效、子卡片锚点、文本注入转义、移动无复制及两页 UI。
- API 文件阅读 / 线上手机传输定向 **22/22**。
- 真实浏览器端到端场景通过：实际 MD、DOCX、PDF Worker；桌面原件下载字节一致；完整文本送到阅读接口（UI 用 TEST 回答 fixture，接口另有真实路由测试）；actual owner + Display + 独立 WS 中继 + 独立手机上下文；子卡片、手机下载 SHA、双向传送、Display 重载后持久化，手机无 vivic/vivic-files 数据库。
- 生产 APK 构建和 v2/v3 签名核对通过。独立、无摄像头、无音频 AVD 验证生产包装载且非 DEBUGGABLE；同源 debug 包实际通过系统 Save as 保存 UTF-8 原件并核对字节，拒绝路径名 / 错误 checksum / 第二个并发保存，取消待保存选择器。证据 `.cache/native-files-20261024/result.json` 与截图。

截图位于 `apps/web/test-results/files-portal-*/`（desktop-file-read / phone-portal-chat / phone-file-space）。原生验收只使用专用 `vivic_online_20261023` / emulator-5610；测试结束关闭该模拟器和转发，保留现有用户服务。

此轮未重新声明真实 StepFun 文件问答质量、生产 APK 对新正式公网 HTTPS 的全链、物理手机操作或扫描 PDF OCR；对应验证不能由 TEST 模型回答或专用模拟器替代。
