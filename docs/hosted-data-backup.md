# 托管 Space 离线备份与恢复

工具为 [scripts/hosted-data.ts](../scripts/hosted-data.ts)。它只处理本机单实例的持久化目录，不提供 HTTP 文件路径接口，也不停止任何进程。运行环境沿用项目的 Node 24 与已安装的锁定依赖。

## 备份

先由维护者正常停止使用该数据目录的服务。工具复用 Space 单实例锁；服务仍在运行时明确拒绝，不强制解锁或终止服务。下面的 `--data-dir` 应与实际服务的 `VIVIC_SPACE_DATA_DIR` 指向同一目录。

在仓库根目录执行，替换为实际绝对路径。目标父目录需要事先存在，目标目录本身必须尚不存在。

Linux / macOS：

```sh
corepack pnpm --filter @vivic/local-api exec tsx ../../scripts/hosted-data.ts --data-dir /srv/vivic/data --backup-to /srv/vivic/backups/backup-20261025
```

Windows PowerShell：

```powershell
corepack pnpm --filter @vivic/local-api exec tsx ../../scripts/hosted-data.ts --data-dir "C:\Vivic\data" --backup-to "C:\Vivic\backups\backup-20261025"
```

备份目录包含：

- `space.sqlite`：调用现有 `store.backup()`，由 SQLite `VACUUM INTO` 生成一致性快照，包括账号及密码哈希、Space/卡片、任务与命令回执、提醒收件箱等持久化记录。
- `assets/`：只复制数据库索引仍持有的受控原件，每个文件重新核对大小及 SHA256，并检查数据库资产索引引用是否完整。
- `manifest.json`：数据库快照和所有资产文件的相对路径、字节数及 SHA256。

工具不复制源目录的活动 SQLite/WAL 文件，不扫描或复制 `.env`、配置文件、锁文件等其他内容。LLM 与模型平台 Key 只在服务内存中，备份无法保存或恢复它们。数据库内的账号密码哈希不会展开到清单、日志或回执；备份本身仍包含账号及原件数据，应由维护者妥善保管。

旧版本遗留的无索引 `.bin` 文件只做只读诊断，在成功回执的 `unindexedAssets` 中记录数量、字节数及 `excluded-read-only`，不复制进新备份，也不删除源文件。仍有持久删除意图时，工具明确拒绝备份或恢复；先让服务启动恢复，或重试同一原件删除操作，确认完成后再停机备份。

原件删除先持久记录意图并继续计额，保护当前卡片、撤销/重做历史及未完成迁移引用；只有最后一个同物理 SHA 的索引引用被清理时才删除字节，随后移除索引并释放容量。中断由服务启动或同一 DELETE 重试恢复。POSIX 会同步父目录；Windows 沿用现有文件同步策略，Node 无法在此提供目录 fsync，因此进程中断恢复通过不等同于 Windows 断电级目录持久性保证。

## 恢复

保留现有数据目录，恢复到另一个全新目录。工具先核对备份完整文件集、大小和 SHA256，再检查数据库 `integrity_check`、`foreign_key_check` 与资产索引引用。清单用于检查完整性，不是来源签名；只恢复自己保管的可信备份。

Linux / macOS：

```sh
corepack pnpm --filter @vivic/local-api exec tsx ../../scripts/hosted-data.ts --restore-from /srv/vivic/backups/backup-20261025 --restore-to /srv/vivic/restored-20261025
```

Windows PowerShell：

```powershell
corepack pnpm --filter @vivic/local-api exec tsx ../../scripts/hosted-data.ts --restore-from "C:\Vivic\backups\backup-20261025" --restore-to "C:\Vivic\restored-20261025"
```

恢复始终清除全部设备会话、配对码和登录限流状态，没有保留旧设备授权的开关。即使备份早于某次设备撤权，旧设备 Token 和旧配对码也不能因恢复重新生效。账号及备份时的密码哈希、卡片、原件和已保存回执保留；服务恢复后需要重新登录、重新授权其他设备，并重新连接 LLM/模型平台。

确认恢复成功后，再把停止状态下的服务数据目录配置指向新目录并正常启动。工具不会修改服务配置或切换目录。未完成任务不会因本工具恢复而自动重跑；应先查询原任务编号和 Space 中的已保存变化，再决定后续操作。

## 路径与失败处理

源与目标都必须是本机绝对路径，拒绝相对路径、`.` / `..` 组件、末尾点或空格的路径组件、网络路径、符号链接及 Windows junction。源和目标不能相同或相互包含；现有目标目录即使为空也拒绝覆盖。资产目录只接受当前受控的哈希目录及 `.bin` 文件，不会悄悄忽略未知或临时文件。

本版仅支持当前 SQLite schema/version 1 及已知表名，拒绝缺表、额外表、触发器或视图；升级数据格式后应同步更新此工具。版本检查在持有服务锁时只读执行，未知版本不会被存储器初始化改写。

成功时输出 `ok: true` 的 JSON 并返回退出码 0；失败输出固定安全错误及非零退出码。失败会尝试清理本次新建的目标目录，源数据和已有目标保持不变。若权限或磁盘故障使清理未完成，不把残留目录当成成功备份；检查故障后使用另一个全新目标重试。

当前验证包含 8 项删除日志回归、9 项备份 CLI 回归；资产删除、备份、托管集成、迁移和图片五组定向共 51 项通过。全 API 1491 项通过，3 项显式开启才运行的外网诊断跳过；API 类型检查通过。这些测试使用真实临时 SQLite 与原件，不代表已备份真实用户数据，也不替代部署环境的停机恢复演练。
