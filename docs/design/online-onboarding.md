# Vivic 线上新手引导

本轮按用户 2026-10-23 的最新方向，仅实现线上模式。在线 API 用户直接使用网页；本地启动器、模型下载和训练不进入这条引导。

## 接口与集成

`apps/web/src/onboarding/OnlineOnboarding.tsx` 导出：

```tsx
interface OnlineOnboardingProps {
  onComplete(draft?: string): void;
  onCancel?(): void;
  disabled?: boolean;
}
```

父组件决定首次展示、完成标记和从设置重新查看的入口。重新打开时重新挂载组件；组件不自行写 localStorage、IndexedDB、画布、聊天或完成标记。`draft` 仅是用户明确勾选的“试着整理今天的清单”，父组件应将其放进可编辑输入框，继续由用户发送，不自动请求模型或生成卡片。`onCancel` 提供时显示关闭按钮。

## 三步流程（D 目标产品选择）

1. **认识 Vivic**：一句说明与固定示例指令；“查看示例”展示本地静态卡片，明确标注不加入 Space。可以直接继续，示例不调用 AI、不修改真实数据。
2. **连接在线服务**：进入本步才检查既有 active provider；已有有效 StepFun/GPT 连接可继续。新连接仅支持已实现的 StepFun Coding Plan。提交 Key → 真实推理验证端点 → 选择 StepFun → 重新查询 active/connected 状态，全部成功才显示已连接。失败保留重试、返回与“先体验基础功能”，不假设后台正常。
3. **进入 Space**：AI 已连接时可选清单草稿，基础模式明确尚未连接 AI。个性化留给设置，不放置套餐、商店或本地下载的空入口。

凭据输入在每次尝试发起时即清空，成功、失败、返回、取消、禁用时均不留在输入框。组件不显示后端原始错误，避免错误中意外携带凭据。返回、取消、卸载或 owner 禁用会使晚到结果失效；不会推进步骤、再次切供应商或触发完成。已发到服务器的验证可能在后台完成，取消引导不等同于撤销服务端连接。

## Hark 来源与直接复用

来源为 `ECdison6227/rea-ui-library@26ac2724`，`platforms/web/hark`。读取其 `design-package.json`、`DESIGN_SPEC.md` 和 `ADAPTATION_GUIDE.md`；来源 readiness 为 partial，目标引导不冒充 Hark 原生流程。

| 来源规则/资产 | 目标落点 | 采用方式 | 验证 |
| --- | --- | --- | --- |
| 原 GT Standard L / Hark Serif 字体（B） | 标题、正文、示例标题 | 沿用现有 `components/hark/hark.css` 注册与 fallback，不复制新字体 | 集成浏览器检查网络与 computed font；中文平台 fallback 保留 |
| 原 SVG glyph（B） | 返回、下一步、关闭、示例清单 | 直接调用 `HarkIcon`，无新绘图 | DOM `data-glyph` 与既有 provenance |
| 连续圆角、透明 fill/stroke（B） | 示例卡片 | `HarkSurface` 薄 React 包装（D） | 现有几何 helper；集成真实视口检查 |
| 既有 Hark 按钮/输入映射（D） | 全部操作与密码字段 | 复用 `Button`/`Input`，由 `.vh-hark` 生效 | 键盘、loading、disabled、error 状态 |
| 已接入的原 shader 冻结画面（B 原 shader / D 冻结输入） | 页面背景 | `HarkBackdrop`；无新背景、渐变或动效 | 深浅主题与 reduced motion |
| 原 512px 内容带和 390px 左右16px（A/B） | 单列引导 | 512px 内容带；窄屏16px边距（D 领域适配） | 集成桌面/390px、键盘与短屏 |

固定示例、三步顺序、基础模式、取消失效策略、标题尺寸和错误文案为 D 目标选择；来源不存在此 Vivic 引导，不将本轮测试升级为来源 A 证据。不重新运行 REA，不改原资产。既有 Hark NOTICE、SOURCE 与许可边界继续适用。

## 验证边界

组件事件测试使用真实 DOM 表单、按钮、checkbox 与 mock provider promises，覆盖示例/跳过、已有连接、成功链路、失败清空、取消/返回/禁用后的晚到结果、基础体验与草稿交接。不触真实后端、麦克风、音频或用户画布。桌面、390px、深浅主题、键盘与 reduced-motion 的浏览器检查由集成方在隔离上下文执行。

本切片验证：`pnpm --filter @vivic/web test src/onboarding/OnlineOnboarding.test.tsx` 14 项通过；`tsc -p tsconfig.app.json --noEmit --incremental false` 通过；`oxlint src/onboarding` 无告警。上述测试证明目标状态与事件逻辑，不证明真实服务连通、Hark 原版行为或完整页面集成。
