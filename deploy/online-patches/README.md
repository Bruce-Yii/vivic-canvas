# 线上基线说明（2026-10-29）

本分支是 https://vivic.edsionc.top 在 2026-10-29 实际运行版本的快照，用来让所有人从同一份代码继续改。

| 部分 | 来源 |
| --- | --- |
| `apps/local-api/src`、`apps/local-api/package.json` | 线上容器 `vivic-preview-20261027`（镜像 `vo-helpmove-1414`）内 `/app/apps/local-api` |
| `packages/contracts/src`、`packages/card-runtime/src` | 同一容器内 `node_modules/@vivic/*` |
| `apps/web/src` | 服务器 `releases/owner-deploy-20261027-1050/source` 依次叠加 10/27 各 owner-* 增量，截至 10/27 12:37 |
| `deploy/online-patches/*` | 10/28 之后的前端改动。这些是直接改打包产物的补丁，**没有对应源码**，原样保存，后续需逐个移植回 `apps/web/src` |

部署包本来不含的测试、Android、配置文件沿用 `main`。

当前线上前端目录：见 `RUNNING_CONTAINER.txt`。

## 增量归档

运行 `node scripts/sync-online-patches.mjs`。使用外层 `tools/vssh.py` 与本机 Python；可通过 `VIVIC_SSH_RUNNER`、`VIVIC_SSH_PYTHON` 指定工具路径。

只读取服务器新 release 的 `patch/`、顶层 JSON、README、验证说明及前端头配置；不打包 web、assets-before、assets-fixed 等完整副本。已存在的存档目录拒绝覆盖，归档中的链接与路径穿越会被拒绝。

JSON 部署记录中的环境变量、凭据和鉴权字段在导出时脱敏，前端补丁文件保持原样。`SYNC_STATE.json` 记录同步时间与本次新目录，`RUNNING_CONTAINER.txt` 记录当前前端指针及后端镜像。
