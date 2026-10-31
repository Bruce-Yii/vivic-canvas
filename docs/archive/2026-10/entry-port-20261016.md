> 历史归档：原路径 `docs/entry-port-20261016.md`。记录当时的需求与验证，不作为当前操作指令。当前入口：[README_FIRST](../../../README_FIRST.md)。

# 手测入口端口修正 · 2026-10-16

用户打开此前提供的 `http://localhost:5173/control` 后看到发布会工作台。实查 5173 的监听进程来自另一个项目，HTML 标题为“舞台 · 发布会工作台”，不是 Vivic。此前仅确认 HTTP 200、没有核对页面身份，因此给出的入口不正确；本记录更正这一结论，不影响已在隔离 5174/8788 运行的代码回归。

## 正确入口

- Control：**http://localhost:5175/control**
- Display：http://localhost:5175/display，或从 Control 打开展示窗口。
- 本机 API：`http://127.0.0.1:8787`；浏览器通过 Vivic 开发代理使用，不直接持有本机 bearer。
- 自动化继续使用 5174/8788，与手测端口分开。5173 的其他项目未停止或修改。

Vite 现在默认 `127.0.0.1:5175`、`strictPort:true`，不会在端口被占用时自动换到另一个地址。页面标题和 application-name 改为 Vivic，方便核对。API 默认允许对应的精确 localhost/loopback origin，保留测试/历史 origin；显式 `VIVIC_ALLOWED_ORIGINS` 覆盖仍生效，不放开任意端口或通配符。

修正前通过应用既有代理检查到 StepFun/GPT 均未连接，配置热重载没有丢失已连接的内存 Key。没有读取/打印认证文件、恢复账号或发起新登录。

## 实际验证

- 真实监听进程工作目录已核对为本仓库 `apps/web`，页面 title 为 Vivic、主标题为“Vivic 控制端”。
- 独立 context 在 **真实 5175** 打开 Control，通过同源代理 POST `/api/intent` 返回 HTTP 200 / `usedProvider:rules`；没有调用模型或派发到用户画布。
- 实际 UI 创建带 TEST 标记的待办，另开同端口 Display 收到一张同内容卡，无页面异常。TTS 关闭、禁止播放/物理麦克风，context 已关闭。
- 当前 5175 已占用时，再运行默认 web 启动命令明确退出失败，未静默切到 5176。
- 单测 Web 386 + API 883 = **1,269 通过**，另 3 项外部网络测试跳过；类型/构建通过。新增 default origin/覆盖范围与允许/拒绝 origin 的 HTTP 回归。
- 浏览器在保留的 5174/8788 定向回归 **4/4**，确认测试 CLI 可以覆盖日常端口。结果见 [验证摘要](../../verification/entry-port-20261016.json)。原先 90/90、兼容专项和三十分钟仍对应其冻结源码，未因仅修改入口而重跑或改写旧结果。

真实截图、日志在本机 `evidence/entry-port-20261016/`，仅含独立 TEST context，不是用户原有画布。

## 存储边界

浏览器存储按 origin 隔离。5175 不会自动显示旧 5173 的 Vivic 画布；旧数据未删除，也没有自动读取或迁移。若需要旧数据，单独安排迁移，不能通过清除浏览器数据来解决入口问题。同样应保持 Control/Display 的主机名和端口一致。
