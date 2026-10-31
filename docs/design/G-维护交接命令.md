# G 维护交接命令

执行位置：`C:\Users\edsjrcheng\Desktop\vivic\vivic-baseline`，任务分支 `dev/decision-layer`。继续使用已有私有SSH配置与工具，不复制密码或密钥到仓库。

## 演示前检查

```powershell
node scripts/demo-preflight.mjs
```

只有网站正常且模型 `loaded:true` 才开始快速出卡演示。`paused_for_large_model:true` 表示Mac正在为别的大模型让出显存，应等其正常释放。不要强杀别人的模型、切换账号路由或重新开放执行类别。

## 重跑同一161题4B评测

```powershell
node scripts/run-resident-eval.mjs
```

命令核对Mac与仓库固定题目一致，使用原常驻4B服务，不启动第二份权重；会备份Mac上的同名脚本，并将带时间戳的结果取回 `evals/decision/results/`。预热与逐题耗时分别记录，目标选择和多意图指标单列。当前真实模型基线见 `startlux-4b-q8-metal-g-20261030.json`。

可先运行 `node scripts/run-resident-eval.mjs --check`，只验证健康、题目一致性和评测脚本语法，不推理、不写Mac文件。

本机使用既有 `tools/macssh.py` 和 `.ssh/vivic-mac-mini.conf`。其他维护环境可通过 `VIVIC_SSH_PYTHON`、`VIVIC_MAC_SSH_RUNNER` 指向等价的已授权、固定主机指纹的连接器。

## 线上固定集回放

1. 只使用用户名以 `decision-eval-` 开头的独立评测账号和空Space；通过正常登录接口建立当前会话。
2. 在这个账号正常连接主模型，主模型凭据只进入服务端短期会话；会话JSON仅放在本机私有工具目录。
3. 核对分类器已加载，然后运行以下命令。将占位路径替换为真实的私有会话文件，不能填日常账号。

```powershell
$env:VIVIC_REPLAY_API_ROOT = "$PWD/apps/local-api/src"
corepack pnpm --filter @vivic/local-api exec tsx ../../scripts/replay-g-eval.mjs `
  --credentials C:/private/evaluation-session.json `
  --dataset C:/Users/edsjrcheng/Desktop/vivic/vivic-baseline/evals/decision/dataset.json `
  --output C:/private/g-online-result.json --wait-resident
```

`--wait-resident` 会在分类器让出显存时等待，等待时长单独记录，不计入单条响应指标。若显存状态在请求期间改变，仍保留真实失败，不用后来的成功覆盖它。暂存夹具、真正持久化和成功执行回执分开记录；未提交成功的提案不回成功。结束后恢复空测试Space。

原161题的目标与标签不能为抬高分数而修改。完整回放、失败补验、静音浏览器验证分别报告；不能把提案提交率等同于语义准确率，也不能用合成撤销率代替真实使用数据。

## 真实使用观察

```powershell
node scripts/decision-report.mjs --hours 168 --mode on --exclude-evaluation
```

原计划在2026-11-06复核一周真实使用。统计仅提取聚合元数据，排除评测账号；若尚未积累一周或没有真实请求，报告无数据，不宣布达标。本轮未新增定时任务，也未替用户发送飞书消息。

## 发布与回滚

当前网页采用 `clarification-guard-20261030-2`，基于同事的voice-v4，已含卡包接入、NewsCard对比度和删除确认修复。完整恢复包、校验与还原方式见 `deploy/online-snapshot/README.md`。最新发布/回滚入口为 `python scripts/publish-current-question-flow.py --rollback`（先核对当前仍是此版本，回到保留的voice-v4）；各历史补丁说明保留在 `deploy/online-patches/`。

任何前端发布都先同步并逐文件核对线上当前版本；同事可能在原发布目录内更新资源，不能只看目录名。不要用F5旧回滚脚本回退新版。后端继续使用既有A3部署/回滚流程，数据库不由这些测试脚本直接修改。
