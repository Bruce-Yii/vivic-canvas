# Model Platform Settings UI

独立的模型平台配置界面组件，支持预设平台和自定义 URL，自动发现模型列表。

## 功能

- ✅ 预设平台选择（本地 API、自定义）
- ✅ 自定义平台 URL 配置
- ✅ API Key 验证与连接测试
- ✅ 连接状态实时刷新
- ✅ 断开连接功能
- ✅ 完整的单元测试覆盖

## 使用方式

```tsx
import { ModelPlatformSettings } from "@/settings";

// 基础使用
<ModelPlatformSettings />

// 带回调
<ModelPlatformSettings
  disabled={backendOffline}
  onConnectionChange={(connected) => {
    console.log("Platform connection:", connected);
  }}
/>
```

## API 端点

组件使用现有后端端点：

- `POST /api/credentials/platform/validate` - 验证 API Key 并测试连接
- `POST /api/credentials/platform/disconnect` - 断开连接
- `GET /api/providers/status` - 获取平台连接状态

## 集成待办

**当前状态：** 组件已完成但未集成到 `/control` 页面。

**下一步（决策层窗口负责）：**

1. 在 `apps/web/src/control/ControlApp.tsx` 中导入组件
2. 添加到设置页面的合适位置（建议在 AI 连接设置之后）
3. 可选：将 `onConnectionChange` 回调连接到全局状态

### 集成示例

```tsx
// apps/web/src/control/ControlApp.tsx
import { ModelPlatformSettings } from "@/settings";

// 在设置区域添加
<div className="settings-section">
  <ModelPlatformSettings
    disabled={!snap.ready}
    onConnectionChange={handlePlatformConnectionChange}
  />
</div>
```

## 测试

```bash
# 运行组件测试
pnpm --filter @vivic/web test apps/web/src/settings

# 运行所有前端测试
pnpm --filter @vivic/web test
```

## 设计原则

- **独立性**：不依赖 control/** 内部状态，可在任何位置渲染
- **最小依赖**：仅使用现有 UI 组件和 API 端点，无新依赖
- **完整测试**：所有交互场景都有单元测试覆盖
- **清晰边界**：组件负责 UI 和 API 调用，不处理路由或全局状态

## 文件结构

```
apps/web/src/settings/
├── README.md                          # 本文档
├── index.ts                           # 导出入口
├── types.ts                           # 类型定义和预设配置
├── api.ts                             # API 客户端函数
├── ModelPlatformSettings.tsx          # 主组件
└── __tests__/
    └── ModelPlatformSettings.test.tsx # 组件测试
```

## 未来增强（可选）

1. **模型列表获取**：后端暴露 `/api/platform/models` 代理端点
2. **模型选择器**：连接成功后显示可用模型列表
3. **预设扩展**：添加更多常见平台预设（如 Ollama、LM Studio）
4. **连接诊断**：详细的连接失败原因和修复建议
