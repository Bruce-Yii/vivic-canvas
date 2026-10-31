# 手机连接线上隔离会话

线上用户在电脑完成连接后，在连接设置的「手机连接」展开项生成二维码。手机无需本地启动器；浏览器直接打开同源 `/remote/`，安卓 0.1.5 / code 6 扫描或粘贴完整配对链接，再确认服务主机。电脑控制页需要保持打开，手机仍只显示聊天和单列 Vivic Space，不成为新的画布 owner。

## 传输与授权

新增 `/api/online/mobile/{owner,phone}/{connect,poll,send,disconnect}`，全部 POST JSON，poll 最长 20 秒，无 WebSocket/共享中继准入密码。32 KiB 严格 Frame、128 KiB 每设备待发缓冲、4 部手机上限、全局请求/并发预算和 120 次/分钟匿名手机连接预算；新快照可替换尚未送出的旧快照，执行结果和命令不被快照替代。

- owner 每次请求必须携带现有隔离会话 HttpOnly cookie，并通过同源校验；另一浏览器会话即使得到 connectionId 也不能控制它。线上手机 API 不接入本机 `/api/mobile/session` 或全局模型 Key。
- 电脑创建 64 位随机、2 分钟单次码，只有电脑实际报告 ready 才允许兑换；配对前不投影任何卡片。电脑连接仍存活时，同 cookie 其他 tab 不能夺取；旧连接离线/30 秒失联后可重建并撤销旧手机。
- 手机 connectionId 和重连 token 仅在 JS 闭包；不放 URL、localStorage、sessionStorage、画布、日志。URL fragment 只有短时单次码，读后立即从当前页面历史移除。刷新手机页面需重新配对。
- 手机请求不创建、不刷新 owner 会话或其 cookie。owner idle/absolute TTL、显式结束会话和服务退出会销毁所有 bridge 连接并唤醒长轮询。
- 读取请求 body 后和 poll 返回后重新检查 TTL；跨 await 过期的 owner 不会再收到/发出旧帧。合法电脑请求在有界 body 读取并确认 cookie 尚有效后算 owner 活动，可更新 idle touched；手机流量完全不更新，absolute created 截止永不延期。终止时同步清除 bridge，已排队帧也不能跨截止返回。
- 撤权先在电脑 connector 本地阻断执行；后端删除手机重连身份，撤权帧仅允许读取一次，随后 connection 立即失效。未读取的撤权帧最多保留固定 30 秒，不能通过恶意 polling 延期；销毁 owner 时一并清除。
- 同设备同时第二个 poll 返回 409；替换连接使旧 poll 的 connectionId 失效。断线的写入结果显示未知并查询，绝不自动重发。

Android appassets origin 仅在 phone 四个路径允许精确 CORS，未允许 credentials；模型、凭据、owner API 仍禁止跨源。线上二维码只允许 HTTPS `/remote/` + `pair` / `online=1`，原生用户确认准确主机后才接触该服务。任意 relay 参数、查询字符串、userinfo、明文远程 HTTP 和外部主页面导航均被拒绝。APK 本身不加载远端代码。

## 执行与持久化

继续复用 `createComputerConnector`、`createMobileClient`、严格共享 schema、`createVivicHostAdapter` 白名单正文投影和 `executeRemoteText`。手机提交后仍经电脑 owner/epoch/活动画布/version 检查，唯一 commit 前再次核对 lease，然后等待 `host.flush` 才回报成功。普通内置便笺可不调用模型；模型文字规划沿电脑的隔离 cookie 会话，不把模型凭据转交手机。

不新增云画布数据库、账号同步、手机模型设置、动态媒体、任意远程脚本或扩展执行。手机图片仍只文案，计时为快照时点；电脑 owner 关闭时不能继续后台执行。

## Hark 规范映射

来源固定 `ECdison6227/rea-ui-library@26ac2724/platforms/web/hark`，原研究为 partial；本轮应用已有包，不重跑原产品。手机完整沿用现有 Hark 字体、原 SVG glyph、天空背景、连续圆角、透明 fill/stroke、双 Tab、composer 与设置 sheet。新增线上主机确认复用原 `HarkSurface` / security glyph；电脑二维码入口复用当前小设置面板的短行和 Button，不另加大屏管理台。跨平台网络适配、`/remote/` 路由与两页远控内容为 D 目标选择，不声称 Hark 原版协议/页面。

## 构建与验证

- 新后端 handler/bridge 测试 13 项（包括 slow body / pending phone poll 跨 idle 截止、owner 活动续 idle 但不能续 absolute、pending owner poll 跨 absolute 截止）；同真实 handler + 原 connector/client + HTTP transport 的无浏览器协议闭环 4 项通过：提交一次、结果确认、正文投影、重连、撤权、owner 停止与 cookie 缺失的明确终止。它们使用测试宿主，不冒充真实画布持久化或模型推理。加原 session 22 项，最后定向 API 共 39 项。
- 线上既有隔离会话 22 项、旧手机协议/WS中继/connector/client/投影 90 项通过；手机 UI、pairing、真实 owner adapter/执行 helper 41 项通过。
- Web、API、手机 workspace 类型检查通过；手机 production build 和 APK 0.1.5/code6 构建通过，v2/v3 开发签名验证通过；WebView 调试关闭。构建仍有既有大 chunk、Java 旧 target/废弃 API 提示。
- 新生产浏览器两项通过：真实 cookie owner + 独立 phone context，经一次性码、手机内置便笺、白名单正文、固定、真实 Display、`flush`、重载恢复和撤权；隐藏设置不停止 connector。手机无 owner cookie/session bootstrap/IndexedDB；重用码、跨 cookie 接管与 owner 会话删除均实际验收。无 provider mock 或真实模型调用。
- 原生 opt-in 一项通过：新建专用 `vivic_online_20261023` AVD（no audio/cameras），调试包只信任本次精确测试 CA，经 `adb reverse` 接本机 TLS18445/真实线上 API18795。Android 未跳过 TLS 检验；仅测试电脑 Playwright context 对本机自签证书使用 `ignoreHTTPSErrors`。实际 appassets → phone-only CORS → 电脑 owner、便笺/正文/固定/Display/保存后刷新/撤权及禁用 DOM storage 通过。采用粘贴完整链接和主机确认，**未声明真机光学扫码**。测试CA不加入系统或交付生产包；默认包实查无测试CA/networkSecurityConfig/debuggable标记。临时代理/API/AVD已关闭。
- 浏览器和原生证据分别在 `.cache/online-mobile-20261023/browser-release/` 与 `native-final2/`；旧失败目录保留。截图已逐张人工查看，浏览器最后补等 Hark tab 过渡结束再截图。服务器 Linux/TLS/反代验收另由服务器子任务记录，不与本机原生 TLS 测试混淆。

APK：`.cache/android-build/artifacts/Vivic-Remote-0.1.5.apk`，SHA256 `8d666b6c6373391db7e86faed51c57ec77fe9e132b6265150c34c422eeeafda0`，配套 `.apk.json` 记录依赖及全部内嵌资源散列（debugging=false/testCa=false）。最后补强 owner cookie 失效/另一个 owner tab 的终止提示后重打生产包，成功执行链路未改；终止场景由新增协议测试覆盖。未运行物理摄像头/麦克风、未播放音频、未动用户原18787服务；18794仅 Playwright 启动独立生产构建演练，退出后自动关闭。未发布、未推送。
