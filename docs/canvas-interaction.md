# 画布拖动、Pin 与 Control 设置接入

> 主线集成更新（2026-10-15）：Control 设置、Stage/背景/字幕/全局减少动效均已挂载。Auto 的 dayStart/dayEnd 默认 07:00–19:00，可修改且支持跨夜；分钟边界及隐藏恢复更新，React Flow 和背景使用同一个 resolved theme。按尺寸排版、旧画布重叠修复及「重新排布」已实现。下文模块初次交付范围属于历史记录；当前实际浏览器结果见 [最终报告](../evidence/phase3-final/REPORT.md)。

本次仅修改 CanvasView、canvasStore、sync 四个模块，新增 CanvasSettings、相关测试和本说明。ControlApp、StageRoot、全局 CSS、cards、contracts 和 package 保持原样；由主线挂载设置和全局减少动效配置。

## 主线组件与 API

```tsx
import { CanvasSettings } from "@/control/CanvasSettings";

// 仅 /control；host 是已有的 ControlHost。
<CanvasSettings host={host} disabled={busy} selectedCardId={selectedCardId} />
```

`disabled`、`selectedCardId` 均可省略。省略 selectedCardId 时列出当前画布所有未退出的卡片；传入时仅显示选中卡片。组件订阅 host snapshot 与共享 canvasStore，沿用现有 Button、Radix ToggleGroup/Switch 和 Control 面板样式，无需新增 CSS。只读、未 ready、接管恢复中或 disabled 时禁用控件。没有 Display 设置入口。

```ts
host.setCardPinned(cardId, pinned, canvasId?); // 默认当前画布；允许指定已有的非当前画布
host.moveCard(cardId, x, y, canvasId?);       // Control 需要手动改坐标时使用
host.setPreferences({ theme: "auto", reducedMotion: true, subtitles: false });
host.getSnapshot().preferences;
```

三个写入 API 均返回既有 `DispatchResult`。`ok` 表示通过校验并进入 owner 保存队列；落盘成功后才向 Display 确认，异步存储失败会进入 `ControlSnapshot.reminderError`（复用现有可见错误位置）。Display 保留此前已确认画面，不把拖动预览当作已保存结果。

`theme` 为 `light | dark | auto`。主题同步到现有 `ambient.theme`，StageRoot 的现有 resolveTheme 因而可继续处理日夜主题。偏好单独保存在 IndexedDB meta 的 `displayPreferences`，不扩展卡片/ActionEnvelope/CanvasRecord/VivicState contracts，不进入导出画布，不接收秘密字段。

`subtitles: false` 会清除当前字幕，并屏蔽后续 envelope/snapshot 中的 `state.subtitle`。注意现有 SubtitleLayer 还会渲染 `state.activity`（thinking/speaking 等），主线应在保持所有 hooks 调用顺序不变的前提下，用 `preferences.subtitles && line` 门控 AnimatePresence 内的整条字幕，让 activity 文字也遵守开关。卡片提醒/通知记录仍保留。设置不会打开麦克风、请求物理音频权限或播放声音。

`reducedMotion` 已作用于 CanvasView 的 focus/restore/fit 镜头，且与系统 prefers-reduced-motion 取 OR。其它既有背景/Orb 动效仍需主线在允许修改 StageRoot 时接入：

```tsx
import { MotionConfig, useReducedMotion } from "motion/react";
import { useDisplayPreferences } from "@/state/canvasStore";

const preferences = useDisplayPreferences();
const systemReduced = useReducedMotion();
const reduced = preferences.reducedMotion || Boolean(systemReduced);
// 包裹现有 Stage 层级，并将 reduced 传给已有背景降级接口。
<MotionConfig reducedMotion={reduced ? "always" : "user"}>{children}</MotionConfig>
```

MotionConfig 对显式设置 duration 的既有代码不能代替其 reduced 分支；主线应同时使相关组件使用上述 reduced 值。本分支没有修改 StageRoot/BackgroundLayer/OrbLayer，也不声称全 Stage 动效偏好已经验收。

## Display 拖动

`CanvasView` 默认使用 browserRuntime 的 `beginCanvasDrag` / `commitCanvasDrag`；沿用现有 `getDisplayRuntime(canvasId?)` 启动方式即可，无需给 Display 挂控件。runtime 可 `stop()`；同一 pinnedCanvasId 调用复用，切换 pinnedCanvasId 会停止旧 client/关闭旧 channel，丢弃迟到的旧 runtime。

流程：

1. Pointer drag start 从已同步 client 捕获 `CanvasDrag`：canvasId、owner epoch、canvas version、唯一 requestId、cardId 和完整 layout 基线。
2. 拖动过程中仅更新 React Flow 节点坐标预览，不写 canvasStore 卡片，不写 DB，不逐帧广播。
3. Drag stop 发送 `interaction`，payload 仅允许 `card.move`。Display 不能通过该通道 Pin、改偏好、发 ActionEnvelope 或创建/删除卡片。
4. 唯一 owner 在 host 边界重新执行严格 schema 校验，验证目标画布存在、owner epoch 匹配、版本不在未来、目标存在且非退出/非 pinned、layout 基线匹配。坐标必须有限且在 ±100000 内。
5. host 调用 canvasStore.interact 统一进行布局/卡片 schema 校验、requestId 去重和 record 修改。现有 Action 无 layout 字段，故使用此窄 interaction engine，不伪装 card.update，也不扩 contract。
6. owner 串行保存 CanvasRecord，成功后广播确认 snapshot；普通 ActionEnvelope 也改为保存成功后才广播 patch。Display 只能消费 owner 的确认结果。

限流为 **owner 全局每秒最多 24 条 interaction**，不按发送者 ID 分桶，换 ID 无法绕过。协议不是跨源认证机制，仅用于既有同源 BroadcastChannel。无 owner、已 stop、未完成 snapshot、正在 resync 或心跳过期时不能提交。丢失请求/限流后，预览最长 1500ms 回退，不冒充持久化成功。

## 冲突、切画布与恢复

- 同一卡片的并发拖动使用 layout 基线比较，先被 owner 接受的操作胜出；随后 stale move 不覆盖它。无关卡片/内容更新不强制废弃当前拖动。
- Pin 在 Control 操作；pinned 卡片不可拖动。拖动中收到 Pin/删除/布局变化的 snapshot，会清除该次预览。失焦或 pointercancel 也会取消。
- Display URL 的 pinnedCanvasId 与卡片 layout.pinned 是两个独立概念。固定在旧画布的 Display 可请求移动那个画布的卡片，owner 使用隔离 store 修改对应 record，不切换主控画布；跟随模式只接收 activeCanvasId 对应的 snapshot，旧画布更新不会把它切回去。
- 接管前先从 DB 恢复；恢复失败保持不可写。重新取得 owner 权限会更换交互 epoch，旧拖动不能跨接管提交。旧 owner 的排队写入在失权后不再执行；旧 owner 的 off 不会把新 owner 标为离线。
- owner 每 1200ms 发轻量存活通知；Display 在 3600ms 未收到存活信号时停止接受交互，并每 1200ms 重试 snapshot。owner 不在时保留最后画面；重连使用 snapshot，不重放旧交互。
- 从 DB 异步恢复的旧副本不会覆盖已经收到的新 owner snapshot。Display 永远不执行 putCanvas/setMeta。
- Pin 坐标保留于 create/delete/undo/fit、画布切换、重载与导出。Undo 恢复被删卡片的精确布局，包括未 pinned 但已手动移动的坐标。
- 未 Pin 的卡片依然参与后续 create/delete 的既有自动布局；需要保持绝对位置时使用 Pin。Fit 只改镜头，不改卡片位置。React Flow 的 minZoom 和 fitView.minZoom 均为 0.05，避免原 0.4 下限阻止 60 卡缩放到屏幕内。

## 验证与边界

测试文件：

- `apps/web/src/sync/__tests__/canvasInteraction.test.ts`：先落盘后同步、失败不确认、冲突、Pin、inactive canvas、schema/坐标/限流、去重、只读零写入、接管、失联/重试、设置恢复。
- `apps/web/src/sync/__tests__/browserRuntime.test.ts`：runtime 切换/停止、旧 IndexedDB 读取不覆盖新 snapshot、Display 零持久化写入。
- `apps/web/src/canvas/__tests__/CanvasView.test.tsx`：React Flow 预览不污染 store、丢包回退、Pin 中断、无 owner、减少动效和 60 卡缩放配置。
- `apps/web/src/control/__tests__/CanvasSettings.test.tsx`：真实 Radix 控件与 owner API、禁用、选中范围、失败反馈。
- 原有 `owner.test.ts`、`syncProtocol.test.ts`、`canvasStore.test.ts`、`autofit.test.ts`、`persistence.test.ts` 及 reminder owner/undo 回归继续执行。
- `apps/web/tests/e2e/canvas-interaction.spec.ts`：独立的真实拖动/刷新/Pin/undo，以及 800×600 下 60 卡 fit 场景，供主线统一执行。

```sh
pnpm --filter @vivic/web exec vitest run src/sync/__tests__ src/canvas/__tests__/CanvasView.test.tsx src/control/__tests__/CanvasSettings.test.tsx src/state/__tests__ src/persistence/__tests__ src/reminders/__tests__/reminders.test.ts
pnpm --filter @vivic/web typecheck
# 下列命令只交给主线；本次未运行 Playwright、未自行开服务器占端口。
pnpm --filter @vivic/web exec playwright test tests/e2e/canvas-interaction.spec.ts
```

本次没有真实浏览器视觉验收或性能录屏，60 卡浏览器验收待主线统一执行；单测里的 React Flow renderer 是边界 mock，不能替代实际拖动验收。最终验证：10 个相关测试文件、56 项测试全部通过，限定文件 oxlint 通过，`pnpm --filter @vivic/web typecheck` 最终通过；此前检查中其它线程的类型错误已不再出现。未自行运行生产构建、Playwright 或占用主线端口，prod 浏览器稳定性留给主线统一验收。已尝试启动负责设置模块的独立 Codex 子代理，但本机认证连续返回 HTTP 401，子代理未能工作；本次实现与代码检查由本线程完成，未声称独立评审通过。
