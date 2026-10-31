# 给 xlz：Hark 风格参考怎样用于 Vivic

本轮只整理资料，不实施 UI 重做。参考来源是 2026-10-15 历史 Hark 聊天研究；已有 [公开仓库](https://github.com/ECdison6227/hark-ui-research) 可读，不需要再为本任务修改仓库可见性。

## 先看哪些文件

1. Vivic 的 [现有适配评估](../research/hark-reuse-assessment.md)：识别哪些可复用、哪些是研究素材。文中旧 Grainient 描述是历史；当前背景以根 AGENTS 的流光以太为准。
2. 上游 [设计分析](https://github.com/ECdison6227/hark-ui-research/blob/main/reports/design-analysis.md)、[卡片代码分析](https://github.com/ECdison6227/hark-ui-research/blob/main/reports/card-code-analysis.md)、[运行记录](https://github.com/ECdison6227/hark-ui-research/blob/main/reports/runtime-analysis.md)。
3. 当前 Vivic 的 `apps/web/src/index.css`、`cards/scene/sceneCards.css`、`control/ControlDialogContent.tsx`、已批准 UI 组件，用这些承接新样式。

本地规范化包（`rea-ui-library/platforms/web/hark/design-package.json`）标记 `partial`：没有独立组件复刻/配对与跨产品验收，完整浅色运行和部分交互状态也未验证。该包不证明 Hark 设置页有完整规格。

## 可借鉴的设计原则

| 观察/资料 | Vivic 的使用方式 |
| --- | --- |
| 清晰的主次文字、受控内容宽度 | 保留现有 Geist/系统中文字体，分清标题、字段标签、提示和结果；Display 远看字号另验 |
| 克制的半透明表面、边线与圆角 | 映射到现有 card/foreground/border tokens，不把整份 CSS 全局覆盖进去 |
| 长内容换行、表格局部滚动 | 原型覆盖长中文、长模型名、空/错状态，不把页面撑宽 |
| 弹层与返回、忙碌/取消反馈 | 用 Radix/Motion 和现有 Dialog 实现，补焦点/键盘/取消验证；未实测的 Hark 行为标为 Vivic 设计选择 |

历史报告中的 15px 文本、特定模糊半径等是对应元素和场景的观察，不是全产品统一数值。尤其不要把输入区的大模糊效果铺到所有卡片，或用原站源码来替换已批准的 Orb、背景、画布。

## 这次 UI 原型范围

按会议做新手教程、订阅/自有配置、个性化、Store 引导和设置页面的 HTML 方案。订阅显示“待订阅”；连接状态用明确标注的 mock；Orb 位置不改，颜色可选；唤醒词是否开放待效果确认。教程/设置先后有争议，原型注明方案而非擅自做成不可逆流程。

现有公开研究主要是聊天、富内容卡片与输入区域，**不能据此声称完成了 Hark 原设置页的精确复刻**。如果要求严格对照设置页，需要用户补充可分享的截图/录屏；在此之前可以按已观察风格完成 Vivic 独立设计并说明来源边界。

原站字体和品牌素材的再分发许可未在本任务确认，不打包字体、私有聊天/DOM、登录态或原站完整 JS。团队附件提供经过检查的设计摘要和链接；“公开可看”和“可复制进产品”分别判断。
