# Vivic v0.6 — 开发验收清单与 E2E 场景

用法：每条标注 `PASS / FAIL / BLOCKED`，附真实日志/截图/录屏/测试命令。不要直接把“开发完成”理解成通过。

## A. 视觉（Phase 0，阻断项）

- [ ] A01 真正导入 React Bits Grainient（显示具体 commit/version），默认慢速自动变化，鼠标不显著影响画面。
- [ ] A02 真正导入批准的 Orb 组件（优先 SmoothUI Siri Orb），黑色待机无文字/按钮/聊天框。
- [ ] A03 唤醒 Orb 连续扩散为 Grainient：过渡录像没有硬切；工作态 Orb 默认消失。
- [ ] A04 Assistant UI styled registry 已正确安装：不是无 CSS 的裸卡片；Countdown 数字之外没有任何文本。
- [ ] A05 React Flow + styled cards 同时运行，zoom/pan/focus 平滑；背景不随 viewport 缩放。
- [ ] A06 灵动字幕短暂出现/消散，没有聊天泡泡、头像或时间戳；多次触发可正确覆盖/取消。
- [ ] A07 同一套 design tokens；亮/暗主题截图达到用户认可的视觉方向。
- [ ] A08 减少动态效果设置有效，临期提醒没有高频闪烁。

## B. 功能/结构（Phase 1）

- [ ] B01 `/control` 能打开 `/display` 新窗口，提示将其拖到第二屏并全屏；默认不要求安装桌面客户端。
- [ ] B02 `/display` 不显示设置入口、导航条、聊天 Thread、调试信息、固定工具栏。
- [ ] B03 两个窗口同画布同步 `create/update/delete/focus`；重复事件不造成两张相同卡。
- [ ] B04 新打开展示端完整收到 snapshot，断开重连后收到最新 state。
- [ ] B05 一条「删除那个」有歧义时不删除，候选高亮+澄清；删除确定目标有 undo。
- [ ] B06 Canvas 创建/重命名/切换/删除/导出/导入，并在浏览器重启后完整恢复卡片、位置和来源。
- [ ] B07 Card schema 拒绝不认识的 type/字段；Minimal Countdown 不接受 description/footer/advice。
- [ ] B08 `card.focus` 只改变镜头，卡片显示字段不变；`canvas.restore` 恢复原视图。

## C. 数据/搜索/模型（Phase 2）

- [ ] C01 未配 API Key 时本地画布仍可使用，无法联网查资料时说明原因而非虚构结果。
- [ ] C02 StepFun Key 由 `/control` 安全提交给本机服务，仅后端可访问；连接测试可成功/失败。
- [ ] C03 Pi session（如果集成）**没有** `read/write/edit/bash` 能力；试图诱导执行时验证工具并不存在。
- [ ] C04 `pi-web-access` 真实搜索至少成功一次，在**没有独立搜索 API Key**的情况下取得 URL+来源，附实际返回记录（不含机密）。
- [ ] C05 连接搜索的失败场景可正确降级；不把 OpenAI/Codex 认证错当通用 API 登录。
- [ ] C06 `fetch_content` 对 private IP/local file/内部域名/重定向拦截；网页嵌入“忽略之前指令”不会改变系统规则。
- [ ] C07 「查三个开源画布库」能创建来源可追溯的卡片，语音「第二个较好」对应高亮第二项。
- [ ] C08 Winnow 若已接入，具真实判定日志与对照测试；否则显示 `BLOCKED` 和清晰降级（rules/配置模型），不可宣称完成。
- [ ] C09 图片仅在用户明确上传时处理；无视觉模型不得假装解析图片。
- [ ] C10 StepFun Key、Pi OAuth Token 不在 localStorage、IndexedDB、Display payload、logs、导出 JSON、response text 中。
- [ ] C11 Pi 订阅登录若 PoC 通过，正确显示 Provider/model 可用性、限额/条款提示与登出；未通过就标实验不可用。

## D. 语音/内容/稳定性（Phase 3）

- [ ] D01 文本输入指令与浏览器按键语音共享同一个 Action Engine。
- [ ] D02 PTT 只在浏览器授权麦克风后启用；ASR 失败文字功能依然可用。
- [ ] D03 预制短句与字幕/Orb 时间线可同步，响应失败不会继续说“查到了”。
- [ ] D04 Weather 无实际数据提供方时不能显示假温度；Table/Chart 来源与数值匹配。
- [ ] D05 不同字号/屏幕尺寸、重连、30 分钟动画及 10/30/60 卡测试有量化记录。
- [ ] D06 页面性能降级、WebGL context lost、tab hidden、减少动效、音频限制均有安全降级。

## E. 可直接给 Playwright 的场景描述

### Scenario 1：最简倒计时

1. 打开 `/control`，切换演示画布，创建目标时间距今 10 分钟的 CountdownCard。
2. 在 `/display` 查询 Countdown 文本节点；初始仅存在时间数字、无“距离结束”“分钟”等说明文字。
3. 发 `card.focus`；等待视图稳定；卡片文本内容应完全不变，变的是 transform。
4. 说「删除这个」，确认并撤销，状态恢复；检查不产生重复卡。

### Scenario 2：Web 双窗口同步

1. 打开两个同源窗口，A 为 `/control`，B 为 `/display?canvasId=...`。
2. A 创建 Todo 3 项，B 收到一次 patch；在 A 改第 2 项，B 更新正确。
3. B 刷新，请求 snapshot；仍看见相同三项。
4. 关闭 A（或模拟断线），B 保留最后一帧；A 重新打开后 B 更新且不重复动作。

### Scenario 3：真实搜索

1. 清空所有搜索 API Key，只在 Pi Web Access 的 keyless 条件下运行。
2. 输入「查找 React Flow 可替代的三个开源画布项目」。
3. 等待真实 search 结果：至少一个可信源 title + URL + fetchedAt；校验 sourceData 中包括来源字段。
4. 展示 SearchResultCards，默认一句话摘要，不附长篇 AI 评论；如果网络不可达，准确显示连接问题。
5. 让 Vivic 高亮第二项；对应卡片或行变亮，别的内容不增加文字。

### Scenario 4：权限检查

1. 问「运行 bash 命令查看我的家目录」。
2. 模型最多用简短语言解释无法执行，不存在执行此请求的工具。
3. 用指向 `127.0.0.1`、私有 IP 和 file:/// 的 URL 测试 fetch 拦截。
4. 搜索结果插入恶意 prompt 注入文本，不可开启新工具或写入系统文件。

### Scenario 5：视觉动作

1. 待机拍摄无卡状态，唤醒时录制 Orb 扩散。
2. 创建倒计时、待办、结果卡；Focus Todo，再 Restore；录制时字幕短暂显示。
3. 对照设计 token 与背景参考，记录 Chrome/Safari 的真实性能。

## F. 交付最低要求

- `pnpm install && pnpm dev` 或等效一条命令启动 Web 和受限本机 Node 服务；README 中必须准确。
- 仓库含 lockfile、严格类型检查、Action/Card schema 测试、基础 Playwright 浏览器测试。
- `LICENSES.md` 或依赖清单列组件源码/版本/许可。
- 视觉录屏、真实截图、性能记录、已知问题和待开发项齐全。
