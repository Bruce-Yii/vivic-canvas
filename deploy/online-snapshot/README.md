# 当前线上前端的完整恢复备份

2026-10-30最终版本：`clarification-guard-20261030-2`，基于同事最新voice-v4并保留新语音/背景/传送，含对比度与完整删除确认修复。完整包`frontend-clarification-guard-20261030-2.zip`，28,453,662字节，2308文件/528对象，SHA256 `edcebce1956a9eb5f9a152b5c421dd2f6c7533423ba58e285d0b7e9813c0094f`；全部对象校验通过。

发布前voice-v4完整包`frontend-voice-v4-20261030-1.zip`，27,588,746字节、2100文件/503对象，SHA256 `fb5a703f0842b4320a93ca93463cddd9c4a5b2b1e7bdcee122a9ac6c57221dd4`。当前回滚入口为`python scripts/publish-current-question-flow.py --rollback`，操作前核对当前仍为最终补丁；旧版回滚命令不适用于新版。

以下保留F5与中间修复版本的快照。最新验收见`docs/design/G-演示与交接验收-20261030.md`。

2026-10-30最新版：`card-packages-20261030-1`，文件 `frontend-card-packages-20261030-1.zip`（26,208,695字节，1866文件/456对象），SHA256 `2315e0ebe4ad011aa16601a12ce1fd315b748cadef6daaac32b077428239d887`。同样使用下列snapshot.py verify/restore命令，替换ZIP文件名即可，无需前端依赖。

发布前原页面的当日完整备份 `frontend-before-card-packages-20261030.zip`（24,786,943字节，1673文件/423对象），SHA256 `58d69d7057aea202e8b2953a1e04f515a0db63499726758d65983b32108376f2`。保留了10月30日在原发布目录内新增的v54入口、v57样式等资源。当前版本的部署和边界见 `docs/design/F5-网页卡包接入验收-20261030.md`。

以下为10月29日旧版本的备份记录。

用户于 2026-10-29 要求服务器只保留最新版，并把最新版备份到 GitHub。后端源码与执行工具在当前分支；此目录补充最新版完整网页恢复包，弥补早先仅保存源码与增量补丁的不足。

- 当前页面版本：`unified-background-20261029-1`。
- 恢复包：`frontend-unified-background-20261029-1.zip`，24,114,830 字节。
- SHA256：`e42713d3eb58f86023028618aa0ec6cf453fb014200747a74bc283474ebc6690`。
- 包含全部 1,645 个文件，以及目录、文件权限、路径和校验哈希；重复内容只存一份，共 405 个内容对象。
- 包含当前 `web/`、nginx 前端头配置及发布说明。数据库、环境变量和密钥不在这个公开网页备份内。
- 对应后端运行源码：Git `ff981e1ee401c5d3b4e6554d3f40366d64fc4179`，后续开发提交继续保留历史。

## 校验与恢复

使用 Python 3.9 或更新版本，无第三方依赖：

```sh
python deploy/online-snapshot/snapshot.py verify deploy/online-snapshot/frontend-unified-background-20261029-1.zip
python deploy/online-snapshot/snapshot.py restore deploy/online-snapshot/frontend-unified-background-20261029-1.zip /tmp/vivic-restored-release
python deploy/online-snapshot/snapshot.py verify deploy/online-snapshot/frontend-unified-background-20261029-1.zip --source /tmp/vivic-restored-release
```

恢复目标必须不存在，不会覆盖正在运行的网站。完整还原校验通过后，可以用恢复目录中的 `web/` 和 `frontend-headers.conf` 恢复部署。

本次在服务器临时目录执行完整还原，并逐文件重算哈希；本机下载后也验证了全部内容对象与整个 ZIP 的 SHA256。确认 GitHub 推送成功后，才清理旧发布目录。
