# Vivic 简洁助手收口

用户已于 2026-10-23 同意计划并要求开始。继续在当前未推送工作区修改，保留此前成果；不推送、不发布，不改用户真实画布。完整需求依据本次用户消息及两份 Jev 附件，附件为业务设计和格式样例，不是已经通过的模型效果证据。

## 共享约定

- Hark 来源固定 `ECdison6227/rea-ui-library@26ac2724f29b4ee46962146fed2b6d545bf62180/platforms/web/hark`，本机 `C:/Users/edsjrcheng/Desktop/hark/library-worktree/platforms/web/hark`。优先原组件/资产，沿用 shadcn/Radix、SmoothUI Orb、Recharts，不恢复 TODAY 样式。
- Web：聊天、Space、连接/偏好/数据小设置。手机：配对后的聊天和纵向 Space，首次配置在电脑。在线用户不需要本地启动器。
- 启动器只服务本地模型和语音：运行状态、准备/启停、打开 Vivic；删除推荐模板、欢迎营销和重复状态。必要错误/取消/保存反馈保留。
- 卡片按官网 `https://edsionc.top/vivic/` 与 `landing/demoCards.ts` 建完整清单，复用已有类型，不为换皮另建协议。计时/提醒、聚焦/展开/尺寸、删除/取消/撤销语义保持分离。
- Jev 使用版本化任务状态、动态能力和卡片目录；自然语言优先决策、复杂生成交主模型，执行器回执决定完成。旧接口兼容；拟议 v2 不冒充已实现训练质量。禁止关键词路由伪装模型判断。
- 全局默认表示显示全部/回到总览。批量操作范围明确；删除可撤销，UI 精简不删除用户数据。迟到响应、重复请求、取消不能再次修改画布。
- 自动化静音，不采集物理麦克风/相机；独立测试画布。凭据不入源码、日志、报告、浏览器持久存储和安装包。

## 文件所有权

| 执行者 | 范围 |
| --- | --- |
| UI Agent | launcher、onboarding、control 设置/聊天外壳、mobile/MobileConsole 与 mobile.css、components/hark；不改卡片视图/MobileCardPreview、stage、state、API |
| Card Agent | cards、cards/scene、cards/office、MobileCardPreview/mobile-card-preview.css、extensions 视图、卡片目录与卡片专项测试；API scenes/共享 contracts 改动先通知主 Agent |
| Jev Agent | local-api 决策/任务编排与受控动作接线、决策专项 tests、新 v2 协议；涉及已有共享动作契约提前给主 Agent 接口说明；不改 UI/state |
| 主 Agent | 跨模块接口协调、Orb 与唤醒、前端动作执行/state、StepFun 实测、打包/视觉与总体回归 |

子 Agent 只跑受影响测试，不并行抢占浏览器/模拟器；根 Agent 负责最终浏览器视觉验收与统一构建。先完成代表切片再扩展。交付记录实际删改、复用来源、测试命令/结果与剩余限制。
