# Vivic Online：目标 Linux / Docker / HTTPS 验收

日期：2026-10-23。范围：用户授权的隔离 staging 验收，本轮不正式发布。

**最终结果：交付包 `vivic-online-2026-10-23T09-11-23-520Z.tar.gz` 已完成
目标 Linux 的 36 项 HTTPS/反代检查及原生模块检查。** 包 SHA256 为
`ec5136d59ee2d5f7db81d167d0d397075d28970ce96cec05fe81c7d5bc90a4a1`。
最新结果和精确增量构建方式见文末；测试容器已停止、SSH 已关闭，未公开发布。

## 实际运行环境

在用户已有服务器上通过已授权的 SSH 身份验证执行，未修改认证设置。
服务器为 CentOS Linux 8、x86_64、Linux 4.18；已有 Docker Engine 26.1.3、
Compose 2.27.0、OpenSSL 1.1.1k。宿主已有 nginx 1.14.1 保持不变。
宿主 Node 20 未被升级；构建和探测均使用固定的 Node 24.21.0 Linux 镜像。

验收前内存约 1.7 GiB、available 949 MiB、根盘剩余 6.0 GiB。Linux 镜像
构建成功后，根盘仍余 4.9 GiB、available 764 MiB。未安装系统服务、开防火墙
或更改 Docker daemon 配置，未运行全局 prune 或删除已有镜像/目录。

独立源码和证据目录：`/root/vivic-online-staging-20261023-codex-check1`。
生产源码基线为上一轮在线可部署包，叠加本轮手机桥接后端和部署验收工具；
不是最后一次统一打包后的版本。初始传输包两端 SHA256 一致：
`bc076806c03256adead265d6b87a59e7a9b84882d3027dcc5144e4141a20887c`。

## 已通过的实际检查

第一轮有效镜像：`vivic-online-check-20261023082703-3618007:local`。
实际 image ID：`sha256:06ff02a21121c49806aa6e487f2696e764af66368938e7d33f9092c2b1b0b3b8`。
Linux 原生依赖已按 frozen lockfile 安装；`pnpm deploy --prod` 组装运行时成功。
Web 使用包内预编译、带 online marker 的产物，**本次没有在 Linux 重跑 Vite**。
运行镜像为 linux/amd64、`USER node`，应用根文件系统只读。
还在禁止网络、只读根文件系统的独立容器内实际调用 sharp 原生库生成 1×1
PNG，输出 90 bytes，`process.platform=linux`、`arch=x64`、uid=1000；不是仅
检查 Linux 文件名或复制 Windows node_modules。

| 分组 | 实测结果 |
| --- | --- |
| 生产入口，10 项 | health 身份、online metadata、两个独立安全 Cookie、缺 Cookie 拒绝、两会话初始无保存 Key、跨 Origin 拒绝、浏览器 Bearer 绕过拒绝、本地模型管理路由不可用、真实内置便笺 intent SSE、删除 A 不影响 B |
| 真正 appFactory + 测试上游，13 项 | 上述后端检查，加 A/B Key 隔离、断开 A 后 B 继续连接、空闲过期后清除凭据 |
| 手机桥接，11 项 | 两个 owner 会话、Android 原生 Origin 预检、无 Cookie 配对、单次码、跨 owner 隔离、native Origin 不能调用 owner/模型 API、严格 snapshot 正文、command/result、真实等待约 20 秒长轮询、revoke 拒绝旧 token/命令、删除 owner 唤醒 phone 且另一 owner 保持可用 |

以上 34 项在目标 Linux 的独立 nginx TLS 反代之后实际通过。每组均创建全新
内存会话；没有接触用户画布、模型凭据、物理手机、麦克风或播放设备。
手机测试是协议层合成客户端，不等同于 APK 真机 UI 验收。

修复后的完整一键脚本另在全新 Compose 项目
`vivic-online-check-20261023083230-3623506` 重跑，exit 0。复用上面的已构建镜像，
避免重复原生依赖层；证据明确记录 imageReused。退出后自身容器/网络已停止，
18443/18444 无监听，服务器原有容器仍在运行。仅安全 JSON/元数据已取回本机
`.cache/online-server-20261023/evidence-initial/`，未下载证书私钥。

凭据隔离使用明确的 `TEST-*` 占位字符串和 HTTP 上游 stub；**不代表真实
StepFun LLM、ASR、TTS 已通过**。TTL 用可控时钟推进 31 分钟，验证真实
handler/appFactory 清理；不是在公网实等 30 分钟或实际负载/持久化压测。

## TLS 与既有服务边界

验收 nginx 容器只绑定宿主 `127.0.0.1:18443/18444`；API/fixture 没有宿主
端口。新证书只用于 `vivic-staging.localhost`、有效两天；探测显式信任该张
自签证书并验证 hostname，未跳过 TLS 验证、未导入系统信任库。
**这不是已正式发布或已配置公网受信证书。**

已有 `https://edsionc.top/` 和 `https://edsionc.top/vivic-remote/` 只读检查均为
HTTP 200，未替换页面、重载宿主 nginx 或修改对应 location。已有 edsionc.top
证书为 ZeroSSL ECC DV SSL CA 2 签发，2026-09-20 至 2026-12-19 有效；此
证书不被用作新线上入口的部署验收结论。

## 发现并修复

1. 目标机 Docker Hub 域名直连超时。改用 AWS 官方 Docker 镜像镜像库中
   **相同 SHA256** 的 Node 和 nginx manifest；未改 daemon/DNS，未换未知镜像。
2. 只读 nginx 容器缺省 fastcgi/uwsgi/scgi 临时目录落在 `/var/cache/nginx`，
   启动失败。显式改到 tmpfs `/tmp` 后启动与 TLS 34 项检查通过。
3. 原 Compose 固定 8790，无法并行检查。生产配置提供可覆盖的 loopback host
   端口，验收另用独立 Compose/project；加应用 healthcheck。
4. 加固定基础镜像的显式 build arg、预编译 online Web 选择和专用 Docker ignore；
   默认生产 Dockerfile 仍可完整构建网页，验收使用低内存路径。

## 复现与待补

执行 [独立验证说明](../../deploy/online/verify/README.md) 中命令。源包包含
`scripts/online-probe.mjs`、`scripts/online-mobile-probe.mjs` 和
`scripts/online-linux-verify.sh`。证据 JSON 只写检查名、耗时与通过状态；不交付
测试证书私钥。失败构建/首次 nginx 错误日志也保留，未删除证据掩盖失败。

此前中间版本尚需统一源码包复核，现已完成，见文末。正式公开部署、专用域名
的生产证书/路由、真实付费 API、账号同步、多实例共享会话和实际长期负载均
不属于本次已完成验收。

最终脚本另外补了两个有意义的检查：Hark 哈希样式与在线入口静态文件，以及
延迟测试上游响应前 SSE accepted 事件是否提前到达。随后已在目标 Linux 的
`vivic-online-check-20261023085032-3626413` 独立项目重跑通过，exit 0：生产
11 项、fixture 14 项、手机 11 项，**共 36 项**。SSE 的 mock 上游刻意延迟
900 ms，accepted 须比最终结果提前至少 500 ms，实际通过。原生 sharp 检查
亦写入 `native.json`。仍复用首版已构建镜像，不将此结果当作后续新增源码
已经重新构建。安全证据取回 `.cache/online-server-20261023/evidence-refined/`。

## 统一包复核中发现的入口别名问题

已对 `2026-10-23T09-01-42-464Z` 包进行新的 Linux 实构；36 项原有检查和
原生模块通过。额外静态检查发现裸 `/remote` 返回 404；该包二维码使用的
`/remote/`、`/remote/index.html` 已在入口 fallback 中，不能把裸别名失败
写成二维码入口缺失。维护者补齐裸别名，并将三条路径一起加入生产 probe
的静态入口断言；最终交付包已完成精确增量构建、复核并写出匹配包的回执。

这一轮开始时空闲磁盘略低于脚本默认 4 GiB，默认前置检查正确停止，未启动
构建。维护者明确允许该次验收最低 3 GiB（仅改目标 stage 的验收 shell
门槛，未改产品源码或待交付包）；设置 384 MiB Node 堆并串行构建。构建与
探测进程组另有 3 秒资源采样，磁盘低于 2 GiB 或 available RAM 低于
300 MiB 会停止本任务进程组。开始空闲磁盘 4,050,496 KiB，结束
3,287,552 KiB；构建/探测观测值未触及中止线。未全局清理镜像或缓存。

## 最终交付包与验收回执

目标机和本机均校验最终 archive SHA256
`ec5136d59ee2d5f7db81d167d0d397075d28970ce96cec05fe81c7d5bc90a4a1`。
在新目录 `release-final-091123` 解包，并与已完整实构的 09:01 包逐文件比对：
549 个文件同名，只有 `LICENSES.md`、`README.md`、`release.json`、
`scripts/online-probe.mjs` 和 `apps/local-api/src/online/index.ts` 五处不同。
所有依赖/锁文件、其他 API 源码和 Web 编译产物均逐字节相同。比对仅将上一
轮目标 stage 的验收脚本磁盘门槛临时 override 还原后计算，产品源码不做归一。

09:01 包已用仓库 Dockerfile 在 Linux 实际 frozen 安装/组装并运行，基础
image ID 为 `sha256:ca6ef69a5ff1444b95430f8aecf28c430c6a1806695c721ee4717fadef994b60`。
为避免重复 pnpm deploy 的临时层占满小服务器，维护者批准：**以该固定、
已通过验证的运行镜像为 FROM，仅 COPY 新的 index.ts**。最终 image ID 为
`sha256:f2fa7511ed9a2314c615e4a107f08e2e85157fa69fa2686ddef64a5710e7302c`。
镜像内 index.ts 的 SHA256 与最终包内对应文件一致。此处没有声称最终包再次
完整执行了 Dockerfile/pnpm deploy；它是已验证完整 Linux 运行时的精确单文件
增量，依赖和网页等价证据单独保留。

最后一轮 `vivic-online-check-release-20261023` 的检查全部通过：

- 生产入口 11 项，其中静态入口检查同时要求 `/remote`、`/remote/`、
  `/remote/index.html` 均为 200，并成功取得 Hark 哈希 CSS。
- 真实 handler/appFactory 加测试上游 14 项，包括模型 Key 隔离、TTL 清理，
  以及 delayed result 前 SSE accepted 提前到达。
- 手机桥接 11 项，包括真实 20 秒长轮询、命令/结果、跨 owner 隔离和撤权。
- 禁止网络的只读容器内，以 uid 1000 实际调用 sharp 生成 90 bytes PNG。

此前的旧安装/部署缓存只按确认归属本任务的具体 cache ID 清理；旧首次镜像
`06ff02…` 也已移除，源码及全部失败/通过证据保留。没有全局 prune，未动其他
项目对象。最终增量检查从 3,070,234,624 bytes 空闲开始，结束
3,070,181,376 bytes；全轮采样最低空闲 3,069,841,408 bytes，最低 available
RAM 407,195,648 bytes。均高于 2 GiB/300 MiB 中止线。完整构建 3 GiB 的
门槛没有继续降低；最终极小增量按独立批准方式执行。

验收后自身容器和网络停止，18443/18444 无监听；已有
`https://edsionc.top/vivic-remote/` 仍 HTTP 200。仅安全证据下载到本机：
`.cache/online-server-20261023/evidence-release-final/`，其中
`VERIFICATION-RECEIPT.json` 绑定最终 archive SHA、基础/增量镜像 ID、549 文件
等价证明、36 项结果及边界。证据包 SHA256 为
`2b334dd83c8f383370bcd52a121193230f52b69b099fa194d4ad9ab989253779`。
未下载测试证书私钥；本任务全部 SSH/scp 会话现已关闭。
