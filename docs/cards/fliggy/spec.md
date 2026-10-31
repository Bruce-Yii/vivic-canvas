# 旅游卡 v0 与飞猪映射接口

2026-10-21。参考实现只有 DEMO，未连接真实飞猪 MCP。xlz 的独立映射应放 `contrib/fliggy-travel`，真实工具 Schema、鉴权与返回样本确认后再由维护者集成 live 适配器。

模型输出示例：

```json
{"cards":[{"scene_id":"travel_offers","data":{"kind":"hotel","destination":"杭州","dateText":"下周","nights":2,"budget":500}}]}
```

只允许用户明确给出的条件。酒店需目的地、日期（精确 startDate 或原话 dateText）与晚数；航班另需 origin；景点只需目的地。模糊日期不自动转成真实服务接受的具体日期，live 适配器有更严要求时先澄清。

| 字段 | 约束与来源 | 用户修改 |
| --- | --- | --- |
| query.kind | hotel/flight/poi；原文明确品类 | 重新查询 |
| query.destination/origin | 1–80 字；仅用户原话城市，不从工具或页面推断 | 重新查询 |
| query.startDate/dateText | YYYY-MM-DD / 1–80 字原文日期 | 重新查询 |
| query.nights/partySize/budget | 1–30晚 / 1–50人 / 正数预算；用户原话数值 | 重新查询 |
| items[].id/kind/title | 服务稳定 ID、品类、标题；title ≤200 字 | 只读 |
| subtitle/tags | 服务描述≤300字；标签≤8，每项≤40字 | 只读 |
| price.amount/currency | 有限非负数、ISO 三位大写币种；必须写明原服务税费/每晚或总价口径 | 只读 |
| rating | 0–5；上游非5分制需明确换算，不确定则省略 | 只读 |
| imageUrl/detailUrl | 受校验 HTTPS；禁止凭记忆补链接 | 只读 |
| selectedIds/notes | 唯一且仍有效结果 ID / ≤2000字 | owner 可编辑 |
| fetchedAt/mode/status | ISO时间 / demo或live / ok或empty | 宿主写 |
| sourceData | 严格 provider/tool/requestId/expiresAt? | 只读；无凭据 |

适配器实现 `TravelProvider.query(query, signal): Promise<unknown>`，输出先过 `TravelProviderResultSchema`：

```json
{"provider":"vivic-demo","tool":"travel.search","requestId":"example-1","fetchedAt":"2026-10-21T00:00:00.000Z","mode":"demo","query":{"kind":"hotel","destination":"杭州","dateText":"下周","nights":2},"items":[{"id":"sample-1","kind":"hotel","title":"杭州 · 演示住宿","price":{"amount":328,"currency":"CNY"},"tags":["模拟数据"]}],"status":"ok"}
```

对每个上游字段提交映射表：`上游JSON路径 → 本协议路径 → 单位/换算 → 缺失规则 → 真实脱敏样本`。无法证明的值省略；不得用模型补齐。原响应禁止作为 prompt、sourceData 任意文本或用户输入。mode 由后端配置决定，不能由模型指定。服务返回品类/查询不符、重复 ID、非法 URL/数值、超时与取消都不得保存结果。empty/error 的 items 必须为空，error 不建卡。

默认尺寸400×360。参考 renderer 复用 SceneCardShell，展示城市/条件、列表、DEMO/过期标记、provider与获取时间；User 可选结果和备注，Display 只读。长列表滚动，空结果明确说明，缺图不占固定白块。正式视觉由 TRAVEL-02 接替，沿用上述字段，不另造价格编辑入口。

参考测试 `apps/local-api/tests/travel-provider.test.ts`；运行 `pnpm --filter @vivic/local-api exec vitest run tests/travel-provider.test.ts`。验收须区分 fixture、模拟响应和真实 live；当前无真实飞猪证据。
