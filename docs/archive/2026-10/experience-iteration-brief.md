> 历史归档：原路径 `docs/experience-iteration-brief.md`。记录当时的需求与验证，不作为当前操作指令。当前入口：[README_FIRST](../../../README_FIRST.md)。

# 三项体验优化 brief（已实施）

2026-10-16：本 case 已按以下范围实施，结果与边界见 [交付说明](experience-20261016.md)。以下保留原 brief，不能再据「下一 case / 未实施」重复开发。

以下是实施前的 brief 留档，范围已完成，不能据其中的“下一 case”措辞重复开发。2026-10-16 已完成手测反馈、新 GPT 授权、子卡片/编号交互及本文件三项体验；当前顺序为 [一期收尾](finalization-20261016.md) 后按 [完整清单](../../FINAL_ACCEPTANCE_CHECKLIST.md) 从头验收，再逐项讨论二期。

## 已完成，直接复用

- 上海天气直接取真实数据、即时空表格及续填、带事项提醒合并、到时退出 Display、批量删除和整批撤销。
- Control「卡片与子卡片」：卡片及待办/表格/便笺行可添加持久化扩充，Radix Popover/Arrow + Motion 打开，Display 可只读阅读；同一份父卡片 metadata 保持同步和导入导出。删除父卡片后撤销一起恢复。
- 行关联：待办使用条目 ID；表格/便笺使用原行号和内容签名，源行变化时不错误迁移，Control 保留未关联内容，可显式移到整卡。
- 歧义候选显示固定编号，Control 回复「2号／第二个」或点击选择；悬停/键盘聚焦预览高亮。编号临时同步、两分钟过期，不写入画布；目标消失、切画布和 owner 变化均失效。提醒按精确事项直接定位/删除，只影响一项。
- 子卡片是补充内容，不替代下文的完整长文阅读弹窗。下一 case 应复用现有身份/生命周期和 Markdown 渲染，不能再造冲突的子卡片或候选选择系统。

工作目录 `/Users/cjr/Projects/vivic`，当前分支 `agent/next-iteration`。先读 README_FIRST、当前 AGENT_HANDOFF、原 COMPONENT_LOCK、`docs/research/hark-reuse-assessment.md`、`docs/research/open-source-experience-candidates.md`。研究提交 `e7b3f15`，只能用于研究结论，不能据此重复开发当前已有模块。

## 实施范围

1. **排版与材质**：参考 HARK 阅读层级/留白/半透明填充/安静节奏，通过现有 Assistant UI styled registry、Radix/shadcn、Motion 和主题 tokens 统一中文正文、标题、来源、数字及间距。沿用现有字体，Display 保持远看可读；纯 Countdown 仍仅数字，带事项提醒显示事项与时间并合并。保留 Grainient/Orb，协调公开参数，不给多卡叠加高成本 blur。不复制 HARK 压缩代码、私有组件、字体或天空程序。
2. **长内容详情**：优先 Control，用现有 Radix Dialog/Motion 阅读已有长便笺、文章正文、搜索摘要。只存稳定卡片 ID，从当前 store 读同一份内容，避免副本过期。支持键盘、Escape、焦点恢复、滚动和文字选择；处理切画布、目标删除、owner 变化。先复用已有 Markdown renderer，确有缺口才考虑 Streamdown。
3. **快速找卡**：Control 使用 shadcn Command/cmdk 和 pinyin-match，中文/全拼/首字母匹配标题、事项和便笺；显示类型/简短摘要，重复内容以稳定 ID 区分。入口 + Cmd/Ctrl+K，方向键/Enter/Escape 与中文 IME 正确。只匹配当前画布的活卡片，动态加载新增依赖，Display 不承担搜索代码。选中调用既有聚焦动作，不改内容、密度、固定状态；模糊匹配不直接删除。处理空结果、目标删除、切画布和只读权限，不自动抢 owner。

## 对原 prompt 的两条补充

- 详情弹窗的开关属于临时 UI 状态，不改 Note.variant；Note.variant 仍只控制画布展开/收起。阅读弹窗和卡片共用原始数据，不能因打开详情改原文或触发布局动作。
- 字号、行高、内边距变化要同步核对卡片测量与布局尺寸估算；保持固定卡避让、内容增长、撤销和旧画布恢复，两张均固定时不能擅自挪坐标。

## 验证与交付

先核对源码、保留工作区已有修改，只提交本次改动，小步提交，不推送/合并/发布。保留双视图、Action 校验、撤销与所有批准组件。

运行受影响前端测试、pnpm typecheck、pnpm build，以及详情/找卡的键盘、IME、生命周期浏览器回归。使用独立 context，5174/8788，不同 Playwright 命令串行；不操作用户真实画布，不开麦、不播放音频。

留实际截图并目视检查长文本、窄屏、材质、详情层、减少动效、固定卡和旧画布。最终说明改动、实际检查结果、剩余限制和提交。只完成这三项，不顺带引入研究名单的其他模块；不推进音色复刻或关闭浏览器后的提醒。其他本地决策模型是另一个后续任务，不与这次 UI 范围混做。
