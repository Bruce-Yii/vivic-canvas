# TODAY 研究 → Vivic office/planner 映射

复核日期：2026-10-22。来源仓库 [franzkotkowski330-collab/today-ai-rea-research](https://github.com/franzkotkowski330-collab/today-ai-rea-research/tree/70a6d69d4e8cef19f6e3a3afd2d9bcfb41fa2ee6)，固定 commit `70a6d69d4e8cef19f6e3a3afd2d9bcfb41fa2ee6`。读取根 `design-package/`，没有运行来源脚本、修改原研究、复制私有原图、账号内容或凭据。

这是应用既有规范，不是本轮再次研究 Today 客户端。下表 A/B 是来源研究保留的分类及原有证据标识，不能称为本轮原站观测；D 是 Vivic 独立设计/实现。

## 来源能力结论

[README](https://github.com/franzkotkowski330-collab/today-ai-rea-research/blob/70a6d69d4e8cef19f6e3a3afd2d9bcfb41fa2ee6/README.md) 和 [最终验收](https://github.com/franzkotkowski330-collab/today-ai-rea-research/blob/70a6d69d4e8cef19f6e3a3afd2d9bcfb41fa2ee6/audit-results/08-final-verdict.md) 明确：视觉研究限已观察样本；UI 只有局部实现；参考后端是有限独立 HTTP/SQLite/echo/算术，旧 UI 未连通完整业务。内部生成算法、Prompt 和原版模型服务未知。不得宣称获得完整 Today 卡片引擎。

`design-package/design-package.json` 的 readiness 为 partial。公开 today.ai 与授权登录 todayai.cn 是不同来源身份，未证明后端/构建等价。认证原始截图、账号 state 等 withheld；本轮只引用公开元数据与报告，不宣称做了可复现的原图像素对照。

## 结构、交互与构造触发

| 来源规则 / 范围 | 来源分类与定位 | Vivic 落点与选择 | 验证 |
| --- | --- | --- | --- |
| 紧凑信息卡：标题、主信息、次级说明 | A，`auth-component-content-card`；`auth-evidence-screenshots-01-workspace`；精确容器圆角/内边距仍未知 | D：复用 SceneCardShell，会议结论/周期在任务列表上方，派生完成数形成主信息 | 三类型双模式样例；浏览器长文本截面 |
| 任务推荐行有8px列表间距；公开认证实测默认白20%→hover白35%，24px圆角、80px行高、16px/24px文字 | A，`auth-component-task-list`、`auth-interaction-recommendation-hover`；`auth-evidence-evidence-surface-styles` / `auth-evidence-interactions-flows` | D：在窄画布行保留8px间距与轻表面变化，采用宿主主题、16px局部圆角、13px文字、自动高度；未照搬672px宽行 | 局部CSS、12配色/窄屏、focus/禁用/减少动态效果 |
| 新任务空态与草稿，输入非空后发送可用 | A，`auth-component-task-detail` / `auth-interaction-task-draft-type`；`auth-evidence-screenshots-08-create-task`、`auth-evidence-screenshots-09-task-draft`。原研究未提交该任务 | D：明确空行动提示，添加/编辑表单标题必填，取消不提交；模型缺事实澄清 | 空/合法/非法数据、表单验证 |
| 消息与新任务目标绑定：`POST /v1/messages` 的 `target:{type:'new_task',surface:'task_panel'}` | B，[静态协议报告](https://github.com/franzkotkowski330-collab/today-ai-rea-research/blob/70a6d69d4e8cef19f6e3a3afd2d9bcfb41fa2ee6/reports/backend-static-findings.md)“聊天与任务绑定”；仅客户端声明 | D：采用 Vivic 的明确卡名 → 已安装 `ext.<id>` → 严格 Schema → 受控 Action 构造，不接原站 API、不推断私有算法 | 实际 runIntent/buildAllSceneActions 的 fixture 模型回放 |
| 客户端 task status / startedAt / hasUnseenResult 声明，completed/failed/stopped 为终态 | B，同报告“任务、定时模板与用户状态”；不证明自动调度或停止路由 | D：本地行动使用待办/进行中/受阻/完成，明确不运行后台任务；完成比例确定计算 | 枚举/非法状态拒绝；完成与原状态撤销 |
| 原站聊天中性消息提交与回复被观察 | A，`auth-interaction-neutral-message-submit/response`；`auth-evidence-interactions-flows`。无逐token/停止/完整错误证据 | D：复用 Vivic 自有意图处理/进度反馈；本卡不实现第二个聊天后端 | 自有 API 与 owner 的集成测试，不作为 Today 证明 |

组件和交互标识来自固定提交的 `design-package/components/catalog.json`、`patterns/interactions.json`；原始观测方法和限制见 [authenticated-study](https://github.com/franzkotkowski330-collab/today-ai-rea-research/blob/70a6d69d4e8cef19f6e3a3afd2d9bcfb41fa2ee6/reports/authenticated-study.md)。这些 `auth-evidence-*` 是来源包的 evidence catalog ID，不冒充 REA 新返回的 Evidence ID。

## 资源复用与未迁移项

直接复用 Vivic 已批准的 SceneCardShell/SceneEmpty、Lucide、现有输入/按钮样式、Geist/系统字体、React Flow owner/布局、声明式宿主和主题变量。未复制原站身份、字体、图标、品牌照片或参考后端；来源没有足以直接替代 Vivic runtime 的完整生成实现。字体保留宿主是适配选择，不声称 Figtree 在目标运行。

工作推进、会议行动和每周重点的业务字段、JSON Schema、来源标记、行内编辑、撤销、持久化及测试均为 Vivic D 实现。没有新增旅行业务；已有 TravelOffers DEMO 和数值目标进度继续复用原实现。后续飞书来源需单独受控适配器，不能从 Today 连接器展示推断 API 能力。

本轮源码与试用入口见 [卡片合同](../cards/office-planner.md)。目标功能测试通过不改变来源研究 partial；目标浏览器最终截图/模型抽样由集成验收单独记录。
