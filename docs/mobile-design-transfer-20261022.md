# 手机控制端设计迁移与 Android 包

来源固定为 `ECdison6227/rea-ui-library@d7f718d1`。读取位置为 `platforms/mobile/hark-android`、其 `WEB_TO_MOBILE.md` 指向的 `platforms/web/hark`，以及保留 legacy 身份的 `platforms/mobile/mirasim`。本轮只实施 Vivic，不修改研究库，不启动或冒称重新运行 Hark 原 App。

Hark Android 包内颜色、排版和局部控件几何仍是 B 静态证据，原生核心页因 Play 授权/地区门未取得运行 A；Web 的 390px 历史观察有自己的来源；下面的 Vivic 组合、扫码与原生包装均为目标 D 实现。Mirasim 0.0.497 的原 APK 前端静态/离线预览仍保持 legacy 研究身份，不升级为本轮真机原版证据。

| 来源规则/资源 | Vivic 落点 | 采用方式与差异 | 验证 |
| --- | --- | --- | --- |
| Hark Android `tokens/tokens.json` 主文字、半透明 surface、stroke | `mobile.css` 的 `--mc-*` | B 色值直接映射；辅助文字为可读性调至 68% 属 D，未声称原版所有页面绑定 | 主题、错误、断连截图 |
| Hark Android 32/38、20/24、15/18 的角色 | 配对标题、设备标题、正文 | 保留角色与常规字重；中文/浏览器用更舒适行距 D，CSSpx 不声明等同设备 dp/sp | 窄屏、较大字、Android textZoom |
| Hark Web `reference/web-mobile.css` 浮动 composer、24px 容器、32px visible send | `mobile-composer` / `mobile-send-button` | 薄 CSS 迁移；48px 独立触区取 Android compact B 起点，消息填充与输入模糊分别处理 | 发送状态、键盘可视高度 |
| Hark Web 与 Android 独立参考的单决策 sheet | `PairingScanner` 和扫码确认 | D 目标组合，220ms 展开、焦点返回、Escape/原生返回/减少动画 | 扫码权限拒绝、返回测试 |
| Mirasim legacy 分组列表、扫码/连接码入口、设置返回 | 配对首页、地址折叠、文字大小、设置返回 | UI 层级复用；不引入 Mirasim 账号/空间持久化协议，Vivic 授权继续只在内存 | 完整配对、断连、重新连接 |
| 已有 Vivic `AtmosphereBackground`、Geist、Lucide、Button/Input | 手机全页 | 直接复用现成组件；Hark 商用字体无再分发许可，保持 Geist+系统 CJK，记录字形/换行差异 | 页面已绑定 Geist woff2 与图标；旧 WebView124 的按钮布局补专属 CSS |
| ZXing core 3.5.3 | Android `ScanActivity` | Apache-2.0 现成解码库；本地预览帧解码，无上传/存储 | 同解码管线合成帧四向×反色；独立模拟相机验收 |

## 功能与文案调整

- 过时“电脑正式接线待核定”提示替换为正常产品引导，仍保留真实 owner、保存与中继信息。
- 首选扫码，手动一次性码/粘贴链接为同页回退。正式页折叠连接地址，HTTP 本地开发页展开，设置里仍可修改中继。
- 扫码/粘贴 URL 先检验协议、源和路径，仅接受一个 16 位十六进制 `pair` fragment；拒绝外域、URL 凭据、query 和重复/未知 fragment 字段。不会导航至扫描地址。确认后才消费配对码。
- 手动断开不会因切回前台而自行重连；用户点击重连恢复。意外断网继续走已有内存 token 重连协议，未知写入先查询，不自动重发。
- 相机拒绝/缺失/解码取消都有手动入口，浏览器不支持 BarcodeDetector 时明确解释。相机只由用户主动操作开启，浏览器隐藏/关闭和 Android pause/back 释放采集。
- 设置补较大文字；系统返回逐层关闭扫码、配对确认、撤销确认、设置。Android 根页返回放到后台，杀进程后按现有安全语义重新配对。

## 交付与边界

`apps/android/README.md` 和 `build.ps1` 提供可重复的 APK 构建、固定依赖校验和安装。包是原生扫码加 WebView 混合，页面资源随版本封装；更新需重新安装，没有远程热更新。正式 APK 关闭调试，以本机开发密钥签名；商店发布签名不在本轮范围。

APK 虚拟只读来源为 `https://appassets.androidplatform.net`，桥接只有 `scan()`；网络页面导航、iframe、文件/content 访问关闭。CSP 和真实中继 WSS 校验同时生效。中继服务器需由维护者显式允许该来源，本轮手机 Agent 不部署或修改服务器。Web 浏览器入口继续是 `https://edsionc.top/vivic-remote/`。

控制请求仍由既有 `createMobileClient` 与桌面 owner 执行。单测/DEMO 浏览器 adapter 只用于隔离验证，不等同真实模型/用户画布成功。真实 owner+公网闭环由主线程统一集成验收。原生光学扫码仍需实体手机、实际光线/对焦的最后检查；合成帧与模拟相机不能冒充实体手机测量。
