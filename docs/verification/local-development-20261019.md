# 本地协作基线验证

日期：2026-10-19。源码起点 `d0f3cbf`，工作分支 `chore/local-development-workflow`。本机 Windows、Node 24.21.0、pnpm 12.11.2。

## 本轮修改

- 本地开发路线、GitHub Desktop 贡献指南、任务/缺陷/PR 模板；当前协作目标统一为 `ECdison6227/vivic-canvas:main`。
- GitHub Actions 配置 Linux/Windows 的安装、契约、类型、单测和构建检查。本轮未推送，也未触发远端 Actions。
- `.gitattributes` 将两份生成的 `*.schema.json` 固定为 LF，避免 Windows `core.autocrlf=true` 导致字节一致性检查失败。生成后的 JSON 与基线没有内容差异。
- 仓库外的旧 `VIVIC_PLATFORM_PLAN.md` 增加本地优先修订说明，云端方案保留为后续讨论。

## 实际结果

| 检查 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过；锁文件未改 |
| `pnpm contracts:check` | 初次因 CRLF 失败；增加换行约定并重新生成后通过，两份契约均一致 |
| `pnpm typecheck` | contracts、local-api、web 通过 |
| `pnpm test` 的 web 阶段 | 520 通过 |
| `pnpm test` 的 API 初次结果 | 1,068 通过、2 失败、3 跳过；两项失败均为生成契约的换行差异 |
| 修复后 `pnpm --filter @vivic/local-api test` | 1,070 通过、3 跳过；38 文件通过、2 文件跳过 |
| `pnpm build` | 通过 |
| CI YAML / Issue 模板 frontmatter | 用已安装的 YAML parser 解析通过；检查了触发分支、系统矩阵、只读权限和实际命令 |
| 新协作指南/路线/Git 指引的相对链接 | 文件均存在 |
| `git diff --check` / `git check-attr` | 通过；生成契约的 `text` 和 `eol=lf` 生效 |

总计 1,590 项单测通过、3 项跳过。修复后仅复跑了受影响的 API 套件；前端结果来自同轮前次完整运行。类型和构建同样在换行修复前通过，修复未改变 TS/应用逻辑。

构建仍提示 Vite 配置未来的 `__dirname` 兼容变化、Sherpaw WASM/`module` 处理及较大 bundle；这些没有导致构建失败，本轮未将其宣称为已解决。

## 环境与范围

电脑最初有 Corepack，但 PATH 没有 `pnpm`，直接 `corepack pnpm` 无法满足脚本内部嵌套的 `pnpm`。已在忽略的 `.cache/tooling` 生成局部 shim，并仅为测试进程补充 PATH；操作方法写入贡献指南，未修改系统安装目录。

测试日志留在本机 `.cache/local-baseline-tests.log` 与 `.cache/local-api-baseline-tests.log`，不提交。没有运行真实模型测试、麦克风、音频播放或用户画布浏览器验收；Linux 和 GitHub Actions 仍需远端实际运行。新功能路线 L02–L12 尚未实现，GitHub 看板、Issue、成员权限与分支规则未创建。
