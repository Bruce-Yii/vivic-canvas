# 手机控制端与 APK 验收（2026-10-22）

实现与来源映射见 [设计迁移记录](mobile-design-transfer-20261022.md)，构建/安装见 [Android 说明](../apps/android/README.md)。原 Hark Android 仍是静态 B 与独立迁移 D 的来源，以下测试只验证 Vivic。

## 已通过

| 范围 | 实际结果 |
| --- | --- |
| 手机控制协议 | `@vivic/mobile-console-prototype` 54 项通过 |
| 手机界面与 QR 安全 | `MobileConsole.test.tsx` 8 项、`pairing.test.ts` 13 项通过 |
| 类型检查 | `tsc --noEmit -p tsconfig.app.json --incremental false` 通过 |
| 浏览器闭环 | 独立端口 5184、6 场景通过：真实 WS 中继 + DEMO 电脑 adapter 的配对/文字/固定/切画布/取消/撤销/刷新，外域二维码拒绝，链接确认，相机拒绝回退，320px/大字/主题/返回 |
| QR 解码 | ZXing 同一 YUV 亮度解码管线，4 方向 × 普通/反色 8 种合成帧通过；不冒称真实光学扫码 |
| Android 原生行为 | 独立无账号 AVD `emulator-5610`，7 项通过：本地 UI/可信桥接/48px 触区；原生相机拒绝回退；纯模拟相机预览；返回取消并释放相机；设置返回；外部主框架导航拒绝；DOM storage 禁用 |
| 字体 | Android 系统 fontScale 1.3 下页面无横向溢出，截图保留；Web 标准/较大字与窄屏验收通过 |
| APK | SDK35/JDK21 编译，签名 v2/v3 验证通过；正式构建 `debugging=false`，原生扫码 + 随包 Web 控制混合 |

浏览器截图位于本机忽略目录 `evidence/mobile-console/`；原生结果及截图位于 `.cache/android-build/native-verification/`。自动化静音，不采集物理麦克风；摄像头测试使用模拟器合成画面，不采集物理相机。

## 真实公网、owner 与持久化

主线程更新手机静态页面，并在真实 WSS 中继来源白名单加入 `https://appassets.androidplatform.net`。Android APK 从此只读虚拟来源连接 `wss://edsionc.top/vivic-remote/relay`，使用一次性码授权；桌面在独立浏览器 context 打开真实 owner 和 Display。

2026-10-22 10:51 UTC 的留证结果：

- 手机返回 **“3分倒计时已就位”**，显示 **“版本 1 由电脑保存”**，当前画布 1 张卡片。
- 桌面 Display 实际出现 1 张倒计时卡，手机回执经桌面 owner 实际执行返回。
- 撤销手机授权后，手机回到配对状态；桌面两页刷新后卡片仍在，持久化成立。
- Android DOM storage 不可用；配对凭据只在内存中，没有写入浏览器存储。

本机证据：`public-live-result.json`、`desktop-live-result.json`、`public-live-connected.png`；首轮结果另存 `public-run-1/`。一次性码未打印或截入证据。首次 root 验收脚本误要求业务回执必须包含“保存/执行”字样，随后改为实际业务结果 + 保存 caption + 卡片数量，并完成复测；这是测试文本匹配修正，不是产品伪造回执。

## 安装包

`.cache/android-build/artifacts/Vivic-Remote-0.1.0.apk`，476,712 bytes。

SHA256：`2578913fb20308bed76275bf498f88718350f2402ffc12669b6eb6054b065968`。

构建回执是同目录 `.apk.json`；测试用 debug APK 与正式包使用同一页面资源及业务代码，唯一调试开关默认关闭。手机不包含桌面模型 key，不创建第二个 owner。扫码库和许可证随包，商业原字体/Hark/Mirasim 原件未打包。

## 模拟器图形管线限制

在 Android 15 x86_64 / WebView 124 / `swiftshader_indirect` 环境执行系统字号切换与 IME/Back 补测时，发生一次输入分发 ANR。实际 main 栈在 `HardwareRenderer.nSyncAndDrawFrame` / `DrawFrameTask::drawFrame` 等待；RenderThread 在 `qemu_pipe_read` → `QemuPipeStream::commitBufferAndReadFully` → `glBufferDataSyncAEMU_enc` / Trichrome / libhwui。该栈没有 Camera.open、stopPreview 或应用 Java 同步操作；当时内存压力均值为 0，不能将其直接解释为内存不足。

完整 ANR 与模拟器日志只保留在本机忽略目录，没有入 Git。该问题属于本次可确认的模拟器 GL 通道阻塞条件；还不能推广为所有真实设备表现。原生相机权限、返回释放和公网业务闭环的独立通过结果保留。实体 Android 的光线/对焦扫码、厂家输入法与长时间后台恢复仍需设备验收。

按实际栈将独立 AVD 重启为模拟器接受的 `-gpu software` 后，只做一次定向 IME 复核；`uiautomator dump` 在已输出生成 XML 后仍超过 30 秒未退出，脚本以 `ETIMEDOUT` 结束。没有再改变已验证的应用渲染架构或重复多轮模糊压力。曾实际记录到 Gboard `onShown` / `mInputShown=true`，但原生 IME 收缩与输入框可见性的整条自动化验收 **未完成**；浏览器受控可视区高度测试通过不替代该结论。保留 `verify-native-layout.mjs` 作为恢复复核入口。
