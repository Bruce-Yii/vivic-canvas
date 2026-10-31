# Vivic v0.6 — Motion Director、视觉艺术指导与质量门禁

## 一、视觉准则

> **Expressive Environment, Minimal Information.** 背景/Orb/短字幕体现情绪，卡片像优质工具而不是聊天消息。

- 主屏无长段说明、固定导航、Debug、常驻状态徽标；只有当前需要的信息。
- 支持 Light / Dark。工作态默认 Grainient，白天浅色云雾，夜晚柔和深色；待机始终黑色。
- 卡片默认 Solid 白/浅底、文字对比充足；Frosted 可选但不得牺牲可读性和帧率。
- 不要做“看起来很 AI”的大标题、夸张边框、无意义进度条、密集图标；整个空间允许留白。
- 所有卡片用同一套 typography/spacing/radius/shadow/tokens，不能各搞一套。

## 二、Orb 和背景的典型时序（建议起点，需要实测调整）

**Standby (无限持续)**：纯黑背景、SmoothUI Orb 慢速呼吸、微微漂浮。不要跳动、不要用户提示标签；`prefers-reduced-motion` 下几乎静止。

**Wake (约 650–1100ms，非硬性性能 SLA)**：

1. `t0` 接到唤醒事件：Orb 一次轻微 scale/bloom 响应，播放极轻量音效（遵守浏览器 autoplay 限制）。
2. `t0+100ms`：Orb 内部色彩与 Grainient 色盘对齐；背景实例预热或提前准备。
3. `t0+150–950ms`：使用现成 mask/clip reveal + Motion，圆形区域持续扩大，表面仿佛由 Orb 自身扩散到全屏；**不能先把球隐藏，再突然把背景显示出来**。
4. 转场后 `WORKSPACE` 只剩背景/卡片，Orb 融入背景；若需要回复，可临时出现小 Orb 后消失。

**Search**：用户请求资料 → 小幅 Orb thinking feedback 和预制「我看看」→ 搜索期间背景缓慢运动 → 成功时新卡从合适位置柔和淡入/上浮 → 可选高亮相关项 → Orb 淡出。

**Focus**：使用 React Flow smooth `setCenter`/`fitView` 或控制 viewport + Motion；停稳后短暂加强目标卡阴影，其余卡降低视觉权重；返回恢复 previous viewport。Focus 不强制显示更多内容。

**Delete**：目标卡 120–280ms 轻微缩小/淡出 → 排列算法生成新布局 → Motion 平滑重排 → 支持 undo 恢复。

**Subtitles**：底部靠中、非气泡、无头像/时间戳。显示一两句简短语音文字，用现成分词/淡入效果，语音结束后消散；无时间戳不伪造单字对口型。

**Reminder**：截止时可有背景的单次红色呼吸/聚焦，不进行高频红闪，提供明确关闭及减弱动效模式。

## 三、状态与动作语义

`visualStage = STANDBY | AWAKENING | WORKSPACE | FOCUS`，`voice = idle | listening | thinking | speaking | error`。不是每个语音事件都创建新的卡片。

Motion Director 监听 `stage.awaken`, `card.create`, `card.delete`, `card.highlight`, `card.focus`, `canvas.fit`, `canvas.restore`, `subtitle.show`, `ambient.setPreset` 等**已验证动作**；在回调序列里调现成组件 API。用户发新指令时中断旧动画、释放 WebGL/音频资源，不堆队列。

## 四、技术和性能要求

- 独立背景 Canvas/WebGL，禁止和 React Flow 一起 transform；默认禁鼠标-driven 大幅形变。
- 只激活一个背景实例。切换主题可使用一张静帧或短暂双层过渡，但双 WebGL 同时运行必须有明确收尾机制。
- 渲染性能预算是目标而非假称结果：工作背景测试 24–30 FPS/自动质量档；卡片转场目标 60 FPS；具体以测试设备为准。
- `devicePixelRatio` 渐进限制，WebGL 上下文丢失/恢复，隐藏 tab 降低/暂停渲染；不能 4K 默认满分辨率无优化。
- 如使用用户上传 HTML 当参考，注意它是含 fbm/noise 和缓慢时间变化的 WebGL 示例，也包括低分辨率渲染和 2D fallback；**仅参考外观**。产出必须优先使用 Grainient 实例，不抄出一套新的 Shader。
- 30 分钟运行、10/30/60 卡逐档测试；实测 Firefox/Chrome/Safari 至少两种（优先 Mac Chrome、Safari）；报告每档 FPS、内存和失败情况。
- 系统 `prefers-reduced-motion` 必须关掉多数背景动画/减少字幕和警示动效，不影响信息获取。

## 五、视觉验收交付素材（必需）

录屏 A：`standby → awaken → workspace` (实际浏览器录像)。
录屏 B：添加 3 张极简卡 → 聚焦 Todo → 退出聚焦 → 删除卡 → Undo。
录屏 C：模拟真实短语音 → Orb 反馈 → 底部字幕弹出又消失 → 高亮第二条结果。
录屏 D：双窗口在主屏/扩展屏同步卡片与布局。

截图：Light/Dark 各一张；Countdown、Todo、Search 卡 Minimal 各一张；配置页 StepFun/搜索状态各一张；缩小画布验证留白与易读。

需要明确列出**每一张截图调用了哪个实际开源组件**，有无自定义包裹层。不得以静态 PS 图充当真实运行 UI。每个里程碑必须提供截图对照和不能通过的项目清单。
