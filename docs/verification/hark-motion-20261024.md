# 2026-10-24 Hark 卡片与空间光效

用户批准的本轮范围：卡片更简约，继续使用 UI library Hark 字体/图标/连续圆角/透明材质，空间光效更有表现力，保留暂停与减少动效。

## 来源与迁移

实际 `git ls-remote https://github.com/ECdison6227/rea-ui-library.git HEAD` 返回 `26ac2724f29b4ee46962146fed2b6d545bf62180`，与既有导入一致。本轮读取该提交的 design-package、DESIGN_SPEC、motion catalog 和 ADAPTATION_GUIDE；既有原字体、glyph、corner helper、主题角色和天空帧不重画、不替换。

| 来源/现有能力 | 本轮目标映射 | 分类 |
| --- | --- | --- |
| GT Standard / Hark Serif，原 SVG glyph | 保留原字节；中文统一 PingFang/微软雅黑/Noto Sans 无衬线回退 | B 原资产，D 回退 |
| Hark 透明 fill/stroke + continuous corner | 卡片单一外层玻璃，普通重复边框减弱；Office 行取消嵌套大块面板 | B 原参数与组件，D 密度 |
| 摘要标题 20/26/500 | 合并类型行与标题行；类型可访问名称保留；状态、日期、DEMO 与来源不删除 | D 业务层级 |
| 已归档天空 shader 的 frozen frame | 保留原帧，通过 transform/opacity 光层增加可控漂移 | D 合成动效 |
| 原材质 800 ms / pressed 120 ms | 继续使用；新卡进入 420 ms、归位 520 ms 和光路径为 Vivic 选择 | B 原 timing，D 其余 |
| SmoothUI Siri Orb、React Flow | 保留组件；球外光晕联动，聚焦周围变暗，卡片移动连续归位 | D 适配 |

未引入原天空 HTML 的天气网络、定位、native bridge 或 Cloudflare 注入，不运行新 WebGL 上下文。来源设计包保持其原 partial 研究边界；本轮目标运行不证明原 Hark 全状态。

## 实现

- `SceneCardShell` 单标题+原 glyph，辅助类型对屏幕阅读器保留；中性 badge 改为安静文字，重要告警继续可见。
- `card-refinement.css` 覆盖便笺、待办、周计划、查询及 Scene/Office 通用外壳，文件卡可直接复用 SceneCardShell。
- `BackgroundSettings` 小面板内增加柔和/灵动/暂停与一个强度滑杆。使用同步 `ambientMotion` 与 `ambientIntensity`。
- `HarkCanvasBackdrop` 显示唤醒、思考/听写/说话、聚焦状态的光层；`emitSpaceFeedback` 收到宿主成功信号后才出现短光回执。
- 后台、离屏、零强度、暂停、减少动效均停止循环。浏览器实测发现旧 Motion hook 对运行中的 OS 设置切换未触发此处重渲染，新增 `useSystemReducedMotion` 精确订阅 media-query change，已接入背景、StageRoot、Orb。
- Dev Card Playground 原 Control 样例因绝对定位且无宽度变成窄条，本轮仅为演练容器补 `position:relative;width:100%`，实际产品坐标未改。

## 验证记录

测试与截图目录：`.cache/hark-motion-20261024/`。所有浏览器使用独立 context、自造 schema-valid 内容；无真实画布修改、无物理麦克风/相机/声音。

- 第一轮定向 Web 单测：107/107；新增 OS 动态偏好回归后，motion/background/settings 13/13。随后并行新增 FileCard 时，旧 card 全量断言（26 renderer、无任何 button）需要对应更新，交主任务处理，不把旧断言误报成新动效失败。
- 代表卡片 before/after：周计划、待办、资讯；全部 21 场景的 light/dark 长截图；390px 周计划无页面横向溢出，pageerror 为空。
- 实际 Display renderer 动效录屏 `Vivic-space-light-actual.webm` 已通过：来源天空、真实卡片进入、思考球光、聚焦、强度/模式变化、暂停和减少动效。实测动画矩阵随时间变化；暂停后下一合成帧开始不再变化；运行中开启系统减少动效立即停止光层；pageerror 为空、背景无 WebGL。测试信号使用开发 store/合成卡片，回执 renderer 信号与真实持久化验收分开；跨端真实操作由主任务集成验收。
- 为避开并行开发 HMR 重置，录屏从 `.cache/.../site` 独立构建运行；保留开发验收入口，仅本机测试，不是可发布构建或交付安装包。
- 最终该分工 `@vivic/web typecheck` 与 scoped `git diff --check` 通过。任务自建 17936 开发服务、17937 截图构建预览服务已关闭，其他服务未动。

不提交、推送或公开发布。本报告只覆盖视觉分工，连接器、文件存储与手机传送门由对应分工报告说明。
