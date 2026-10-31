# 2026-10-23：在线端目标环境验证

本轮新增可重复的 Linux Docker + 独立 TLS nginx 验收环境，已在用户现有
CentOS x86_64 服务器实际安装 Linux 原生依赖、组装并运行 online 镜像。
镜像以 node 用户、只读根文件系统运行；预编译网页经 online marker 校验。
未安装 daemon、修改宿主 nginx/证书、开放公网端口或正式发布。

生产入口、真实 appFactory 的测试上游凭据隔离/TTL，以及新的手机 HTTPS
桥接初轮 34 项实际通过；随后加 Hark 静态样式可取、SSE accepted 提前到达
两个断言，在新项目中 **36 项** 全通过，包括一次真实等待约 20 秒的手机长轮询。此处 TTL 为
测试时钟推进，模型上游为 stub；不声称真实模型或真机 UI 已验收。

新增 `scripts/online-linux-verify.sh` 一键建立唯一 Compose project，只暴露
127.0.0.1:18443/18444，默认退出后停止自身容器。TLS 使用显式信任的两天
自签测试证书；没有跳过证书校验，也不等同于公网证书部署。源包会携带全部
无凭据验收脚本。Compose 可覆盖 loopback 端口，补应用 healthcheck，反代
模板关闭缓存/缓冲并保留 150 秒超时，兼容 SSE 和手机纯 HTTPS 长轮询。

目标机 Docker Hub 直连不可用，已使用 AWS 官方镜像镜像库的同一固定内容
digest，未改 Docker daemon。首次 nginx 只读目录失败已修到 tmpfs，失败与
通过证据均保留。资源和最终统一源码包复核边界见
[实际验收记录](../verification/online-server-20261023.md)，复现见
[验证环境说明](../../deploy/online/verify/README.md)。

最终交付 archive SHA256：
`ec5136d59ee2d5f7db81d167d0d397075d28970ce96cec05fe81c7d5bc90a4a1`。
已对上一轮完整 Linux 实构包和最终包的 549 个文件做等价核对，只有入口裸
`/remote` 别名、许可/说明/元数据与验收脚本不同；最终运行镜像复用已实构
Linux 依赖和网页，只增量 COPY 新入口，避免小服务器重复 deploy 占盘。
三条 remote 入口、36 项 TLS 检查及 native sharp 生成均通过。匹配包的独立
回执在 `.cache/online-server-20261023/evidence-release-final/VERIFICATION-RECEIPT.json`。
测试容器/网络已停、SSH 已关，已有公开手机站仍 200，未正式发布或推送。
