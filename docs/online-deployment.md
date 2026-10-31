# Vivic 独立 Space 服务

2026-10-25：本分支把账号、Space、卡片、受控文件、命令回执和提醒保存到服务器。大屏是主要工作界面，手机使用同一账号的纵向 Space；电脑浏览器关闭不再终止手机执行。网页和 Android App 都不安装或加载本地模型。继续使用 library Hark `26ac2724` 的原字体、SVG、材质、连续圆角和天空；业务流程是 Vivic 的适配。

这是可审阅部署工件的说明，不代表已部署或完成生产验收。历史在线版 Linux/TLS 测试不代替本轮结果。具体通过、失败和未测项以本轮交付报告为准。

## 数据与授权

- 首次账号需要运营者配置的单次邀请码。用户名 3–40 位小写 ASCII 名称，密码 12–256 字符，服务端用 scrypt 保存密码哈希。
- 设备采用 HttpOnly、Secure、SameSite=Strict Cookie，服务端只保存 token 摘要。设备码单次、有时限，撤权后旧码或旧设备不能恢复。模型管理台密码不等于模型 Bearer Key。
- SQLite、资产索引和文件放在专用持久目录。单进程锁、WAL/FULL 事务、版本检查及 requestId 回执共同约束执行；丢回执须查询原 requestId，不自动换 ID 重发。
- 临时会话凭据（设置页验证过的 LLM/平台 Key）按账号隔离，只在服务端内存，空闲 30 分钟或最长 8 小时到期。断开、服务重启需重新连接；Space 数据保留。不自动继承本机 `.env`、Pi 登录或旧配置。
- 例外是 PR3 模型平台设置：线上模式把 `main`/`decision` 平台持久化到数据目录的 `providers.json`（Key AES-GCM 加密，0600），重启后继续生效；运营者也可用服务器环境变量注入 StepFun 种子，见下文。
- 正式原生 Jev v2 执行门控始终关闭。StartLux/GLiNER 分类供诊断/对照，不能冒充完整 state/questions/typed answers 协议或质量达标。
- 普通 PDF/MD 阅读不调用模型；“问 Vivic”主动展开。新文件限 PDF/MD，5 个/次、10,000,000 B/批、100,000,000 B/Space；历史其他格式仅下载。图片使用受控资产 ID，不开放任意路径。
- 客户端关闭后仍调度服务器提醒记录；重连可查看收件箱。这不表示关闭的手机已收到系统推送。本轮没有新增 Web Push、短信或外部消息。

## 开发与生产预览

使用 Node 24.21.0、pnpm 12.11.2。低内存机器串行检查，无须加载模型。

```sh
pnpm install --frozen-lockfile
pnpm dev
```

首次 `pnpm dev` 前由运营者在进程环境设置 12–256 字符的 `VIVIC_SPACE_INVITE`，值不打印。默认端口 127.0.0.1:5180 / 8790，数据在 `.cache/hosted-development`；端口被占用即拒绝启动，不停止已有服务。`pnpm dev:web` / `pnpm dev:api` 只启动一侧，`pnpm dev:legacy` 显式进入保留的旧本地 owner 模式。

生产预览先构建专用入口：

```sh
pnpm --filter @vivic/web build:online
pnpm --filter @vivic/web build:mobile
```

Windows PowerShell 示例（邀请码从受控进程环境提供，示例不含秘密）：

```powershell
$env:PORT = '19441'
$env:VIVIC_ONLINE_ORIGIN = 'http://localhost:19441'
$env:VIVIC_SPACE_DATA_DIR = 'C:\VivicData\isolated-preview'
Set-Location apps/local-api
node --import tsx src/online/index.ts
```

macOS/Linux 示例：

```sh
cd apps/local-api
PORT=19441 VIVIC_ONLINE_ORIGIN=http://localhost:19441 \
VIVIC_SPACE_DATA_DIR=/absolute/isolated-vivic-data \
node --import tsx src/online/index.ts
```

数据目录必须为绝对路径。生产接受精确 HTTPS Origin，HTTP 仅允许 loopback。默认监听 127.0.0.1。生产核对 `dist-online/.vivic-online-build.json`；开发的 `VIVIC_SPACE_API_ONLY=1` 只跳过静态工件，不跳过认证。同源反代的转发约束见下方。旧 `src/index.ts` 不用于在线部署。

## Android

`apps/android/build.ps1` 把 `build:mobile` 的不可变 Hark 服务地址引导页打包。用户选择 HTTPS 地址并原生确认后加载对应网页，仅保存 Origin，不保存配对秘密/模型 Key；远程页面不能自行修改受信地址。原件保存由系统文件选择器确认并校验哈希。

生产 APK 不含私有 CA，不启用 WebView 调试。隔离测试可显式指定 `-DebugWebView -DebugCaCertificate <public-ca-cert.pem>`，单列为 debug/TestCA；不与生产 TLS 结论混用。构建回执列实际版本及 APK/网页资产哈希。脚本使用本地开发签名，不能当正式商店签名。

## Linux 单实例容器

```sh
export VIVIC_ONLINE_ORIGIN=https://vivic.example.com
# 另在受控环境设置 VIVIC_SPACE_INVITE，不提交到源码/报告。
docker compose -f deploy/online/compose.yaml config --quiet
docker compose -f deploy/online/compose.yaml up --build -d
```

Compose 使用独立 named volume `vivic-space-data:/data/vivic`，只映射宿主 loopback 8790，非 root、只读根文件系统，临时目录 tmpfs。普通 `down` 保留卷，不执行 `down -v`。数据库和资产必须一起备份，不复制运行中的单个 SQLite 文件冒充一致性备份。步骤见 [离线备份和恢复](hosted-data-backup.md)。恢复只写全新目录，清除设备和配对授权，避免旧备份复活已撤权设备。

默认不安装外部连接器 CLI。确需时指定构建参数 `VIVIC_CONNECTOR_CLIS=1`，使用锁定哈希的 Lark/WeCom 工具；独立授权和外部操作许可仍必需。不读取宿主个人授权。目标 Linux 必须实际重建并验证 sharp 等原生依赖；Windows 构建成功不等于 Linux 运行通过。

## HTTPS 反向代理

使用独立域名及根路径 `/`，不支持直接挂在 `/vivic/`。不要覆盖已有站点或公开 relay。已配置 HTTPS 的 Nginx 虚拟主机可使用：

```nginx
location / {
    proxy_pass http://127.0.0.1:8790;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_read_timeout 200s;
    client_max_body_size 24m;
}
```

24m 给 ASR/分段 WAV 和 multipart 留出封装空间；服务内仍执行各接口更小限制，不提高文件配额。保留 Cookie、Origin、Sec-Fetch-*，不记录请求正文、Authorization、Cookie 或完整查询内容。服务的 URL Origin 固定于配置，不能由客户端任意指定转发 Origin。

`/healthz` 返回 `vivic-space-api`。所有写操作严格同源，浏览器 Bearer 被拒绝。当前单进程服务不能直接多副本随机分流；扩容前须重新设计共享事务、连接及任务协调。

## 模型与交付边界

模型平台默认 `https://edsionc.top/api/v1`，运营者可通过 `VIVIC_MODEL_API_BASE_URL` 固定。用户在设置密码框分别连接 LLM 和模型平台。可选部署级 token 只能经秘密管理注入，不进入包、日志、Compose 源码或浏览器存储。

### 线上平台设置与 StepFun 种子（2026-10-31）

线上模式现在会读取 `main`/`decision` 平台设置并注入实际请求，不再只在本地模式生效。设置文件位于 `VIVIC_PROVIDER_DATA_DIR`（未设时复用 `VIVIC_SPACE_DATA_DIR`，容器内即 `/data/vivic`）下的 `providers.json`，Key 用 AES-GCM 加密，API 响应仍不含明文。`VIVIC_PROVIDER_PERSIST=off` 可显式退回内存模式。这是部署级共享设置（所有账号使用同一份平台配置）；设置页里临时验证过的会话凭据仍按账号隔离。

没有保存任何 `main` 平台时，可用服务器环境变量注入 StepFun：

| 变量 | 必填 | 默认 |
|---|---|---|
| `VIVIC_STEPFUN_API_KEY` | 是（不设则不种子） | — |
| `VIVIC_STEPFUN_BASE_URL` | 否 | `https://api.stepfun.com/v1` |
| `VIVIC_STEPFUN_MODEL` | 否 | `step-3.5-flash` |

启动时创建一次名为 `StepFun (seed)` 的 `roles: ["main"]` 平台（协议 `stepfun-v1`）。已有 `main` 平台不覆盖，设置优先于 env；Key 只从进程 env 读取并交给 store 加密，不写日志或响应。回滚：删除这条种子平台，或移除环境变量后重启。部署时只通过秘密管理注入这些值，不写入 Compose 源码、镜像或报告。

ASR/TTS/分类元数据在线、协议通过和真实质量通过分别报告。HTTP 取消不等于 Mac 推理已停止。断网保留草稿并提示连接，不宣称离线模型能力。

SSE 同次首句反馈由 `VIVIC_STREAM_FEEDBACK` 控制，默认 `on`（与既有行为一致），只在认证 SSE 分支生效；普通 JSON 客户端不变。设 `off` 并重建容器即关闭，删除该键或设 `on` 即恢复。详见 [决策记录](decisions/2026-10-31-routing-feedback.md)。

`pnpm package:online` 生成源码/网页部署包和 SHA256，不附带个人数据、DB、权重、Key、私钥、签名 keystore 或 node_modules。运行后目录不得直接分发；私人备份单独受控保存。

本轮只交独立分支、补丁和隔离复测证据，不自动推送、建 PR、合并、公开部署或升级公共服务。生产域名、真实推理质量、实体手机/麦克风和 Linux 运行结果按实际执行状态单列。
## Cursor 旧版界面（2026-10-26）

默认的 `build:online` 也构建此旧版界面，避免常规重新部署恢复为旧的托管界面。
`build:hosted` 单独保留托管界面的构建入口。

`pnpm --filter @vivic/web build:owner` 输出 `apps/web/dist-owner`。该入口保留 Cursor 会话
`22995caf-caa5-47ce-a78d-a26afd50962a` 的 `43d8e3a` 旧版界面；发布时将此目录作为
`VIVIC_ONLINE_WEB_DIST`（或容器内的 `dist-online`）。它仍使用 `/api/space` 账号 Cookie，
画布通过受版本约束的 `/api/space/owner` 适配器保存在原来的服务器 Space 中，原件复用已有资产服务。
`/remote/` 保留账号手机版入口。语音通过 API 识别，不下载本地模型。

发布前运行 `node --import tsx ../../scripts/verify-cursor-owner.mjs`（目录 `apps/local-api`），
并验证旧界面的设置、Space 弹窗、拖动保存、文件上传/阅读和展示窗口。服务器使用原运行镜像的依赖，
替换当前源码与构建产物；切换前停服复制整个数据目录，保留上一容器。回滚仅切换容器，数据恢复须单独确认。
