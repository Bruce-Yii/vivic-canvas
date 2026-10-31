# 卡片导入与 Vivic Test Space

2026-10-21：PLAT-02 已实现设置导入 → 静态校验 → 独立 Test Space → 确认安装。v0.1 仅支持声明式包，完整格式与限制见 [卡片包协议](CARD_EXTENSION_DESIGN.md)，参考包见 [目标进度](../examples/card-packages/goal-progress)。

## 使用流程

1. 在 `/control` 的“扩展卡片管理”点击“导入卡片包”，选择 `.vivicard` / ZIP。
2. 解析显示文件名、结构错误和对应文件/字段。解析不执行包代码或外部调用。
3. 校验通过后自动打开 Radix Dialog 的 **Vivic Test Space**，显示名称、版本、内容 SHA-256、结构校验结果和“真实连接未验证”。
4. 选择包中不同示例、编辑合法参数/个人状态、切换 User/Display 和 6 深 + 6 浅背景配色。预览统一标注 DEMO。
5. 点击“试跑 DEMO”：用当前参数、数据和状态走同一 Schema 与内存 reducer。通过后才可安装；参数、状态、示例变化或取消试跑立即使通过结果失效。
6. 点击“安装卡片”：重新校验精确包内容及 hash，检查版本冲突，事务提交成功后才发布至可用目录。
7. 安装不创建画布实例。用户在定义旁点击“从 DEMO 创建卡片”才通过 owner 的受控 card.create 路径创建正式实例。Test Space 的试跑数据不会自动进入真实画布。

v0.1 不支持服务能力与 live 试跑。界面明确区分结构通过、样例运行通过、真实连接未验证；不能把前两者解释成真实服务验证。任意外部副作用不因“试跑”获得授权。

## 会话隔离

每个弹窗创建一个独立 `TestSpaceSession`：随机 token、同一 createCanvasStore 内存 reducer、新实例 ID、新请求标识。它不创建 owner、BroadcastChannel、IndexedDB、真实模型或服务连接；不引用当前真实画布。正式定义目录的读取与预览 reducer 独立。

关闭、换包、清除本地数据、控制权丢失或组件卸载都会使旧会话失效并清空内存。迟到解析/试跑由 generation/token 检查丢弃。安装重新检查活动会话，若关闭发生在写入期间，提交后回滚并且不发布到内存目录。默认没有后台计时器、媒体资源或服务请求。

Escape/关闭按钮退出，焦点回到导入入口。声音和麦克风沿用仓库静音约定。所有浏览器验收用独立 context，不触碰用户真实画布。

## 安装与恢复

- 校验、试跑和安装绑定同一 hash。换包清空旧结果；修改内容后必须重新校验/试跑。
- 同内容重装幂等；相同 ID/版本不同内容拒绝，升级须增加版本。多个版本保留以恢复旧实例。
- 禁用/卸载后原始 ExtensionCard 数据仍存于画布，显示明确占位；导入精确原包/重新启用可恢复。
- 页面重新加载后从 definitions store 重验包内容，不依赖构建时 registry。
- 损坏/不兼容定义保留原始存储数据并提示重新导入，不使整张画布消失。
- 安装失败不发布半成品定义；完整清除本地数据同时清除定义和缓存。

## 实际接口与验证

packages/card-runtime 提供 `parsePackageFiles`、`readPackageZip`、`revalidateDefinition`、`validateInstance`，CLI 为 `pnpm card:check <dir|zip>`。Web definitionStore 提供 exact-ref 查找、安装、禁用、卸载和同步加载；ExtensionCardView 负责受控组件呈现及缺包占位。

使用 `pnpm card:pack <目录> <输出.vivicard>` 制作可移植 ZIP，再用 `pnpm card:check <输出.vivicard>` 复核。打包器先校验原目录，统一使用 `/` 目录分隔符，打包后重新校验内容哈希；输出文件已存在时拒绝覆盖。Windows PowerShell 旧版 `Compress-Archive` 可能写出反斜线目录名，不满足此协议，推荐直接使用本命令。

自动化覆盖：合法/非法 Schema、示例、UI 绑定、路径、ZIP 大小/CRC、重复 JSON 字段、内容 hash、隔离/取消/迟到试跑、安装幂等、重启、禁用/卸载/重装、坏定义保留。`apps/web/tests/e2e/card-packages.spec.ts` 从系统临时目录生成一个真正的外部包，验证 12 配色、两种模式、焦点返回与实例恢复，并输出预览截图。视觉和真实外部服务能力须分别报告，不能把自动化样例通过称作 live 通过。
