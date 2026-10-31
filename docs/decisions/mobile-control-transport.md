# MOB-01：独立远控协议 v1

状态：2026-10-22 经用户授权，在维护者集成分支完成正式 owner 接线与本人服务器部署；PR #14 原 Draft 未自动合并。Refs #12。最新流程与验收见 [本轮更新](../updates/2026-10-22-local-runtime-mobile.md)。

## 决策

首版手机与电脑均主动连接可信中继 `/relay`。生产采用 HTTPS/WSS；即使同局域网，也依赖互联网、中继和在线电脑 owner。预留 `Transport` 接口，未实现局域网直连、WebRTC、自动切换、云画布、多账号同步或计费。

生产文件以 `contrib/mobile-console/protocol.ts` 的运行时 Zod Schema 为准，不扩展 `packages/contracts` 或现有 BroadcastChannel 协议。中继使用独立 `ws`，关闭压缩，JSON 帧最大 32 KiB。操作文本最多 4000 字符；手机 UI 更保守地限制 2000 字符。未知字段拒绝。协议不是任意 URL/API/脚本转发器。

收发两端均执行 UTF-8 字节上限，待发缓冲上限为 128 KiB；慢连接超过上限时关闭，未成功转交的命令不返回 accepted。所有入站消息（含非法 JSON/Schema）计入每连接 100 条/10 秒限流。快照只提供有界摘要，按字节预算截断卡片和画布列表并优先保留当前画布，不保证列出整个用户库。

## 身份和配对

1. 运维单独配置 32–256 字符 relay admission secret；它不是 StepFun/GPT Key 或本地 API bearer。正式入口将它留在电脑后端私有配置与服务器环境中，由受本地鉴权保护的 broker 建立临时电脑会话；前端仅获得本次会话 token。独立 DEMO 仍保留手动输入方式。
2. 电脑发送 `hello(computer, deviceId, accessKey)`，中继返回独立 256 bit 会话 token、sessionId、epoch 和 120 秒一次性配对码。配对码 64 bit 随机，最多每 IP 每分钟 20 次认证尝试；不是可复用设备密码。
3. 手机输入同一中继地址与配对码，以 `hello(mobile, deviceId, pairCode)` 换取独立 token。电脑必须在线且 owner 可用才能兑换；成功后码立即消费。生成新码废止旧码。
4. 会话控制凭据只在 JS closure / 服务端哈希内存中，不放 URL、localStorage、sessionStorage、IndexedDB、画布、日志或仓库。用户授权的二维码仅将 120 秒一次性配对码放进 fragment，打开即清除，不放查询参数；admission secret 和会话 token 禁止进入二维码。手机完整刷新需新码重新配对。
5. 同一文档网络恢复用内存 token 重连；默认会话 8 小时。中继重启或会话过期/撤销后重新配对。默认上限 100 个会话、每会话 4 个手机、全服务 256 条连接。
6. 手机可撤销自己；电脑可撤销单设备或整个会话。电脑端立即移除本地权限并中止未提交请求，再通知中继。离线退出无法证明中继收到撤销，但本地不再执行。停止/过期后的 connector 不可复用，启用时新建实例/设备身份。

## 请求和结果

| 消息 | 责任 |
| --- | --- |
| `command` | 携带 session/device/epoch、requestId、ownerEpoch、canvasId、expectedVersion 和 operation |
| `accepted` | 中继确认已转交；不等于电脑执行 |
| `executing` | 电脑已经开始受控处理；不等于成功 |
| `result` | 电脑的 succeeded/rejected/cancelled/unknown 实际结果；绑定原始会话和目标设备 |
| `snapshot` | 电脑必要状态、画布版本和递增 sequence；手机拒收旧 sequence |
| `query` | 查询原 requestId 的结果，只读且不得重放写操作 |
| `cancel` | 请求中止尚未提交的部分；已经提交的动作不能撤回 |
| `heartbeat` / `pong` | 应用层存活检测；另有 WS ping/pong 清理断线 |

操作白名单是 `text.submit`、`canvas.switch`、`card.pin`。手机不创建/删除画布，不直接持有 Action 执行权。电脑按当前会话权限、owner 身份、当前活动画布和版本检查后调用注入接口；输入到达中继并不授予电脑写权限。

电脑串行处理写操作，去重键包含 session、epoch、device、requestId；同 ID 不同内容拒绝，同 ID 同内容仅回既有结果。每个 connector 最多保留 512 条记录，不通过淘汰旧记录使重复写再次生效；额度满后需结束旧会话并创建新 connector。账本不落盘：电脑 owner/页面或进程重启后不自动重试不确定写操作，新配对与旧 epoch 隔离。

文字执行器必须在**每次实际 dispatch 前**检查 AbortSignal 和 `isCurrent()`，在真实执行后返回结果。正式入口使用独立执行器，不能把 ControlApp 的 void `submitCommand` 简单包成 `{ok:true}`。文字、固定、切换均等待 owner 的 `flush(canvasId, version)` 保存确认，提交后失败/控制权不确定则抛给 connector 返回 unknown。

发送失败、超时、断线或中继错误不能证明此前未执行，手机保持 `unknown`，阻止继续写入并查询结果。只有电脑结果能结束这一不确定状态；没有记录时继续提示未知，需用户核对电脑，或结束会话后重新配对。迟到 ACK/执行通知不能覆盖已确认终态。撤销和会话更换后的迟到响应不能获得新会话权限。

请求期限从提交开始计时，重复进度不延长期限。`unknown` 只能由电脑 result 确认，迟到 accepted/executing 不会让它回到处理中。重连收到 welcome 仅代表会话有效，收到新的电脑快照前仍禁止写入；主动断开和撤销使旧 transport 回调失效。

## 状态、加密与运维

手机状态包含未配对、连接中、已连接、断线、重连、过期、撤销和错误；执行中/超时属于单独请求状态。已配对但电脑 owner 不可用时禁止控制。电脑关机、休眠、控制页关闭不能显示控制成功。

Origin 必须精确匹配配置，所有模式只监听 loopback。生产默认要求 HTTPS Origin；安装版桌面的 HTTP loopback Origin 仅在显式 `VIVIC_RELAY_ALLOW_LOOPBACK_ORIGINS=1` 且该精确 Origin 已列入白名单时例外。公网传输仍须可信 TLS 代理提供 `X-Forwarded-Proto: https`。仅配置的准确代理 IP 可用覆盖的单 IP `X-Forwarded-For` 决定限流身份；缺失、非法、链式地址或非可信代理拒绝升级。中继可读取必要摘要、文字与结果，**不是端到端加密**。不记录正文、配对码、凭据或画布。独立服务器部署、真实 HTTPS/WSS 浏览器闭环和回退见 [本轮验收](../verification/local-runtime-mobile-20261022.md)，未购买新资源。
