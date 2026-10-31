# HARK 研究资产如何用于 Vivic

研究日期：2026-10-15。用户提供的仓库：[ECdison6227/hark-ui-research](https://github.com/ECdison6227/hark-ui-research)，本轮核对 revision `b5b49eb46494b86d56c21654ea585ad379d9b9d7`。这是静态复核和适配建议，没有改变 Vivic 界面。

**可以用于 Vivic。最有价值的是排版、材质和交互规格；仓库本身不是可以直接安装的 HARK React 组件库。** 用现有 Assistant UI styled registry、Radix/shadcn 和 Motion 承接这些规格，符合“使用可复用组件、只写少量适配”的原则。

全网候选及排序见 [开源体验模块筛选](open-source-experience-candidates.md)。

## 1. 仓库里保存了什么

| 内容 | 本轮确认 | 对复用的意义 |
| --- | --- | --- |
| `reports/` | 设计、代码和历史运行报告 | 可作为实现规格和对照依据 |
| `reports/design-tokens.css` | 544 个带作用域的变量声明，含主题重复名称 | 选择语义参数映射；不是 544 个可直接覆盖的全局变量 |
| `evidence/scripts/snippets/*.readable.js` | 已发布脚本的定向格式化片段 | 可以识别行为和上游；仍引用压缩符号、私有状态和其他 bundle |
| `wallpaper_core.html` / GLSL | 独立天空程序及 shader | 是完整运行程序，不是一个已有 React 背景组件 |
| 截图、DOM、网络形态 | 以前采集的界面证据 | 不能改写成本轮重新运行的结果 |

没有发现完整应用源码、可安装的组件 package manifest 或 HARK 自有代码的复用许可证。GitHub 元数据 `license=null`。这不否认其中包含开源依赖；正确路径是找到其独立上游，从上游采用有明确许可的组件。仓库公开与被采集原站资产的许可是两件事。

来源：[仓库说明](https://github.com/ECdison6227/hark-ui-research/blob/b5b49eb46494b86d56c21654ea585ad379d9b9d7/README.md)、[主报告](https://github.com/ECdison6227/hark-ui-research/blob/b5b49eb46494b86d56c21654ea585ad379d9b9d7/reports/hark-chat-analysis.md)。

## 2. 哪些内容能低成本落到现有组件

| 用户喜欢的部分 | Vivic 的现成承载方式 | 适配量与边界 |
| --- | --- | --- |
| 文字舒服、层级清晰 | 现有字体栈、Assistant UI Text、CSS tokens | 小：统一正文、标题、来源、数字的字号/字重/行高/段距；不更换渲染系统 |
| 卡片有柔和材质 | 现有 Card 的主题和材质子层 | 小：调整填充透明度、描边、留白；避免给每张卡叠大面积 blur |
| 圆角连续、像苹果界面 | `@squircle-js/react` 或 `figma-squircle`，局部包装现有 Card | 小到中：补充形状能力，保留已有卡片、React Flow 测量外壳 |
| 小卡片打开大详情 | Radix Dialog + Assistant UI Card + Motion `layout` / `layoutId` | 小到中：共用同一份已校验内容，做好 Escape、焦点恢复和关闭状态；先用于 Control 的长内容 |
| 只有内容溢出才展开 | 现有 Note variant + Radix Collapsible/已有控制入口 | 小：复用当前展开/收起动作，不再增加另一套局部状态 |
| 右键、复制、固定等交互 | 已安装 Radix 生态的 ContextMenu，可组合接入既有 Action/撤销 | 小到中：当前尚无该菜单界面；保持文本选择、链接、拖动和菜单互不抢事件 |
| 文字增长时平滑跟随 | `use-stick-to-bottom`，绑定结果或详情滚动容器 | 小：只在需要连续阅读长文本时引入；不驱动 React Flow 镜头 |
| 天空安静、颜色舒服 | 保留 Grainient，使用已有 colors/speed/softness/grain props | 小：做配色与运动节奏对照；不会因此得到相同天气天空 shader |

这里的“适配”是给已有组件传主题值、组合公开 API、连接 Vivic 状态，不是另写一套 Card、Dialog、Orb 或画布。

## 3. 已辨认出的独立上游

### Streamdown：确认存在，按需求采用

与远端 manifest 散列一致的 `BT2rDYKB.js` 中保留了 `B0.displayName="Streamdown"`，Markdown 和摘要片段使用这个 renderer。可以确认归档包含 Streamdown，精确版本未知。

直接采用 [Streamdown 官方项目](https://github.com/vercel/streamdown) 比从 HARK bundle 拆出 B0 更可靠。当前 npm `streamdown@2.7.0` 标注 Apache-2.0，支持 React 18/19；它处理未完成 Markdown，适合未来的 Control 长摘要展示。Vivic 已有 `react-markdown + remark-gfm`，最终短卡片不需要仅为更换包而迁移。流式正文还需要真实传输链路，装 renderer 不会让现有接口自动流式返回。按需关闭不需要的 raw HTML、远程图片和重型插件，继续只显示校验后的内容。

证据：[Markdown 配置片段](https://github.com/ECdison6227/hark-ui-research/blob/b5b49eb46494b86d56c21654ea585ad379d9b9d7/evidence/scripts/snippets/chat-markdown-config.readable.js)、[上游 package](https://github.com/vercel/streamdown/blob/main/packages/streamdown/package.json)。

### use-stick-to-bottom：有强同源线索，精确归属未完全确定

HARK 跟随滚动片段的 70px 阈值、状态 getters、选区保护、弹簧默认值与 [use-stick-to-bottom](https://github.com/stackblitz-labs/use-stick-to-bottom) 高度一致，但 HARK 增加了暂停、脱离、尾部节点和 Motion 接口。可以把它列为改造同源的强推断，不把上游版本写成已确认。

上游 `use-stick-to-bottom@1.1.6` 为 MIT、无运行依赖。适合长内容增长时保持阅读位置，用户上滚或选中文字时停止追随。现阶段 Vivic 没有主聊天窗，只有出现相应长结果容器后才有明显价值；不能把它用于自动移动整张画布。

证据：[HARK 滚动片段](https://github.com/ECdison6227/hark-ui-research/blob/b5b49eb46494b86d56c21654ea585ad379d9b9d7/evidence/scripts/snippets/scroll-pinning.readable.js)、[上游实际源码](https://github.com/stackblitz-labs/use-stick-to-bottom/blob/main/src/useStickToBottom.ts)。

### 连续圆角：找到可用上游，不声称 HARK 使用了它

[`@squircle-js/react`](https://github.com/bring-shrubbery/squircle-js) `1.3.0` 为 MIT，React peer 包含 19；支持 `asChild`，依赖 Radix Slot 和 `figma-squircle`。本轮读取 npm 发行物，ESM 文件单独 gzip 约 2.8 KiB；这不包含外部依赖，也不是 Vivic 构建增量。

它没有边框宽度支持，且不转发外部 ref；整个节点上使用 clip-path 还会裁切阴影和焦点轮廓。更合适的接法是仅处理材质子层，让 React Flow 继续测量原外壳，Radix 弹层继续使用原 portal。

备选 [corner-smoothing](https://github.com/sanalabs/corner-smoothing) 有边框和 React 包装，但版本较旧；[figma-squircle](https://github.com/phamfoo/figma-squircle) `1.1.0` 是无运行依赖的路径算法。HARK 保存的曲线参数没有足够证据归属于这些库，视觉相近程度仍需以后截图比较。

## 4. 不能直接当成现成开源组件搬入的部分

### 天空背景

`wallpaper_core.html` 约 276KB，fragment shader 约 34KB；包含天气/位置查询、主题参数、定时刷新、冻结/占位层与 `window.hark` 控制接口。源码大小不是 GPU 成本：全屏像素、采样与后处理决定实际开销。[保存的背景程序](https://github.com/ECdison6227/hark-ui-research/blob/b5b49eb46494b86d56c21654ea585ad379d9b9d7/evidence/scripts/wallpaper_core.html)。

Vivic 已有单实例 Grainient、DPR 1.75、页面隐藏暂停、减少动效和 context-loss 回退。先用这些公开能力调整天空感与节奏，符合当前组件约定。若以后选用不同背景，需要按仓库原有 ADR 流程对比原组件、来源许可和 M1/8GB 性能，不能把整段采集 shader 说成已批准的开源组件，也不应同时叠两个全屏 WebGL。

### 字体

研究报告记录 GT Standard L/Mono 和 Hark Serif；[GT Standard 官方页](https://www.grillitype.com/typeface/gt-standard)提供商业授权购买，Hark Serif 的可再分发授权未确认。先沿用 Vivic 已有 Geist Variable 和系统中文字体，调整阅读参数即可。

CSS font-family 与实际中文逐字形的来源并不等价。HARK 聊天区域的 15px 字号也不能普遍套用到远看的 Display；倒计时保持纯数字及独立数字尺度。

### 卡片与同步

摘要、表格、回复和菜单都引用 HARK 自家 messageId、composer store、统计与 hash classes，不能单独复制就工作。HARK 表格片段有自身排序/测量逻辑，本轮没有足够证据把它归为 TanStack Table；历史运行样例点击表头也没有观察到排序。

SharedWorker/SSE 的 snapshot、patch、seq 与 HARK 服务端协议绑定。Vivic 继续使用既有 Control owner、BroadcastChannel、IndexedDB。模型的流式展示和可执行 Action 分离，完整校验通过后才派发动作。[卡片代码报告](https://github.com/ECdison6227/hark-ui-research/blob/b5b49eb46494b86d56c21654ea585ad379d9b9d7/reports/card-code-analysis.md)。

## 5. 建议实现顺序与接入位置

| 顺序 | 可交付结果 | 主要位置 | 验证重点 |
| --- | --- | --- | --- |
| 1 | HARK 启发的排版、材质和安静背景主题 | `apps/web/src/index.css`、`cards/vivicGUILibrary.tsx`、`motion/motionDirector.ts`、`stage/BackgroundLayer.tsx` | 中英文长文、弱 GPU、减少动效、远看 Display；保持批准组件 |
| 2 | 长便笺/正文在 Control 打开详情，平滑关闭返回 | `cards/NoteCardView.tsx`、Control 结果入口、现有 Radix/Motion | 单一 variant/内容来源、焦点恢复、撤销、拖动与选区 |
| 3 | 连续圆角小范围 PoC | 现有 Card 材质子层 | 原测量尺寸、阴影、焦点轮廓、菜单不裁切，不能全局直接替换 |
| 4 | 需要连续阅读时再加入跟随滚动与 Streamdown | Control 长结果/详情 renderer | 用户脱离追随、取消、旧内容不重播；Action 仍完整校验 |

这是实现建议，不代表本轮已经完成视觉改版或取得 HARK 原站素材授权。

## 6. 本轮证据与限制

先读了 Vivic 根入口、当前交接和组件锁定表。使用 reverse-engineer-anything 技能的静态调查流程，定向复核研究报告、片段和上游依赖。协作检查核对了原归档三个相关 bundle 的 SHA 与远端 manifest 一致；没有读取原始网络对话、认证资料或真实浏览器会话。

本轮片段 REA parent Evidence：`ev_7a40e9b7116558dde5a219b9178291a041966cca086aa41e3c639e0766a56aa2`，限定四个片段；跨片段符号、原站完整版本和未加载资源仍有未知。原仓库运行报告属于历史证据，不是本轮重测。

没有执行 HARK 代码、下载字体、安装运行依赖、开麦或播放音频。没有修改 Vivic 业务代码；主题与行为建议尚未进行浏览器验收。
