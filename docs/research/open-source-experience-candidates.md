# Vivic 开源体验模块筛选

研究日期：2026-10-15。目标：改善当前 Web 信息画布的体验，优先现成组件和独立模块，运行轻量，只需局部适配。HARK 专项见 [复用评估](hark-reuse-assessment.md)。

**优先顺序是：已有组件的排版和详情交互 → 快速找卡/操作 → 语音打断和断句体验。** 新增依赖应对应已确认的体验收益，不为凑功能迁入整套助手、桌面宿主或新的 LLM/provider。

本文是源码、官方文档和发行包核查。推荐等级、适配量与收益是工程判断，尚不是 Vivic 的安装、性能或听感验收。候选均保留来源；本轮不执行安装命令。

## 1. 当前基线，避免重复开发

已读 `README_FIRST.md`、`docs/AGENT_HANDOFF.md`、组件锁定表，并抽查当前工作区代码。

- 保留 SmoothUI Orb、React Bits Grainient、Assistant UI styled registry、React Flow、Motion、Radix/shadcn、Lucide、Recharts。
- Vivic 已有本地 Sherpaw ASR/VAD/KWS、按键录音取消播报、预录短反馈、词级字幕和 PCM 振幅；不能把再次安装 Silero 或加一个波形动画当成新能力。
- 当前工作区已有 Readability 网页正文提取、Temporal 重复/条件提醒，以及输出设备、系统通知和 Plan 音色复刻的新增代码。它们仍有其他在途修改，本研究只确认文件/接口存在，没有认领实现或复验。因此这里不把它们再次列成从零待开发项。
- Display 保持极简，Countdown 默认仅数字；新交互入口优先放 Control。语音仍与 LLM 分离，模型只生成完整校验后的 Action/数据。

## 2. 推荐名单

“小”：接现有状态/公开 API，不更换主架构；“中”：涉及生命周期、稳定身份或新运行时，需要专项验证。P0/P1 是建议先后，收益仍需在具体场景验证。

| 等级 | 项目/模块 | 对用户的改善 | Vivic 最小接法 | 适配量 / 新开销 |
| --- | --- | --- | --- | --- |
| P0 | 现有 Assistant UI + Radix + Motion，参考 HARK 规格 | 文字更易读、材质更柔和、长内容更方便打开 | tokens、Card 主题、Control 详情 Dialog、已有 variant/撤销 | 小；可不新增依赖 |
| P0 | [cmdk](https://github.com/dip/cmdk) | 键盘快速找卡、切画布、选择已有操作 | shadcn Command 放 Control；调用既有动作入口 | 小；React 19 + Radix 生态 |
| P0 | [pinyin-match](https://github.com/xmflswood/pinyin-match) | 用“hs”“heshui”等拼音找“喝水” | 只匹配卡片标题/事项，展示候选与命中位置 | 小；简体分发单文件约 20KiB gzip |
| P1 | [react-hotkeys-hook](https://github.com/JohannesKlauss/react-hotkeys-hook) | 少点鼠标，快速聚焦输入、撤销、关闭详情 | Control 内按 scope 注册，避开输入框与 IME 组合输入 | 小；无运行依赖 |
| P1 | [@squircle-js/react](https://github.com/bring-shrubbery/squircle-js) | 更柔和的连续圆角 | 只包装现有卡片材质子层，保留测量外壳 | 小到中；React/Radix/figma-squircle |
| P1 | [DSH voice 项目的打断/语音队列](https://github.com/beiyege-01/dsh-voice-ai-girlfriend) | 说话插入、长回复顺序朗读、取消后不继续播旧句子 | 借鉴 recorder/speaker 的状态与取消设计，接已有 Sherpaw/Plan | 中；不引入其 CUDA、数字人和 QQ 栈 |
| P1 | [RNNoise WASM：Jitsi](https://github.com/jitsi/rnnoise-wasm) / [Shiguredo](https://github.com/shiguredo/rnnoise-wasm) | 在有背景噪声时改善收音 | 可选麦克风前处理，再进现有重采样/VAD/ASR | 中；必须比较与浏览器已有降噪的实际差异 |
| P1 | [Papa Parse](https://github.com/mholt/PapaParse) | 表格复制/导出更可靠，将来可支持明确粘贴 CSV | 先做已有表格数据导出；导入走列/行/大小上限和契约校验 | 小；无运行依赖，解析与序列化均现成 |
| P1 | [RBush](https://github.com/mourner/rbush) | 卡片较多时减少碰撞查询开销 | 用空间索引替代布局内反复扫描 occupied 数组 | 小到中；不替代当前放置与 Pin 规则 |
| 条件采用 | [use-stick-to-bottom](https://github.com/stackblitz-labs/use-stick-to-bottom) | 长结果增长时平滑跟随，用户上滚后不抢位置 | 只绑定 Control 长结果/详情容器 | 小；无运行依赖，当前没有聊天主窗 |
| 条件采用 | [TanStack Table](https://github.com/TanStack/table) | 表格排序、筛选和行选择 | 先评估现有 styled Table 的公开能力；复杂数据交互时采用 headless core | 中；稳定行 ID/原始数据顺序必须保持 |
| 条件采用 | [TanStack Virtual](https://github.com/TanStack/virtual) | 大量列表行滚动更流畅 | 只在测出瓶颈的 Control 列表/详情表格使用 | 中；不直接虚拟化 React Flow 全画布 |
| PoC | [Smart Turn](https://github.com/pipecat-ai/smart-turn) + [@micdrop/smart-turn](https://github.com/Godefroy/micdrop/tree/main/packages/smart-turn) | 减少说完后的等待，同时允许思考停顿 | PCM 喂独立模块，VAD 静音后判断句子是否结束 | 中；需额外 ONNX runtime 与模型，不能只算约 8MB 权重 |
| 条件采用 | [Streamdown](https://github.com/vercel/streamdown) | 未来流式长文本中的未闭合 Markdown 更稳定 | 仅 Control 长摘要 renderer，按需用插件 | 中；已有 react-markdown，当前短卡片不是必需 |

## 3. 第一组：无需 AI 权重的低成本体验

### cmdk + 拼音匹配

`cmdk@1.1.1` 是 MIT 的独立 React 组件，支持 React 18/19，Dialog 组合 Radix。用 shadcn 的 Command 样式接入，属于使用现成组件。[上游说明](https://github.com/dip/cmdk#readme)。

建议输入找卡或动作后，显示有限候选，再调用已有聚焦、切画布、固定或撤销入口。`pinyin-match@1.2.10` 支持全拼、缩写、多音字和位置结果；比引入完整中文 NLP 更符合这个用途。模糊命中用于帮助选择，不直接据此删除卡片。

备选 [Fuse.js](https://github.com/krisk/Fuse) `7.5.0` 无运行依赖，当前许可 Apache-2.0，适合错字/模糊检索。cmdk 本身已有打分，若拼音匹配已经满足需求，无需再把 Fuse 一并装入。[pinyin-pro](https://github.com/zh-lx/pinyin-pro) `3.29.5` 更适合完整拼音、音调与文本归一化；它的字典开销比仅搜索所需的模块更大，因此不作为找卡首选。

`react-hotkeys-hook@5.3.3` 为 MIT，可用局部 scope 管理 Control 快捷键。它是浏览器页面内快捷键，不提供桌面全局快捷键，也不需要为它开发桌面宿主。

### 表格：先导出，后复杂交互

`papaparse@5.7.0` 为 MIT、无运行依赖，提供现成 CSV parser/unparser。[官方项目](https://github.com/mholt/PapaParse)。导出现有数据最独立；明确粘贴 CSV 也可作为后续小功能，但仍须处理空值、数字语义、公式样式文本和契约上限，不能把缺失值补成零。

`@tanstack/react-table@9.3.1` / [TanStack Table](https://github.com/TanStack/table) 是 MIT headless 逻辑库，保留样式由应用选择。Vivic 当前 `StyledDataTable.tsx` 使用真实 styled Table、`sortable:false`，高亮 ID 绑定原始行位置。排序需要稳定地保留原始行身份，不能只换数组顺序后让“第二行”指代错位。只为一个排序按钮引入整套数据网格并不划算。

`@tanstack/react-virtual@3.14.19` / [TanStack Virtual](https://github.com/TanStack/virtual) 是 MIT。它减少长列表的实际 DOM，但会增加测量和焦点适配；当前小表格没有测出瓶颈时暂不引入。

### 排版查询：RBush 不等于自动布局

`rbush@4.0.1` 为 MIT，仅依赖 quickselect，索引二维矩形。[官方 API](https://github.com/mourner/rbush#usage)。当前 `canvasStore.ts` 的放置循环用 `occupied.some(...)` 查询碰撞，后续卡片量增长时可考虑用 `collides/search` 接替这一小段。

空间索引不会自动决定卡片放哪里，也不会修复已有重叠。固定卡、内容增长、撤销恢复和旧画布修复仍由现有布局策略管理；两张均 Pin 时不能擅自移动。60 张量级是否值得换，需要先比较当前耗时。

## 4. 第二组：语音体验，按需运行

### DSH voice：借鉴状态机和队列

本轮基于 `beiyege-01/dsh-voice-ai-girlfriend@480bbabada7335735cad591eaa55f32fe54a4214`。适合参考 `voice/recorder.ts`、`voice/speaker.ts`、`voice/sentences.ts` 与 `reply-listener.tsx`：按句合成和顺序播放、停止后清队列、丢弃旧异步结果、录音与播报状态联动。[源码目录](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/tree/480bbabada7335735cad591eaa55f32fe54a4214/dsh-plugin/src/client/voice)。

现有 Vivic PTT 已会取消 TTS，单句唤醒在 TTS 时停止。新增价值是用户显式开启前台对话后，在播报中检测到插话并接下一句。要处理回声、开头音节缓存、迟到回调和 Control owner 生命周期，不能把复制 recorder 当作已完成。

它的“句子级流式”是按句取得音频并排队，不等于单次 HTTP 音频包已边到边播。用户的卡片 Action 仍应完整校验；可以在校验后的确认文本上分句。README 的延迟描述不作为 Vivic 承诺：该版本录音入口本身有 1800ms 静音收尾参数。项目 LICENSE 声明 Apache-2.0 并列出其他来源，演示人物素材单独说明；只参考相关语音模块。

### RNNoise：独立降噪库，但真实包体积需分版本看

[Jitsi RNNoise WASM](https://github.com/jitsi/rnnoise-wasm) `0.2.1` 的封装为 Apache-2.0，RNNoise 上游为 BSD-3-Clause；不需 Python/GPU/新模型服务。最新 Worklet 同步分发文件约 1.84MiB、单文件 gzip 约 1.28MiB。包中另一个约 110KiB 的 wasm 是旧版异步路径，README 说明它用于噪声检测，不能拿这个大小代表新版降噪成本。[上游具体说明](https://github.com/jitsi/rnnoise-wasm#usage)。

[Shiguredo RNNoise](https://github.com/shiguredo/rnnoise-wasm) `2025.1.5` 提供更直接的 TypeScript API，无运行依赖；封装 Apache-2.0，生成 Wasm 另遵循 RNNoise 许可。发行 JS 嵌入 Wasm 后约 4.6MiB、gzip 约 3.1MiB。两者均应延迟加载，仅在明确启用收音时运行。

Vivic 已请求浏览器 noise suppression，额外降噪未必在所有麦克风上更好。只在相同录音的清晰度/识别准确度确有改善时采用；VAD/降噪都不保证能区分电视人声与用户，也不等同于声纹或完整回声消除。

### Smart Turn：已有独立 JS 适配，不必迁入整个 Pipecat

[Smart Turn](https://github.com/pipecat-ai/smart-turn) v3.2 模型声明 BSD-2-Clause，列出包含中文的 23 种语言。它判断话语是否结束，补充 VAD 的“此刻有没有声音”，可用于减少固定静音等待。[模型说明](https://github.com/pipecat-ai/smart-turn/blob/main/README.md)。

找到的 [`@micdrop/smart-turn@0.1.0`](https://github.com/Godefroy/micdrop/blob/main/packages/smart-turn/README.md) 为 MIT，独立于其余 Micdrop 包；已提供 PCM 特征提取、`push/predict/reset/release` 与 Web/Node 适配，比从 Python 推理示例重写 mel 前处理更符合少量适配要求。

需要计入 ONNX runtime 和约 8.3MB CPU/约 31MB GPU 权重；现有 Sherpaw 的封装不能据此假定可直接加载该模型。该包版本较新，默认可联网下载模型和 CDN runtime；若做 PoC，需接现有按需下载/固定版本与散列机制，处理取消、释放和超时回退。上游的 M2、英法测试不是本机 M1/8GB 中文结果。

它只应控制本轮单句收尾，不能直接执行识别文本或开启常驻监听。相比无权重模块，排序放在单独 PoC。

## 5. 已研究但暂不推荐直接加入

| 项目 | 核查结果 | 判断 |
| --- | --- | --- |
| [ricky0123/vad](https://github.com/ricky0123/vad) `@ricky0123/vad-web@0.0.31` | npm ISC；成熟 browser/React VAD API，需 Silero 模型和 onnxruntime-web | Vivic 已有 Sherpaw VAD；可借鉴接口/调参，不默认重复装运行时 |
| [TEN VAD](https://github.com/TEN-framework/ten-vad/blob/main/LICENSE) | 有小体积 Web Wasm，但许可在 Apache-2.0 基础上附加部署/竞争限制 | 不标为无附加限制的 Apache 开源替代；现有 VAD 可用时无须急换 |
| [Kokoro JS 中文适配](https://github.com/uzen-zone/kokoro-js) `@uzen/kokoro-js@1.2.4` | Apache-2.0；普通话/中英混读；依赖 Transformers.js、phonemizer、pinyin-pro，再下载权重/音色 | 将来做独立本地动态 TTS 的候选；不是一个几 KB 的声音组件，当前短反馈已用预生成素材 |
| [Sherpa ONNX](https://github.com/k2-fsa/sherpa-onnx) | Apache-2.0，支持多种 ASR/TTS/增强模型；各模型许可另核 | 已有 Sherpaw 对相关能力封装，不额外引入整套原生栈；本地 TTS 可再研究其固定模型 |
| [Supertonic 官方归档](https://github.com/supertone-oss-archive/supertonic) | 官方已说明开发/支持结束；官方 31 语言列表不含中文；示例代码 MIT，权重 OpenRAIL-M | 不作为当前中文 Vivic 首选；`na` 不等于中文质量支持 |
| [Supertonic-ZH](https://github.com/wuxuedaifu/supertonic_cn) | 代码 MIT，但权重 gated、另行评估许可，当前模型非商业预览；单预设音色、无公开克隆能力 | 不符合无额外申请、即取即用的要求 |
| [Defuddle](https://github.com/kepano/defuddle) `0.19.5` | MIT，可接已有 DOM，改善部分正文/元数据提取 | 作为 Readability 的离线样本对比候选；不解决 DNS/抓取/登录与 JS 页面问题，不默认叠两个解析器 |
| [LinkeDOM](https://github.com/WebReflection/linkedom) `0.18.13` | ISC，较窄的 DOM 实现；不追求与完整浏览器语义一致 | 如后端 DOM 构建开销成为瓶颈可比较；Readability 对活节点集合等行为可能有假设，不能直接换 jsdom 后宣称等价 |
| [Chrono](https://github.com/wanasit/chrono) `chrono-node@2.10.3` | MIT；默认英文，简/繁中文仅 partial support | 可研究中文 locale 测试，不把它当完整中文提醒理解器；现有中文规则/Temporal 继续使用 |
| [Microsoft Recognizers Text](https://github.com/microsoft/Recognizers-Text) `date-time@1.3.2` | MIT，中文日期规则有参考价值；npm 包自 2023 发布后较久，单包 unpacked 约 10.5MiB，另有依赖 | 不为现有有限提醒引入整个 recognizer；测试语料/规则范围可借鉴 |
| [RRule](https://github.com/jkbrzt/rrule) `2.8.1` | BSD-3-Clause，iCalendar 高级重复规则 | 只有确定要“每月第二个周二/例外日”等能力时再用；现有 Temporal 已覆盖部分重复，库也不能唤醒关闭的浏览器 |
| [jsonrepair](https://github.com/josdejong/jsonrepair) `3.15.0` | ISC，无运行依赖，修复格式错误 | 可研究导入诊断；不在 Action 执行前盲目补全截断 JSON，以免把不完整输出变成动作 |
| [ELK.js](https://github.com/kieler/elkjs) `0.12.0` | 原组件表已有研究位置；EPL-2.0 OR GPL-3.0-or-later，图布局引擎，发行包 unpacked 约 7.7MiB | 不为小量无连线信息卡直接引入；不保证将固定卡作为自动放置障碍，仍需适配 |
| [Sonner](https://github.com/emilkowalski/sonner) `2.0.8` | MIT、无运行依赖，现成通知组件 | 当前已有反馈/提醒层；除非 Control 有明确通知痛点，否则新增收益有限 |
| [Pipecat 整体](https://github.com/pipecat-ai/pipecat) / [Micdrop 整体](https://github.com/Godefroy/micdrop) | 现成语音框架包含传输、会话和 provider 组合 | 独立模块有价值；整体接入会重复现有链路，不符合此次少量适配目标 |

## 6. 实际发行物体积记录

以下为本轮直接下载 npm 精确版本 tarball、**不安装不执行**后，读取指定发行文件并用 gzip 计算的结果。不是作者宣传数字。KiB=1024 bytes；JS 直接采用各自发行文件，未再统一 minify；外部依赖、可选插件、模型、浏览器常驻内存、CPU/GPU 成本均不包含在单文件数字内。

| 发行包 | 检查文件 | 单文件 gzip | 注意 |
| --- | --- | ---: | --- |
| `cmdk@1.1.1` | `dist/index.mjs` | 4.3KiB | 另有小 chunk 和 Radix 依赖；与现有依赖可能共享，但未测去重 |
| `pinyin-match@1.2.10` | `dist/main.js` | 19.6KiB | 简体版；不同时加载繁体大字典 |
| `fuse.js@7.5.0` | `dist/fuse.basic.min.mjs` | 7.1KiB | 零运行依赖；不必与 cmdk 默认检索重复叠加 |
| `rbush@4.0.1` | `rbush.min.js` | 2.3KiB | 该预构建文件包含相应打包代码；ESM 构建仍需看 quickselect |
| `react-hotkeys-hook@5.3.3` | 发行 `dist/index.js` | 3.3KiB | 无运行依赖 |
| `papaparse@5.7.0` | `papaparse.min.js` | 6.6KiB | 无运行依赖 |
| `use-stick-to-bottom@1.1.6` | `dist/useStickToBottom.js` | 3.8KiB | 这是 hook 文件，组件入口另有少量代码 |
| `@squircle-js/react@1.3.0` | `dist/index.mjs` | 2.8KiB | 不能把该数当作包含所有外部依赖的总增量 |
| `figma-squircle@1.1.0` | `dist/index.js` | 1.8KiB | 无运行依赖的几何算法 |
| `@jitsi/rnnoise-wasm@0.2.1` | `dist/rnnoise-sync.js` | 1309.1KiB | 用于新版降噪的同步 Worklet 分发，不能用旧小 wasm 代替计算 |
| `@shiguredo/rnnoise-wasm@2025.1.5` | `dist/rnnoise.js` | 3140.4KiB | 内嵌 Wasm 的发行 JS |

机器可读记录见 [source-index.json](source-index.json)，包含 npm 精确版本、依赖、原始包元数据、文件大小和压缩大小。`unpacked_bytes` 只是 npm 包展开大小，**既不是网站网络下载量，也不是运行内存**。ONNX 的发行包还含多个平台/backend 的文件，不能把整个 npm unpacked size 当成单个浏览器必下载量。

索引保留了后段 GitHub API 限流记录和一个错误旧命名空间的 404；这些条目另通过官方网页、原始源码或 npm 包复核，不能把元数据读取失败推断为项目不可用。Supertonic 的有效官方地址已更正为归档组织。

## 7. 建议后续任务，按收益独立验证

| 顺序 | 范围 | 建议通过条件 |
| --- | --- | --- |
| 1 | HARK 风格的排版、材质、长内容详情 | 保留批准组件；中英文阅读、Pin/撤销、Display 纯数字、减少动效通过实际截图对比 |
| 2 | Control 的 cmdk + 简体拼音找卡 | 键盘/IME、目标歧义、画布切换、owner 权限正确；模糊候选不直接执行破坏动作 |
| 3 | 现有语音链路的可取消分句队列与显式前台插话 | 旧句不复活、开头音节完整、无自激回声、取消释放；真实听音/开麦待用户另行明确允许 |
| 4 | 表格 CSV 导出，按需要增加稳定排序 | 导出值与源数据一致，缺失/负数保留；排序后高亮与“第几行”语义一致 |
| 5 | 有噪声或固定等待痛点时，再测 RNNoise/Smart Turn | 同样本识别率、收尾误切/等待分布、本机峰值内存与CPU有可比较改善，再决定是否常驻 |

不需要先装完名单。每个任务都能独立验收，不改变两种 LLM 连接、凭据边界和双视图架构。

## 8. 调查范围和未证明事项

检索覆盖语音输入/降噪/打断/轮次结束、中文和拼音检索、命令菜单/快捷键、布局查询、表格/CSV/列表性能、网页正文、日期重复规则、HARK 的排版/背景/卡片与文字交互。搜索用于发现候选，结论优先回到作者仓库、许可证原文、官方文档和 npm 发行物，不用聚合站的速度/许可介绍作验证。

没有把全网所有项目或所有 issue 都穷尽。没有把 star 数、最近 push、作者演示或模型参数量当作本机稳定性证明。文中条件候选尚无 Vivic 端到端 PoC；语音默认静音、未采物理麦克风，未使用用户套餐，也未启动/重启现有服务。

研究时工作区已有其他未提交实现；本轮仅新增研究文档和公共来源索引，不修改或提交那些业务改动。最终网页、字体及模型的固定 revision、对应许可和实际构建增量，须在具体采用时落实。
