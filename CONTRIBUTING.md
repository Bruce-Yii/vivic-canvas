# 开发与协作

当前三人协作完善本地单人版：维护者重点优化核心流程，也可做新功能；两位伙伴按依赖程度承担 Landing、新卡片和独立功能，见 [团队任务边界](docs/TEAM_TASKS.md)。功能顺序见 [本地开发路线](docs/LOCAL_ROADMAP.md)，产品约束见 [AGENTS.md](AGENTS.md)。部署、账号和收费安排在本地版本验收以后。

## 用 GitHub Desktop 管理当前项目

GitHub 保存代码、任务和评审；GitHub Desktop 管理电脑上的代码版本；编辑器或编程 Agent 负责修改代码。

1. 在 GitHub Desktop 选择 **File → Add local repository**，目录选 `C:\Users\edsjrcheng\Desktop\vivic\vivic-canvas`。上一级 `vivic` 不是 Git 仓库，已有代码无需再次 clone。
2. 核对 Repository settings 中的 remote 为 `https://github.com/ECdison6227/vivic-canvas.git`。
3. 开始新任务前，处理当前未提交内容，再切到 `main`，点击 **Fetch origin**，有更新则 **Pull origin**。
4. 在 GitHub 建一项 Issue，写明验收条件；从 `main` 创建分支，例如 `feat/42-space-templates`。`42` 仅为示例，使用实际 Issue 编号。
5. 用编辑器或 Agent 开发。Desktop 的 **Changes** 中检查差异，勾选本次任务文件，写说明后 **Commit to 分支名**。Commit 只保存在本机。
6. 完成必要验证后，点击 **Publish branch / Push origin** 上传分支，再 **Preview Pull Request → Create Pull Request**。核对 base 是 `ECdison6227/vivic-canvas:main`。
7. 在 GitHub 看差异与检查结果，实际验收后由维护者合并 PR。回 Desktop 更新 `main`，再开始下一项任务。

官方操作：[添加本地仓库](https://docs.github.com/en/desktop/adding-and-cloning-repositories/adding-a-repository-from-your-local-computer-to-github-desktop)、[创建 Issue 和 PR](https://docs.github.com/en/desktop/working-with-your-remote-repository-on-github-or-github-enterprise/creating-an-issue-or-pull-request-from-github-desktop)。

## 两位伙伴加入时

首轮采用 **fork + PR**，不授予主仓库写权限。伙伴在 GitHub 将 `ECdison6227/vivic-canvas` fork 到自己的账号，在 Desktop clone 自己的 fork；`origin` 是个人 fork，`upstream` 是主仓库。核对主仓库最新 `main` 后，从同一基线创建自己的任务分支。不要把上面维护者的本机目录或 `origin` 地址照搬到伙伴电脑。

先从 [任务边界与示例](docs/TEAM_TASKS.md) 中确定各自的一项任务，再写 Issue 的允许文件、接口、样例和验收步骤。可以交付新功能代码和测试；共享契约、核心流程、依赖或工作流的跨模块变更须按任务明确协调，不顺手扩展。

完成后推到自己的 fork，PR 的 base 仍是 `ECdison6227/vivic-canvas:main`。维护者核对范围、接口和验证结果再决定合入。优先选择可独立开发的任务；有核心依赖时先确定接口和集成点，避免互相等待。[fork 权限说明](https://docs.github.com/en/pull-requests/reference/forks)

建议使用一个 GitHub Projects 看板：Backlog（候选）→ Ready（可开工）→ In progress（开发中）→ Review（待验收）→ Done（已合并并验收）。每人同时做一项，未满足前置依赖的任务留在 Backlog。路线里的 `Lxx` 编号只是本地任务编号，实际建 Issue 后再记录对应链接。[创建项目看板](https://docs.github.com/en/issues/planning-and-tracking-with-projects/creating-projects/creating-a-project)

维护者也沿用分支和 PR 流程；伙伴的 PR 由维护者审核。维护者的主线不必等伙伴审核才继续。不要给每人建立永久分支，也不要通过覆盖目录来合并代码。

## 启动和检查

在仓库根目录操作，使用 Node 24（CI 固定到 24.21.0）和 `package.json` 指定的 pnpm 12.11.2。先确认终端可执行 `pnpm --version`。仅能执行 `corepack pnpm` 时，项目脚本里嵌套的 `pnpm` 命令仍可能找不到。

Windows 已安装 Corepack 但缺少 pnpm 命令时，可在仓库根目录使用当前终端的局部入口，无需修改系统安装目录：

```powershell
New-Item -ItemType Directory -Force .cache\tooling | Out-Null
corepack enable pnpm --install-directory .cache\tooling
$env:Path = (Resolve-Path .cache\tooling).Path + [IO.Path]::PathSeparator + $env:Path
pnpm --version
```

`.cache` 不入 Git；每个新终端需重做 PATH 那一行，或使用自己已安装的 pnpm。不要改锁文件版本或另建 npm lockfile 来绕过安装问题。

```sh
pnpm install --frozen-lockfile
pnpm dev
```

入口为 `http://localhost:5175/`，设置 `/control`，展示 `/display`；API 使用 8787。如果一键启动遇到进程启动错误，可在两个终端分别执行 `pnpm dev:web` 和 `pnpm dev:api`，并把具体错误记入环境任务。不要结束其他项目的进程来腾端口。

```sh
pnpm contracts:check
pnpm typecheck
pnpm test
pnpm build
```

提交前按改动选择检查：纯文档查路径和差异；前端运行 `pnpm --filter @vivic/web test`；后端运行 `pnpm --filter @vivic/local-api test`；跨模块或契约变更运行上面的整组命令。契约生成产物变化时先 `pnpm contracts:generate`，审查差异后一起提交。

视觉/交互修改再运行受影响的浏览器用例，使用隔离测试画布及 5174/8788，多个 Playwright 命令串行执行。真实模型连接、音频设备与外接屏按具体任务验证；自动化保持静音，不读取个人认证文件或采集物理麦克风。

`.github/workflows/ci.yml` 在 Linux 和 Windows 上运行整组检查，不需要个人模型密钥；本地创建 workflow 不代表 GitHub 已运行成功。

## 模块边界

| 模块 | 当前位置 | 如何协作 |
| --- | --- | --- |
| 共享协议 | `packages/contracts/src/` | 先合入兼容的类型/Schema，再接前后端；破坏性变更附迁移方案 |
| 平台状态与画布 | `apps/web/src/sync/`、`persistence/`、`state/` | 负责保存、撤销、owner、布局；卡片通过宿主操作更新 |
| 模型与数据能力 | `apps/local-api/src/` | 负责连接、请求、取消、校验；凭据留在后端 |
| 内置 Card | `apps/web/src/cards/`、`apps/local-api/src/scenes/` | 复用组件和契约；添加卡片不能绕过数据校验 |
| 使用体验 | `apps/web/src/control/`、页面及现有组件 | 输入、设置、错误状态和示例；Display 保持极简 |
| 文档和测试 | `docs/`、各模块测试目录 | 在同一任务里记录验证，便于下一人接手 |

现在用一个 monorepo 即可。以后 Card SDK 稳定后，示例插件和第三方 Card 可以放独立仓库；平台、SDK 与官方卡片不用为了分工立即拆仓库。

给编程 Agent 的任务可以直接写：

> 读取 AGENTS.md、README_FIRST.md 和 docs/TEAM_TASKS.md。完成已分配的 Issue【链接】，按约定文件范围和输入输出接口实现代码与测试，记录实际检查和未完成的集成点。不要顺手改核心流程、全局样式、依赖或任务外模块；发现必须跨范围的改动时先说明并协调。

合并冲突与远端约定见 [Git 工作方式](docs/GIT_WORKFLOW.md)。
