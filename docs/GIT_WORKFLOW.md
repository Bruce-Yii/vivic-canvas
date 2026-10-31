# Git 协作约定

当前主仓库：[ECdison6227/vivic-canvas](https://github.com/ECdison6227/vivic-canvas)，集成分支 `main`。具体按钮步骤见 [贡献指南](../CONTRIBUTING.md)。

## 三人协作

维护者在主仓库的任务分支推进产品。两位伙伴各自 fork 主仓库，在自己的 fork 建任务分支，向主仓库 `main` 提 PR；首轮不授予主仓库写权限。每人本机独立 clone，不共享工作目录。

伙伴的 `origin` 指向自己的 fork，`upstream` 指向 `ECdison6227/vivic-canvas`；维护者当前 `origin` 指向主仓库。开始操作先看 `git status --short --branch` 和 `git remote -v`，不得把维护者地址强行写进伙伴的 `origin`。

一项任务一条短期分支，一个 PR 只交付这项任务。分工见 [团队任务单](TEAM_TASKS.md)，Landing、新卡片和新功能都可以分配给伙伴。优先选低依赖工作；需要核心配合时先约定接口与样例，避免把整项工作串行等待。

## 提交与合入

1. 任务写清交付内容、允许修改的确切文件和验收标准；领取后再开工。
2. 从最新主仓库 `main` 开任务分支，例如 `task/fe-001`，不把别人的未合并分支当作前置。
3. 检查改动文件和验证结果，提交并推到自己的 remote，创建 base 为 `ECdison6227/vivic-canvas:main` 的 PR。
4. 维护者先核对范围，再看检查和实际结果。越界、删测试、放宽断言或无证据的“已通过”退回。
5. 由维护者决定合并或暂缓；建议 Squash merge，合并后删除任务分支。下一任务再次同步主仓库。

伙伴可修复任务内的问题；任务外 Bug 先记录复现，不顺手扩大范围。维护者可自己处理，也可另开限定修复任务。遇到共享核心冲突先协调，不让 AI 通过整文件覆盖或强推来解决。

## 实际权限与文件说明

fork 的独立权限是首轮隔离方式：不给伙伴主仓库写权限，他们无法直接推送或合并到主仓库。仅添加文档、CODEOWNERS 或 CI 文件不会自动修改 GitHub 权限。

`.github/CODEOWNERS` 指定 `@ECdison6227` 为审核负责人；文件合入 base 分支后可请求审核，但它不是按路径阻止修改的机制。CI 也不能代替维护者核对任务文件清单。`main-protection` 已在 2026-10-20 核对为 Active，当前要求 PR、Linux/Windows 检查、更新到最新主线、解决审查讨论与 Squash；成员权限和实际 assignee 仍待配置。

主仓库保持每项修改经过 PR 和检查的惯例；不要要求维护者的新功能必须等待伙伴审核。若后续开启必须由他人批准的规则，要先处理维护者本人 PR 的可用审核路径。

Agent 默认做本地工作。用户说“提交 PR”后，可提交本轮改动、推送到当前任务对应 remote 并创建目标 PR，不自动合并、部署或邀请他人。本轮用户要求逐步教学，提交和线上设置先由用户按步骤完成。

## 检查和保留

CI 检查锁定安装、契约、类型、单测和构建；不运行真实模型测试。失败要保留原因，不能用跳过检查代替修复。测试与缓存保持在忽略目录，凭据/个人画布不入 Git。

不用 `git reset --hard`、`git clean -fdx` 或强推清理别人工作。旧 `ECdison6227/vivic` / `agent/next-iteration` 不属于当前操作目标，历史记录见 [归档](archive/README.md)。

参考：[GitHub forks](https://docs.github.com/en/pull-requests/reference/forks)、[CODEOWNERS 的作用和限制](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)。
