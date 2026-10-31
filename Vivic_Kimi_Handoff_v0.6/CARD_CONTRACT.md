# Vivic v0.6 — Card Registry / 极简卡片契约

**首要约束**：卡片是简洁信息可视化，不是聊天回复或说明书。AI 只能选择已注册类型并填 schema 允许的字段；不能借 `description`, `footer`, `advice` 偷塞冗余文字。

## 1. 结构

```ts
interface CardRecord<T extends RegisteredCardType> {
  id: string;
  type: T;
  variant: 'minimal' | 'standard' | 'expanded';
  displayProps: DisplayPropsFor<T>;    // 唯一被渲染的数据
  sourceData: SourceDataFor<T>;       // 给 AI 之后理解的数据，不直接展示
  sources: EvidenceRef[];             // 来源与抓取状态，不能伪造
  layout: { x:number; y:number; width:number; height:number; pinned:boolean };
  metadata: { createdAt:string; updatedAt:string; aliases?:string[] };
}
```

**注意** `canvas.focus` 是改变 camera 的行为，**不自动使 `variant=expanded`**。

## 2. 严格的 Minimal 显示字段

| 类型 | 只允许的 displayProps | 不能出现 |
|---|---|---|
| `CountdownCard` | `{}` 空对象；从 `sourceData.targetAt` 每秒计算并显示 `MM:SS` / `HH:MM:SS` | 标题、日期、说明、励志、进度说明、按钮、单位解释 |
| `TodoCard` | `{items:[{id,text,done}]}` | 描述、鼓励语、智能建议、固定 footer |
| `WeatherCard` | `{tempC, conditionIcon}` | 大段天气建议、城市故事、AI 判断 |
| `NoteCard` | `{text? , bullets?}` 至少其一 | 预设欢迎语、CTA、AI 总结的自我评价 |
| `SearchResultCard` | `{title,summary,sourceLabel}`，来源的 URL 见 `sources` | 未抓取内容的完整断言、解释性 footer、夸张文案 |
| `TableCard` | `{columns,rows}` | 任何分析性段落和 AI 的自评 |
| `ChartCard` | `{chartKind, points, xLabel?, yLabel?}` | 不必要的巨大标题、装饰图例或模板说明 |

严格限定最短文本：Todo 展示前 N 项（建议 3～5，剩余项目数据可在 `sourceData`）、Search summary 控制在一句话、Note 根据卡片尺寸优先用 1–3 行。超出内容可以裁切或由用户主动展开。

特殊提醒：**“放大卡片”=视觉变大**，不等于增加文字。

## 3. Schema 实现原则

- `contracts/{card-record,action-envelope}.schema.json` 从 `packages/contracts` 的共享 Zod 生成。运行 `pnpm contracts:generate` 更新、`pnpm contracts:check` 检查漂移，常规 API 测试也会校验生成物与有效/无效消息。
- JSON Schema 包括批量删除、子卡片及重复/条件提醒；跨记录目标、owner、数值来源、子卡片 ID 唯一性及真实 IANA 时区仍必须由运行时 Zod/执行边界验证，不能只依赖 JSON 结构校验。日期消息使用与运行时一致的 UTC ISO 字符串。
- JSON 类型分支的 `additionalProperties: false` 必须落实到 `displayProps`。`sourceData` 虽可扩展，但应限制体积并过滤 secrets。
- 任何不支持的 `type` 或 `displayProps` 字段拒绝/降级提示，不传给未经注册的任意 React component。
- Dynamic Generative UI spec 可以由 Adapter 从 Vivic Card 转换而来，但 spec 的组件 registry 是白名单，不向模型开放自定义 HTML/DOM。
- 优先 `renderGenerativeUI(spec, styledGenerativeUILibrary)` 且已安装 shadcn 样式。Countdown 时间动态部分可复用已批准 `Text/Card` 容器，但不生成额外文案。

## 4. 每个 Card 都可被自然语言引用

使用 `id`, `type`, `aliases`, `createdAt`, `lastFocusedAt`, `canvas position`、内容关键词解析「左边」「刚才」「第二个」「Todo」。当目标置信度低，不执行破坏性动作，仅高亮候选并询问。

## 5. 开发者扩展（接口预留，不做插件商店）

将来卡片 manifest 应提供：`id`, `version`, `displayPropsSchema`, `sourceDataSchema`, `renderer`, `allowedActions`, `sizeHints`, `themeTokens`, `dataSourceCapabilities`, `permissions`。默认不能访问 API Keys、Pi 凭据或执行网络/本地命令。只有经明确安装和权限审查的插件才能激活。

## 6. 视觉回归建议

- 针对七种最小卡片做静态截图快照（浅/深主题），保持行距、圆角、字重、阴影一致。
- Countdown 的断言 `screen.getByText('12:45')` 且 **无其它说明文本**。
- 在不同宽高/画布缩放下不能变成另一个有标题副标题的模板。
- `SearchResultCard` 必须可在 Control 侧打开来源 URL，但 `/display` 无固定“打开”按钮。
