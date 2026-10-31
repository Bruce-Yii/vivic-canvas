# 声明式卡片包 v0.1

2026-10-21：PLAT-02 已实现声明式包校验、导入、Test Space、安装/禁用/卸载、持久化与扩展实例。设置入口在 `/control` 的“扩展卡片管理”。不改源码、不重新构建即可导入新的定义。具体流程见 [Test Space](CARD_TEST_SPACE.md)。

## 制作与校验

以 [目标进度参考包](../examples/card-packages/goal-progress) 为模板，在仓库外的目录制作。包内只含 UTF-8 JSON：

```text
manifest.json
config.schema.json
data.schema.json
state.schema.json
ui.json
examples/default.json    # 至少一个，最多 12 个
```

将这些文件直接压缩成标准 ZIP，改扩展名为 `.vivicard`；ZIP 根目录必须直接含 manifest，不能多包一层目录。在仓库根运行 `pnpm card:check <目录或包绝对路径>`，相对路径相对于调用目录解析。校验工具不联网、不执行包代码。参考命令：`pnpm card:check examples/card-packages/goal-progress`。

manifest 严格使用以下字段：

```json
{"formatVersion":"0.1","id":"example.my-card","version":"1.0.0","name":"我的卡片","description":"具体用途和数据来源","renderer":"declarative","host":"0.6","capabilities":[]}
```

ID 为小写域式标识，最长 80；版本为 `x.y.z`。`capabilities` 必须为空：v0.1 仅组合受控组件，不支持 JavaScript、HTML、CSS、iframe、表达式、外部服务、动作或任意文件。未知字段直接报错。复杂交互需要后续版本定义明确宿主协议，不能放入 v0.1 包执行。

## 数据 Schema 与编辑边界

config 是用户参数，data 是只读信息，state 是个人选择/备注等状态。三个 Schema 根都为 object，必须声明 `properties` 和 `additionalProperties:false`。每个 object 至多 64 字段；字段名为英文字母开头的英文字母/数字/下划线/连字符，最长 64。禁止原型相关名称。

支持的 JSON Schema 子集：

| 类型 | 允许字段（除通用字段外） |
| --- | --- |
| object | properties、required、additionalProperties:false |
| array | items、minItems、maxItems |
| string | minLength、maxLength |
| number / integer | minimum、maximum |
| boolean | 无 |

通用字段：type、title、description、default；基础类型可用 enum（1–50 个同类型值）。标题/说明最长 400；default 也必须通过 Schema。所有嵌套值均声明 type，不支持 `$ref`、正则、组合条件、格式校验或动态关键字。Schema 嵌套最多 10 层；数组默认最多 200 项；字符串默认最多 10000 字符；声明值域只能收紧这些上限。

每个示例严格包含 `{name,config,data,state}`，三个对象都必须通过各自 Schema。示例可覆盖长文本、空数据、完成等状态。宿主生成参数/状态控件；复杂数组/对象使用失焦后校验的 JSON 编辑器。data 无编辑控件。owner 边界重新校验值域，普通更新不能改变 data 或 def。参数变化不会自动查询外部服务。

## UI 目录与绑定

ui 格式为 `{"components":[...]}`，1–30 个纵向组件。每个组件包含 `component`，可选 `label`，以及互斥的 `text` 或 `bind`。bind 是 `/config`、`/data`、`/state` 下的 JSON Pointer，路径必须在 Schema 声明；没有求值器。文本由 React 转义。

| component | 绑定数据与表现 |
| --- | --- |
| Header | 基础值，标题 |
| KeyValue | 基础值，标签/值 |
| Metric | 基础值，大字号数字/文本 |
| Badge | 基础值，徽标 |
| List | 数组，逐项展示，无数据占位 |
| Image | 字符串，仅允许无用户名/密码的 HTTPS URL |
| Link | 字符串，仅允许无用户名/密码的 HTTPS URL；新窗口且 noopener |
| Table | 对象数组；必须声明 columns:[{label,field}]，1–8 列，field 引用 items.properties |
| Progress | number/integer，0–100 百分比展示 |

示例：`{"component":"Header","bind":"/config/title"}`。不支持的组件/属性、错误绑定类型均阻止导入。UI 复用 SceneCardShell 和现有主题；同一定义支持 User 编辑/Display 只读。

## 文件、身份与版本

压缩包至多 1 MiB；最多 32 个文件；单文件至多 256 KiB；解压总量至多 1 MiB。仅接受协议中的 JSON 路径，拒绝绝对路径、反斜线、上级目录、重复项、嵌套目录和符号链接输入目录。标准 ZIP 校验中央/本地目录、压缩方式、CRC、完整性；拒绝加密、ZIP64、分卷；流式解压再次限制实际大小。JSON 拒绝重复字段、危险原型字段、非有限数值和过深/过大的结构。

内容身份为所有包 JSON 文件按字段/文件名排序、规范化后 SHA-256；空白/键顺序不改变身份。示例也是包内容。安装、重启加载和后端接收定义都会从原始 files 重验完整定义及 hash，不能靠缓存的“通过”标志安装。

相同 ID/版本/内容重装幂等；相同 ID/版本但内容不同拒绝，必须升版本。不同版本可共存，实例精确引用 `{id,version,hash}`，不会被新版本静默替换。定义存于 Vivic IndexedDB v2 的 definitions store。禁用/卸载只改变可用目录，实例仍保存原始数据并显示占位；重新导入相同内容恢复。损坏定义保留原始存储记录并显示诊断。清除全部本地数据会同时清除定义。

## 实例、模型和权限

共享契约 ExtensionCard 的 displayProps 为 `{def:{id,version,hash},config,data,state}`，sourceData 为严格空对象。外层 Zod + 内层已安装定义 Schema 双重校验。声明式包不能获得模型、系统执行、账号或真实服务能力。

已安装且启用的定义可参与动态 `ext.<id>` 场景。客户端只发送有界数据定义（最多 8 个、每个 100 KB、总计 400 KB），后端仍重新校验包内容。模型只能输出符合定义的数据，不能改变 UI/权限；数字、日期、URL 等事实继续检查用户文字依据。没有安装/已禁用的定义不发送给模型。大型包仍可手动创建，但超出请求预算不会参与模型场景选择。

“从 DEMO 创建卡片”是安装后的独立操作，创建包中第一个示例的正式实例；Test Space 的编辑不会自动复制到真实画布。示例数据不代表在线结果。真实服务集成使用受控 ProviderResult/适配器路线，不属于 v0.1 包权限。

## 验证

纯 TS 实现在 packages/card-runtime；Web 验证位于 extensions/__tests__；浏览器验收为 `pnpm --filter @vivic/web test:e2e card-packages.spec.ts`（隔离 5174/8788，静音）。验收包括仓库外临时包、参数/主题/模式、安装与创建分离、重启、禁用/卸载数据保留、非法 ZIP、会话取消与失焦回归。真实连接未验证，v0.1 不提供 live 试跑。
