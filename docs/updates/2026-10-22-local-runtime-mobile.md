# Windows 本地运行与手机控制

本轮在维护者集成分支 `feat/local-runtime-mobile-bridge` 完成，包含平台分支以及 #13/#14 的本地修复；未合并主分支，未重试此前被拒绝的产品仓库推送。#18 的状态反馈和测试已审阅并择取，保留维护者已有的失败冷却。

## 体验

1. 解压 Windows 包，双击 `Start-Vivic.cmd`，打开 `http://127.0.0.1:18787`。可选运行 `Install-Vivic.cmd`，复制到当前用户 LocalAppData 并创建启动/停止快捷方式，无需 Node、pnpm 或管理员安装。
2. 进入设置 → 本地快速决策，点击「准备模型」，完成后「启用本地决策」。首次约 530 MB；Windows x64 固定 Qwen2.5 0.5B Q4_K_M 与 llama.cpp 引擎均校验 SHA-256。支持准备进度、取消、预热、停用和清理模型文件。固定引擎采用 CPU 推理，未声称已测 GPU 显存。
3. 设置 → 手机控制 →「开启手机控制」。用安卓手机相机扫描二维码，进入 [手机控制台](https://edsionc.top/vivic-remote/)。也可手动输入电脑显示的一次性配对码。
4. 在手机输入「创建便笺：手机发来的内容」，查看电脑与 Display 同步；试用卡片固定、切换目标画布、电脑撤销手机授权或停止连接。
5. 双击 `Stop-Vivic.cmd` 停止此包的 API 和所属模型进程。清理缓存仅影响本地模型文件。画布保存于当前浏览器的此地址；旧开发地址的画布可先导出，再在新地址导入。

手机当前是浏览器控制台，尚未交付 Vivic Android APK。Hark Android 设计提取由独立 library 任务负责，未把 Hark 字体、代码或账号资料放入 Vivic。

## 行为和边界

- `/mobile` 独立加载手机 client，不启动第二个 owner，不打开手机 IndexedDB；独立静态包只含手机 UI。
- 正式电脑连接复用已有 owner、Action 校验、存储和 Display 同步。文字最多一次最终提交，每次提交前检查取消、会话、owner、画布、版本与电脑本地请求优先权；不复用 void 提交函数假报成功。
- 文字、固定和切换在实际提交及本地保存确认后报告成功。提交后保存/控制权不确定时返回 unknown；取消不撤回已提交动作，不自动重复执行。歧义目标需下一条文字写明卡片名称，当前不共享手机间的对话续接。
- QR 仅包含 120 秒、一次性的配对码 fragment；打开即清除地址 fragment。长期 admission secret 留在本机后端私有配置，会话 token 只在闭包内存中；不放浏览器存储、URL 查询、日志或仓库。
- 中继运行在现有 HTTPS 站点的独立 `/vivic-remote/` 路径，WS 上游仅监听 loopback 8793，单独 systemd 服务。保留精确 Origin、可信代理、TLS 转发头、帧/缓冲限制和撤销。显式允许已配置的桌面 loopback HTTP Origin，手机与中继的公网传输仍使用 WSS。
- 中继可以读取必要摘要、控制文本和执行结果；不是端到端加密，也不是云画布。电脑关机、休眠、控制页关闭时不可控制；手机完整刷新需重新配对。

## 本地决策质量

评分来自固定 llama.cpp 返回的真实 token 概率。A–G 使用相同 logit bias，将评分限定在七个标签，不改变标签之间的相对 logits；不使用模型自己声称的置信度。仍按既有 0.8 阈值、0.25 间隔和语义/危险指令/目标检查。

21 条真实中文开发烟测中，15 条视图/聚焦/便笺指令仅 3 条被接纳，其余回退；6 条危险、复合或其他指令全部回退。接纳的 3 条均与样例预期一致，样本不足以证明普遍准确率。预热后该组实际请求约 88–185 ms；冷启动和首次预热另计。当前 0.5B 模型覆盖有限，保留本地精确规则和原有 LLM 路径，不因此放低门限。没有训练新权重。

## 维护与打包

`pnpm package:windows` 生成普通文件组成的 ZIP，包含固定 Node 24.21.0、生产依赖、Web 构建及启动/停止/安装入口。Node 官方 ZIP 的 SHA-256 固定，启动时再次检查 node.exe；模型按用户操作另行准备，不包含账号凭据。运行过的目录可能有本地 token，禁止直接重新分发；打包命令始终从源文件白名单重新生成。

`pnpm package:relay` 生成独立中继与手机静态包，不包含 admission secret。部署样例位于 `contrib/mobile-console/deploy/`。本机配置为用户目录 `.vivic/mobile-relay.json`，字段是 `relayUrl`、`mobileUrl`、`admissionSecret`、`origin`，仅受控后端读取。当前电脑已完成私有配置，不需要把内容粘贴到手机或聊天。

服务器回退：停用 `vivic-mobile-relay.service`，从现有 TLS server 移除 `vivic-mobile.conf` include，先 `nginx -t` 再 reload。部署前配置备份单独保留；其他站点与既有应用未改动。替换版本应新建 release 目录并切换 current，保留原 release 与私有环境文件。

实际验收与未测项见 [验收记录](../verification/local-runtime-mobile-20261022.md)。
