# Windows / macOS 本地启动器

本轮补齐 macOS Apple Silicon（arm64）和 Intel（x64）的本机打包、安装、启动、停止流程。Windows x64 继续使用现有 `package:windows` 和 PowerShell/CMD 入口。本轮没有改动正在运行的安装目录、API 或模型服务，也没有推送 GitHub。

## 给使用者

- Windows x64：使用原有 Windows ZIP，运行 `Install-Vivic.cmd`；启动 `Start-Vivic.cmd`，停止 `Stop-Vivic.cmd`。
- macOS 13.5 及以上：按电脑架构选择 Mac ZIP，解压后打开 `Install-Vivic.command`。安装器在当前用户的 `~/Applications` 创建新的 `Vivic <时间>.app`，保留已有安装。打开这个 App 后，在默认浏览器进入本地 `/launcher`。
- Mac 也能直接运行解压目录的 `Start-Vivic.command`。浏览器关闭后后台服务继续运行；停止用同目录的 `Stop-Vivic.command`。安装后的命令位于 App 的 `Contents/Resources/package`。
- 首次模型及连接配置仍在电脑上；安装包不含模型权重或个人 API 凭据。手机继续扫码遥控。

预览 Mac 包没有 Apple Developer 签名或公证；被 macOS 拦截时，应先核对包来源与 SHA256，再通过系统“隐私与安全性”的正常许可流程打开。脚本不删除 quarantine，不修改 Gatekeeper。双击命令可能短暂显示终端；当前交付形式是 ZIP 内的安装入口和本机生成的 App，还不是签名的 DMG/PKG。

## 在 Mac 构建

必须在目标架构的 Mac 上，用相同架构的 Node 24.21.0 安装锁定依赖。不要复制 Windows 的 `node_modules`，不要关闭 optional dependencies。Mac 最低版本随固定 Node 24 为 13.5，见 [Node 官方平台表](https://github.com/nodejs/node/blob/v24.21.0/BUILDING.md#platform-list)。原生依赖的安装平台要求见 [sharp 官方安装说明](https://sharp.pixelplumbing.com/install/)。

```sh
pnpm install --frozen-lockfile
pnpm exec node scripts/package-macos.mjs
# 或指定一个尚不存在的输出目录
pnpm exec node scripts/package-macos.mjs --output .cache/vivic-macos-arm64
node scripts/package-macos-smoke.mjs .cache/vivic-macos-arm64
```

根 `package.json` 可增加 `"package:macos": "node scripts/package-macos.mjs"` 以提供 `pnpm package:macos` 的短入口。脚本在 Windows/Linux 立即拒绝构建 Mac 包；不生成伪装成 Mac 验证结果的成品。

构建流程沿用现有 Web/mobile 构建与 local-api 生产部署，下载固定官方 Node tar.gz 并核对以下 SHA256。哈希于 2026-10-23 从 [官方 SHASUMS256.txt](https://nodejs.org/dist/v24.21.0/SHASUMS256.txt) 核实：

| 平台 | Node 24.21.0 tar.gz SHA256 |
| --- | --- |
| darwin-arm64 | `bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057` |
| darwin-x64 | `1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097` |

打包后用包内 Node 实际运行 sharp 的 PNG 编码和 esbuild 的 TypeScript 转换，避免只检查源码依赖。包内附 Node 许可证、项目第三方许可、平台及校验回执，并输出 ZIP 和 SHA256 文件。启动前 Bash 和 Node helper 分别校验包内 Node 的哈希。回执只在原生模块调用成功后标记 `nativeDependenciesVerified: true`。

## 启动与停止边界

- 使用包目录独立锁，同一安装不能同时启动/停止；异常中断遗留的锁不自动删除，提示检查锁内 owner 再人工移除。
- API 仅绑定原有 loopback；默认端口 18787，可用 `./Start-Vivic.command --port 18788`。其他应用占用的端口不会被关闭。
- 只复用/停止与本安装的可执行路径、入口、随机实例参数及 `ps` 创建时间同时匹配的进程；不按进程名批量结束，不杀进程组。
- 停止时先捕获该 API 直属、路径完全一致的模型 guardian，再等待 API/guardian 退出。停止失败保留状态以便重试。
- 重复启动复用本包 API；浏览器打开失败时保留已健康的服务。不同端口是不同浏览器 origin，其画布存储独立。
- 安装采用独占新目录，不覆盖已有 App，并过滤 `.env*`、日志、缓存、Git 和启动状态。运行过的包目录仍不应直接对外再分发。

Mac 平台的托管推理引擎、模型下载及 GPU/Metal 能力由 local-api 的 runtime 平台清单控制；这些能力需要单独的模型运行验证，不能从“包内 API 能启动”推断模型质量或吞吐。此打包任务不虚构模型权重、二次训练结果或 Mac 推理实测。

## CI 与本轮验证

新增手动工作流 `.github/workflows/package-macos.yml`，分别在 `macos-15`（arm64）和 `macos-15-intel`（x64）原生构建，并检查架构。标签按 [GitHub 官方 runner 表](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-public-repositories) 选择。

CI 在 fresh runner 上进行包内 API smoke：占用端口保留、健康与 `/launcher`、重复启动 PID、带空格 App 安装、禁止覆盖、不复制 session token/启动状态、plist、正常/重复停止、伪造旧 PID 不结束无关进程。检查关闭偏好恢复和托管模型，不打开浏览器，不下载模型，不使用麦克风或播放语音。仅当这些步骤通过才上传未公证预览 ZIP；不发布 Release、不部署。

本轮当前机器为 Windows，已完成三个 `.mjs` 的 `node --check`、三个 `.command` 的 Git Bash `bash -n`、新增 JS 的 oxlint、工作流 YAML 解析与双架构矩阵检查、8 个新文件的 LF/空白检查，以及非 Mac 构建被明确拒绝的检查。**尚未在 Mac 运行构建或 smoke，工作流尚未提交/运行，因此本轮没有可称为已验收的 Mac 安装成品。** Windows 现有已交付包保持原状；本轮没有重新将它算作新验证。

待补：Mac 两个架构的 CI 实跑；目标电脑安装与正常安全许可体验；托管模型推理与资源回收；Apple Developer 签名、公证和正式 DMG/PKG；Windows ARM64 原生支持另行评估。
