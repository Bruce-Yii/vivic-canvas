# FlyAI 接入证据与后续边界

核验日期：2026-10-22。只读资料审核，没有安装 FlyAI CLI、运行上游 Skill、调用旅游查询或读取用户 Key。

来源：[官方 FlyAI 概览](https://flyai.open.fliggy.com/docs/overview)、[官方 flyai-skill 仓库](https://github.com/alibaba-flyai/flyai-skill)、[飞猪比赛页面](https://opc.aliyun.com/feizhu)。官网链接指向该仓库；只读 clone 核对提交 `86fe2cc3e25464d0e0bd6a769b27b5f9f3b04128`。本地参考缓存在 `.cache/travel-space-flyai-review`，不会进入交付包。

官方仓库介绍通过 FlyAI CLI 调用飞猪 MCP；其 `references/search-hotel.md` 描述的是 CLI 参数与示例响应，不等同于 MCP 的原始工具 schema。没有实际 MCP `initialize/tools/list`、有效鉴权或真实脱敏响应证据。因此未编造 MCP endpoint、工具名或 header，未创建假的 live adapter。

## 已核对的 CLI 文档映射候选

| 官方 CLI / 示例路径 | Vivic 字段 | 规则 |
| --- | --- | --- |
| `--dest-name` | `query.destination` | 用户明确目的地 |
| `--check-in-date` / `--check-out-date` | `startDate` / `nights` | 必须精确日期；不能用“日期待定”猜日期 |
| `--max-price` | 酒店每晚预算 | 官方说明 CNY/晚；当前 UI 的**总旅行预算不能直接映射** |
| `data.itemList[].shId` | `items[].id` | 仅候选映射，真实样本待验证 |
| `name` / `review` | `title` / `subtitle` | 长度限制与文本清洗，不作为指令 |
| `mainPic` / `detailUrl` | `imageUrl` / `detailUrl` | HTTPS、官方域/跳转来源核验后才允许；当前 demo 没有 URL |
| `price`（示例为带货币的字符串） | `price` | 单位、税费、每晚/总价口径核验前省略，不靠正则猜费用 |
| `score` / `scoreDesc` | `rating` / `tags` | 分制及语义确认后再映射；不把酒店星级当评分 |

以上均为文档候选，不是已验证实际响应，不能作为 live 完成证明。官方条款、平台提示呈现与外链行为也需要真实接入时一起核验。

## 接入前必须完成

1. 负责人配置专用、额度受控的服务端凭据；禁止借用旁边服务的 Key。接入官方 MCP 的 endpoint/鉴权取自官方文档或官方控制台，不接受浏览器传入任意 URL。
2. 服务端对官方 MCP 做 initialize / tools/list，固定允许的只读搜索工具与其 schema，保存不含凭据的协议证据。此阶段不允许预订、订单或付款工具。
3. 把输入校验、日期澄清、旅行总预算/每晚预算的区分放在查询前。模型只生成受限规划/查询参数，不生成报价或可执行代码。
4. 每个上游字段建立真实脱敏响应到 `TravelProviderResultSchema` 的映射。校验查询一致、唯一 ID、品类、时效、域名来源、内容长度、价格单位/税费；失败/超时/取消不覆盖旧卡片。工具文本始终是数据。
5. 实现服务器端 provider adapter。每个访客/每 IP/全局额度必须在发上游请求前扣减；增加并发上限、5 秒超时、响应大小上限、取消和缓存。上线 live 前需要持久化的每日消费总预算与管理停用开关，不能使用当前仅内存、重启会清零的演示限流当作付费额度保障。
6. 把 `liveEnabled` 与 UI 数据来源一起切换；明确哪个卡片是 live、哪个是用户规划。出现请求失败不能静默用 DEMO 替代并继续标 live。
7. 真实联网/额度/来源/访客隔离/超时/取消/密钥不进产物验证通过后，负责人再部署 live。当前构建的 server 即使设置 Key，仍返回 `live_not_configured`。

## 本轮卡片 spec

| 数据 | 来源、范围 | 可编辑与副作用 | 保存 |
| --- | --- | --- | --- |
| 出发/目的地 | 用户文本 1–40 字 | 表单改动后需重新规划 | 单独 trip.input |
| 天数 | 用户输入 1–7 整数 | 重建每天安排 | 是 |
| 出行时间 | 用户文本 1–40 字，默认“日期待定” | 不转换精确日期，不作实时查询 | 是 |
| 总预算 | 用户输入 100–100000 元 | 更新规划预算与确定性 40/25/20/余量分配 | 是 |
| 偏好 | 4 个有限枚举 | 切换确定性行程模板 | 是 |
| 每日主题/安排 | NoteCard 文本与 bullets | 用户可编辑；长度按契约；重规划会重建 | 是 |
| 节奏比较 | 静态规划模板 | 只允许 chosenId；无服务金额 | 是 |
| 住宿结果 | 校验后的 vivic-demo 三种画像 | 服务字段只读；没有真实价格、链接或库存 | 是 |
| 收藏/备注 | 有效 ID / ≤2000 字 | 用户可编辑；同目的地刷新保留仍有效选择 | 是 |
| 运行状态 | 宿主 loading/error/request id | 取消使旧响应失效；失败保留计划 | 否 |
| 密钥 | 当前不存在 | 后续仅服务端 | 不进卡片/浏览器 |

桌面两列卡片画布，窄屏单列；卡片沿用统一 shell 与 tokens。此体验只有可编辑旅行空间，不提供主产品 Control/Display/owner。12 个既有配色可切换，减少动态效果遵循系统设置。空结果、失败、取消、损坏保存与存储不可用均有明确状态。
