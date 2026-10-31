# Weather / Table / Chart renderer

> 主线集成更新（2026-10-15）：七类卡片、真实天气、数字表格/图表及转换已完成全页验证；真实数据七卡刷新前后无重叠。长内容更新、固定障碍、删除撤销和 800×600 布局也已通过 Chromium 浏览器回归。下文的测试数字和待集成说明为模块初次交付记录，当前结论见 [最终报告](../evidence/phase3-final/REPORT.md)。

范围仅 Web 卡片 renderer；七类 `VivicCard` registry 分支均已接通。没有修改 contracts、Control、canvas、全局 CSS 或依赖文件，也没有引入卡框、Display 按钮或新的视觉方向。

变更文件：`src/cards/VivicCard.tsx`；新增同目录的 `WeatherCardView.tsx`、`TableCardView.tsx`、`ChartCardView.tsx`、`NoteCardView.tsx`、`StyledDataTable.tsx`、`dataCardTypes.ts`、`__tests__/fixtures.ts`、`__tests__/dataCards.test.tsx`；新增 `tests/e2e/data-cards.spec.ts`，以及本文档。前述代码路径均相对 `apps/web/`。

## 组件与展示约定

- Weather：使用已安装 Assistant UI styled registry 的公开 `Row.render` 和 `Text` API，以及 Lucide `Sun / Cloud / CloudRain / CloudSnow / Wind / CloudFog / CloudLightning / Moon`。只显示原始 `tempC` 数字、°C 和天气图标。位置、时间、来源仍保留在原始 record 中供 Control 查看。非有限数或超出契约温度范围时显示 `—`，不补造读数。
- Table：使用已安装 styled registry `Table` 的公开 spec API，将 `columns: string[]` 映射到 `{label}` 列定义；`rows` 保持原顺序。`false`、`0`、负数原样呈现；null、缺失单元格、异常非有限数字显示 `—`。短行补缺失占位，额外单元格不新增未经声明的列；原始数据不变。全部数据行可在局部滚动区查看，高度取 `max(56, layout.height - 32)`，不增加摘要或排序按钮。
- Chart：实际使用 **Recharts 3.10.1（MIT）** 的 `LineChart / BarChart / PieChart`、轴、Tooltip 和原生标签；线为 linear，不增加平滑插值。数值 x 使用数值轴保留间距，其他 x 使用分类轴。line/bar 保留负数与零，bar 轴包含零基线。使用现有 `--chart-1` 至 `--chart-5`、card/border tokens；没有手绘 SVG、图例或额外标题。
- Note：继续用 styled `Col / Text`。`minimal` 最多约三行的裁切高度，`standard` 约六行，`expanded` 完整展示 `displayProps.text/bullets`；只认 record 既有 variant，不因 focus 改变，不加展开按钮，不将 `sourceData` 原文自动搬进 Display。

## Table 行高亮的动作端约定

`card.highlight` 的 `targetId` 必须为该 Table 的 card id；`itemId` 使用 **`row:1`、`row:2` … `row:100`**，指向当前 `displayProps.rows` 中从 1 开始的原始位置。不从首列文本、数字或 `sourceData` 推导 id；重复文本不会歧义。动作不带 itemId 或位置不存在时，不添加行级高亮。

当前 schema 没有独立 row id 字段。因此稳定性指同一数据数组位置：renderer 不排序、不筛行。若业务端重排/替换 rows，应同步使用新位置发出高亮，不能将 `row:2` 解释为跨排序的实体标识。

已安装的 styled Table 没有 row props / row-renderer API。`StyledDataTable` 通过自身局部 ref，在真实 `tbody > tr` 上附加 `data-vivic-row-id`，并按需附加既有 `data-vivic-highlighted` 和 `aria-current`；高亮切换、清除和数据更新均重新同步。没有复制 Table 实现或使用私有 import。

## 不可绘制的图表数据

Pie 只适用于非负且总和有限、严格大于零的数据。任何负数、全零或总和溢出时，整组原值改用同一 styled Table 展示，列名取 `xLabel/yLabel`（未提供则为 `x/y`）。不取绝对值、不删除负数、不归零、不伪造比例，也不改写 card 或 chartKind。

任何图表的非有限数或尺度范围溢出也降级为原值表格；无有效数字的单元格为 `—`。越过契约直接传入的空 points 显示 `—`，不生成演示点。正常数据不会被取样、重排或合并。

`ResponsiveContainer` 使用 `width="100%"`、固定正高度、`minWidth=1` 和来自卡片 layout 的正 `initialDimension`，高度限制为 144–640px。由 Recharts 自己的 ResizeObserver 处理真实布局和隐藏后恢复；零宽布局下不向 chart 下发非正尺寸。依据已安装 3.10.1 实现及 [官方 ResponsiveContainer API](https://recharts.github.io/en-US/api/ResponsiveContainer/)。图表关闭自身入场动画，避免叠加现有画布动效。

## 验证与边界

所有 fixture 在 id、aliases、来源 provider 或可见数据中标记为 **TEST / DEMO**，只是前端合成测试数据，不代表联网、实况天气或真实抓取。本 renderer 不发起数据请求；真实 provider、来源和 Control 操作由其他开发范围提供。

```sh
pnpm --filter @vivic/web typecheck
pnpm --filter @vivic/web test src/cards/__tests__/dataCards.test.tsx
pnpm --filter @vivic/web test
```

针对性测试渲染真实 styled registry 和真实 Recharts，仅模拟 jsdom 不具备的 ResizeObserver / 布局边界，覆盖七类 registry、Weather 图标/异常值、Table 值适配/稳定行高亮/清除、数值轴间距、真实 line/bar/pie marks、负数 Pie 原值降级、非有限/溢出数据、零宽/窄宽/恢复、Minimal 信息边界与 Note variant。

唯一新增 e2e 为 `apps/web/tests/e2e/data-cards.spec.ts`，覆盖 Control → Display 同步、九个 TEST 卡片（七类加 bar/pie）、行高亮迁移、真实尺寸变化、负数 Pie 降级及 Display 重连。**本次按分工不运行 Playwright、不启动浏览器或额外服务；尚无本次真实浏览器截图/录屏，视觉验收和 e2e 执行仍待主线程统一验证。**

本次验证记录：

- 卡片专项单测：26/26 通过；新增/修改文件 oxlint 通过。全部卡片源码及单测、e2e 文件均以 TypeScript API 单独静态检查通过，没有调用 Playwright。
- Web 全量 unit：125 通过、2 失败。失败位于范围外的 `reminders.test.ts`（inactive canvas notifiedAt 尚未持久化）和 `syncProtocol.test.ts`（owner restart 后缺第二张卡），未修改这些模块或测试。
- 已运行 Web `typecheck`：卡片范围错误已清除；共享项目仍有 `ai/localSpeech/model.worker.ts:26` 的 `string[] / ModelId[]` 不兼容和 `modelManager.ts:22` 的 `erasableSyntaxOnly` 错误，交由对应开发者处理。
