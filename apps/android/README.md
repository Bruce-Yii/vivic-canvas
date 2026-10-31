# Vivic Android 手机控制

这是 **原生扫码 + 随 APK 打包的 Web 控制界面**，不是纯原生重写。包名 `app.vivic.remote`，Android 8.0/API26 起可安装，target API35。电脑 owner、指令确认、版本检查、保存与中继均沿用现有正式链路。手机无模型 API key、画布数据库或自动写入功能。

从仓库根目录运行 `powershell -ExecutionPolicy Bypass -File apps/android/build.ps1`。构建使用本机 SDK35 的 aapt/d8/apksigner 和 JDK，先重建手机界面，再将这一版静态资源封装进 APK。输出 `.cache/android-build/artifacts/Vivic-Remote-0.1.9.apk` 与 SHA256/资源清单回执。默认 SDK/JDK 为本机 `.rea/toolchains/android/`，可通过参数指定。`-DebugWebView` 只用于独立测试包，交付默认包关闭调试。

开发签名密钥仅存 `.cache/android-build`，不入 Git；当前 APK 是演示/测试安装版，不是商店发布签名。同一台机器后续构建可覆盖更新；换签名需先卸载。更新 Web 界面后须重新构建并安装 APK，当前没有远程热更新机制。

电脑连接面板可提供“下载安卓 App”。运行 `node scripts/stage-android-download.mjs` 将本版本生产 APK 和精简下载清单放入被 Git 忽略的 `apps/web/public/downloads/`；Windows、macOS 和线上打包会先执行这一步。脚本核对版本、SHA256、非调试回执和包内内容，缺失/调试/测试 CA 包会明确失败。可用 `VIVIC_ANDROID_APK` 指定 APK 路径，旁边必须有构建生成的 `.apk.json`。电脑端未携带安装包时不会显示无效下载按钮。下载包不包含配对凭据；安装后仍需扫描电脑的一次性二维码。

手动 macOS CI 会先在独立 Windows runner 构建同一源码的 Android 包，再作为 workflow artifact 交给两个 Mac 架构；无需 Mac 安装 Android SDK。CI 开发签名随 runner 重建，不能覆盖以另一签名安装的手机 App，也不是商店签名/发布。正式可持续升级仍需单独管理发布签名。

隔离原生 HTTPS 验收可使用 `-DebugWebView -DebugCaCertificate <测试CA公开证书.pem>`。构建只在临时 run 目录生成带精确 CA 的 debug-overrides 与 debuggable manifest，输出 `-debug.apk`；缺少 `-DebugWebView` 时拒绝添加测试 CA。默认生产包不包含测试 CA、networkSecurityConfig 或 debuggable 标记；不要分发 debug 包，不在用户日用手机安装测试包/测试信任。可选 `tests/online/online-native.spec.ts` 以 `VIVIC_ANDROID_ONLINE=1` 运行，需专用 `vivic_online_20261023` AVD、本机测试证书及线上构建；它只用手动配对，不调用相机/麦克风。

安装：`adb -s <独立设备> install -r .cache/android-build/artifacts/Vivic-Remote-0.1.9.apk`。手机中点击“扫描电脑二维码”，允许相机，识别后确认连接；拒绝相机、没有相机或取消时可以手动输入电脑设置中的一次性配对码/粘贴配对链接。相机只在主动扫码期间采集，帧只在本地交给 ZXing 解码，退出立即释放，不申请麦克风。

旧本机模式仍使用 `https://edsionc.top/vivic-remote/` / `wss://edsionc.top/vivic-remote/relay`，旧中继 allowlist 需允许 **`https://appassets.androidplatform.net`**。新线上模式读取电脑提供的 `https://<线上域名>/remote/#pair=<一次性码>&online=1`，先显示准确主机要求确认，随后仅请求该主机 `/api/online/mobile/phone/{connect,poll,send,disconnect}` 的 HTTPS JSON 接口。不打开二维码网页，不接受任意 relay 覆盖参数，不发送 owner cookie/API Key。线上服务器只在此四个手机路径为 appassets origin 开启无凭据 CORS；模型和 owner API 仍同源。

APK 内页面在只读虚拟 HTTPS origin 加载，不请求该域互联网。桥接只暴露 `scan()`，网络导航全部阻止，文件/content 访问关闭，iframe 禁止，回调 JSON 转义。WebView 拦截仅放行这四个线上手机接口的 POST/OPTIONS；UI 资源仍只能从包内读取。线上域名未确定时不用改包，扫电脑生成的实际 HTTPS 配对链接即可；仅手输短码仍使用原默认中继，线上模式需扫描/粘贴完整链接。

WebView 原生权限请求一律拒绝，扫码由单独的非 exported Activity 负责。系统返回先关闭扫码/配对确认/设置，主界面返回将应用放到后台；内存授权在进程存活时保留。杀进程或刷新页面后重新配对是协议现有设计。系统字体缩放绑定 WebView `textZoom`，页面另提供较大文字；原生窗口处理系统栏，Web 页面处理可视区域/键盘与安全区。

扫码依赖固定 `com.google.zxing:core:3.5.3`，Maven Central JAR SHA256 `8d8064c1636fdaef7189dd9055c7d59950a8940a12f2293956446ec3c109fd82`，构建时校验。上游 SHA1 `ca1349214a356cd7958651b2d5a0e1f3811a9c4b` 已核对。原文许可/NOTICE 保留在 `licenses/` 并随 APK 附带，来源 <https://github.com/zxing/zxing/tree/zxing-3.5.3>。未打包 Hark/Mirasim 原 APK 或账号资料；本次所选 Hark 字体、SVG 几何与连续圆角的来源和权利说明见 `licenses/HARK-SOURCE-NOTICE.txt` 与主项目 `components/hark/SOURCE.json`。

实际公网 owner/Display/刷新持久化与撤销授权结果，以及模拟器 IME 未完成的具体条件，见 [手机验收记录](../../docs/mobile-verification-20261022.md)。测试脚本只面向独立 `emulator-5610`，不应对用户日用手机运行权限重置或测试配对。

本轮完整原生验收入口为 `VIVIC_ANDROID_FULL=1 pnpm --filter @vivic/web exec playwright test --config playwright.android-full.config.ts`。它使用独立 `vivic_online_20261023` AVD、18995/19445 端口、`dist-online-android-full` 构建、仅 debug 包信任的测试 CA 和模拟器图片摄像头；不读取物理相机/麦克风。初始便笺/待办/目标/计时是明确标记的 TEST 响应 fixture；手机后续文字建卡使用实际 owner/API/保存链路。该配置需要本机既有 AVD/证书，不是从空白电脑开箱即跑的 Android SDK 安装脚本。

当前 0.1.9 / code 10 保留线上隔离会话接入，继续保持两页遥控：聊天向右滑进入纵向 Vivic Space，向左滑返回；设置仅手机明暗、字号与连接。电脑同步可见内容，当前图片只文案、已知普通计时摘要会在手机本地刷新余时。本轮来源与验收边界见 [线上手机更新](../../docs/updates/2026-10-23-online-mobile.md)；旧公网/原生验证见 [此前更新](../../docs/updates/2026-10-23-mobile-remote.md)。
