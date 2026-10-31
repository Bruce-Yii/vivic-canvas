# Vivic 执行手册（给执行模型）

> 规划者：Claude（2026-10-29 编写）。执行者：你。
> 产品负责人：程佳锐（下称"用户"）。所有对用户的汇报用中文、少用术语。
> 配套文档：`docs/design/Vivic-执行计划-v1.md`（为什么这样做）。本手册只讲**怎么做**。

---

## 0. 你的角色和工作规则

1. **你只执行，不改方向。** 按本手册的任务顺序做。觉得方案有问题，写进 `docs/design/EXECUTION-LOG.md` 的"疑问"一节并告诉用户，**不要自己换方案**。
2. **每完成一个任务**：
   - 在 `docs/design/EXECUTION-LOG.md` 里把对应任务勾上，写清做了什么、改了哪些文件、验收结果（贴命令和关键输出）；
   - 提交 Git（一个任务一个提交，提交信息英文，结尾加执行模型自己的署名行）并推送；
   - 用 3–5 句话告诉用户结果。
3. **遇到"🛑 检查点"必须停下**，把情况报告给用户，等用户明确回复"继续"再往下。
4. **失败就如实说。** 测试失败、验收不达标、线上出错，都原样报告（贴输出），不要把没做完的说成做完了。
5. **线上出问题先回滚再排查**：部署后 `https://vivic.edsionc.top/healthz` 不是 `{"ok":true,...}`，或主页打不开，立即执行回滚（A3 的 `rollback`），然后报告。
6. 每次开始工作前先做 **A2 的同步**（把同事新发布的前端补丁同步进 Git）。

---

## 1. 背景速读（5 分钟）

- **产品**：Vivic 是"卡片式"个人助手。用户说一句话，助手尽量用卡片回复，卡片常驻在 Space 里，是长期的个人上下文。只有 vivic space（展示）和对话 space（用户页）两个界面；不做跨 Space 操作。
- **核心问题**：现在每句话都交给大模型，大模型还要手写整张卡（id、坐标、时间戳），又慢又容易失败；决策模型根本没接进线上。
- **目标**：
  1. 决策模型（StartLux 4B）先判断"这句话要干什么"，简单指令不调大模型，直接出卡；
  2. 大模型只填卡片参数；
  3. 每条指令都记日志，用数据决定放开哪些类别。
- **已验证的事实**（不用再查）：
  - 网页端和手机端最终都调用后端 `POST /api/intent` → `apps/local-api/src/intent/pipeline.ts` 的 `runIntent()`。**改 `runIntent` 两端同时生效，不需要改前端。**
  - 线上后端 = Docker 容器 `vivic-preview-20261027`。代码在容器 `/app/apps/local-api/src`（TypeScript，`tsx` 直接运行，无需编译）；`@vivic/contracts`、`@vivic/card-runtime` 在容器 `/app/apps/local-api/node_modules/@vivic/*/src`（同样是 TS 源码）。
  - 前端由宿主机 nginx 直接从 `/opt/vivic-preview-20261025/frontend-current` 提供，**不在容器里**。前端由两位同事的 agent 直接在服务器上打补丁修改，**没有对应源码**。
  - 决策模型实测：StartLux 4B Q8，在 Mac mini 上用 Metal 运行，只问"路由"一题每次约 1.7 秒；一次多问几题不会更快（每多一题约 +1.3 秒）。
  - 已有 21 种"场景卡"（`packages/contracts/src/scenes.ts`），大模型输出 `{scene_id, data}`、服务端建卡，前端都能渲染。**NewsCard 就是我们的"回答卡"**：标题、摘要、≤5 个要点、来源链接、可选图片，以及 `summaryBy:"ai"`。

---

## 2. 环境与访问

| 用途 | 位置 / 命令 |
|---|---|
| 代码仓库 | `C:\Users\edsjrcheng\Desktop\vivic\vivic-baseline`（Git worktree）；远端 GitHub `ECdison6227/vivic-canvas`（经 mirasim 代理，`git push` 直接可用） |
| 分支 | 基线 `baseline/online-20261029`（= 线上代码快照）；计划文档 `docs/decision-plan-20261029`；**你的工作分支 `dev/decision-layer`**（从 `docs/decision-plan-20261029` 拉出） |
| 服务器 | `47.108.117.1`（CentOS 8，root）。工具在 `C:\Users\edsjrcheng\Desktop\vivic\tools\`，用法见那里的 `README.md`。Python：`/c/Users/edsjrcheng/AppData/Local/Programs/Python/Python312/python.exe` |
| Mac mini（模型机） | `ssh -F C:/Users/edsjrcheng/.ssh/vivic-mac-mini.conf vivic-mac-mini`（用户 `muhan`，sudo 密码问用户要）。M4 / 24GB / macOS 26.4，一直开机 |
| Mac 模型服务 | `~/Library/Application Support/VivicModelAPI/`：`file-api-20261026/supervisor.py`（uvicorn :19090，只能同时跑一个模型，闲置 120 秒卸载）。经反向隧道映射到服务器 `127.0.0.1:19091` |
| 服务器模型网关 | `/opt/vivic-model-api/gateway.mjs`（systemd `vivic-model-api`，:8796，对外 `https://edsionc.top/api/v1/...`）；权限表 `api-permissions.mjs`；配置 `/etc/vivic-model-api/config.json`；管理后台登录凭据在 Mac `~/Library/Application Support/VivicModelAPI/登录凭据.txt`（只读取，不要打印） |
| 评测工具 | 仓库 `evals/decision/`（`dataset.json` 161 题；`run_eval.py`、`startlux_eval.py`、`compare.py`）；Mac 上 `~/vivic-decision-lab/`（已装好 venv 与模型） |
| StartLux 4B Q8 权重 | Mac `~/Library/Caches/vivic-model-evaluation-20261025/decision-comparison/models/startlux-4b-q8/` |
| StartLux 运行库 | Mac `~/Library/Application Support/VivicModelAPI/runtime/startlux-engine/llama-server`（含 Metal），Python 包 `runtime/startlux-source/`，Python 环境 `runtime/venv-next/bin/python`（含 aiohttp） |
| 线上数据 | 服务器 `/var/lib/vivic-preview-20261025/space.sqlite`（容器内 `/data/vivic`）。**只能在备份后操作** |
| 本机 Node | Node 24 已装；pnpm 用 `corepack pnpm`（或先 `corepack enable`） |

---

## 3. 绝对不要做

1. 不要动前端：`frontend-current`、`releases/*`、容器里的 `/app/apps/web`。不要在本地构建前端去覆盖线上前端（会抹掉同事的补丁）。需要前端配合的事写进 `docs/design/FRONTEND-REQUESTS.md`，交给用户转达。
2. 不要直接改线上数据库；不要删 `/var/lib/vivic-preview-20261025/` 下任何文件。
3. 不要改服务器 root 密码；不要删除其他项目（beam-lab、worthwise、teachdemo、PPT、miotalk 等）的任何文件、镜像、容器。
4. 不要让服务器磁盘可用空间低于 2GB（每次部署前 `df -h /`）。
5. 不要在 Mac 上停止或修改现有的 ASR/TTS/文件服务行为；只允许按 B2 加一个转发分支。改任何 Mac 文件前先备份为 `<文件>.bak-<日期>`。
6. 不要把任何密码、密钥、token 写进 Git 或打印到对话里。
7. 没到 🛑 检查点、没得到用户同意，不要把决策模式切到 `on`。

---

## 4. 任务清单

> 格式：每个任务有 **目标 / 步骤 / 验收**。按顺序做；同一阶段内可以按需调整顺序，跨阶段不行。

### 阶段 A　准备

#### A1 本地开发环境
- **目标**：本地能跑后端测试。
- **步骤**：
  1. `cd vivic-baseline && git fetch origin && git checkout -b dev/decision-layer origin/docs/decision-plan-20261029`
  2. `corepack pnpm install`（如有网络问题，设 `npm_config_registry=https://registry.npmmirror.com`）
  3. `corepack pnpm --filter @vivic/local-api test` 和 `corepack pnpm --filter @vivic/local-api typecheck`
  4. 测试来自 10/24 的 main，代码来自 10/28 的线上，**预期会有一些失败**。把失败清单原样记进 EXECUTION-LOG 的"基线失败"一节；以后只要求"不新增失败"。
- **验收**：EXECUTION-LOG 里有基线测试结果（通过数 / 失败数 / 失败文件名）。

#### A2 同步同事的前端补丁（每次开工都做）
- **目标**：服务器上新出现的 `releases/*` 补丁进 Git。
- **步骤**：写 `deploy/online-patches/sync.sh`（在服务器上运行，输出 tar）和本地包装脚本 `scripts/sync-online-patches.mjs`。逻辑：
  - 列出 `releases/` 下修改时间晚于上次同步、且名字不在 `deploy/online-patches/` 里的目录；
  - 只打包其中的 `patch/`、`README.md`、`*.json`、`frontend-headers.conf`、`verification.md`（**不要 `web/`、`assets-before/`、`assets-fixed/`**）；
  - 传回本地，解到 `deploy/online-patches/<目录名>/`；
  - 更新 `deploy/online-patches/RUNNING_CONTAINER.txt`（当前 `frontend-current` 指向）。
  - 已知 10/29 下午新增了 `space-entry-20261029-1`、`unified-background-20261029-1`，首次运行应同步到它们。
- **验收**：提交 `chore: sync online frontend patches (<日期>)`；已有目录没有被改写。

#### A3 后端部署脚本（含回滚）
- **目标**：后端从 Git 一条命令部署，失败一条命令回滚，不影响数据。
- **背景**：以往做法是 `FROM 上一个镜像 + COPY src` 增量构建（见服务器 `/root/vivic-vo-helpmove-20261028-1414/Dockerfile`）。容器参数：`--name vivic-preview-20261027 --user node --restart unless-stopped -p 127.0.0.1:18890:8790 -v /var/lib/vivic-preview-20261025:/data/vivic --env-file <env.list>`，入口 `node --import tsx src/online/index.ts`，工作目录 `/app/apps/local-api`。环境变量文件现在是 `/root/vivic-vo-helpmove-20261028-1414/env.list`，复制到 `/opt/vivic-preview-20261025/backend/env.list`（权限 600）作为以后的唯一来源。
- **步骤**：在仓库新建 `deploy/backend/`：
  - `Dockerfile`：
    ```
    ARG BASE
    FROM ${BASE}
    COPY --chown=node:node apps/local-api/src/ /app/apps/local-api/src/
    COPY --chown=node:node packages/contracts/src/ /app/apps/local-api/node_modules/@vivic/contracts/src/
    COPY --chown=node:node packages/card-runtime/src/ /app/apps/local-api/node_modules/@vivic/card-runtime/src/
    ```
  - `deploy.sh <git-sha>`（在服务器运行；本地脚本 `scripts/deploy-backend.mjs` 负责打包源码、上传、调用）：
    1. 检查 `df -h /` 可用 ≥ 2GB；
    2. 构建镜像 `vivic-api:<sha>`，BASE = 当前运行容器的镜像；
    3. **预检**：把数据目录复制到 `/var/lib/vivic-staging`，用新镜像在 `127.0.0.1:18891` 起 `vivic-api-staging`，调 `/healthz`，再用 `node --import tsx -e` 在容器里 import `src/online/index.ts` 的依赖链做语法检查；失败就删掉临时容器、退出；
    4. **切换**：停止旧容器 → 备份 `space.sqlite*` 到 `/opt/vivic-preview-20261025/backups/db-<时间>/` → `docker rename` 旧容器为 `vivic-api-prev` → 用新镜像按上面参数起 `vivic-preview-20261027` → 30 秒内 `/healthz` 正常 → 删除 `vivic-api-staging` 和 `/var/lib/vivic-staging`；
    5. 健康检查失败：自动执行回滚；
    6. 只保留最近 3 个 `vivic-api:*` 镜像，外加 `vivic-preview-20261027:vo-helpmove-1414`（原始基线，永不删除）；
    7. 记录 `/opt/vivic-preview-20261025/backend/DEPLOYED`：sha、镜像、时间。
  - `rollback.sh`：停新容器并改名 `vivic-api-failed-<时间>`，把 `vivic-api-prev` 改回原名并启动，检查 `/healthz`。
- **验收**（🛑 检查点 1）：用**当前基线代码不做任何修改**部署一次，网站和 `/healthz` 正常；再执行一次 `rollback.sh` 回到原容器，确认正常；再部署一次。报告用户这三步的结果后再继续。

### 阶段 B　决策服务上线（Mac + 网关）

#### B1 Mac 上常驻 `vivic-decision` 服务
- **目标**：StartLux 4B Q8 在 Metal 上常驻，不受现有"单模型轮换"影响。
- **步骤**：
  1. 把权重复制到 `~/Library/Application Support/VivicModelAPI/models/startlux-4b-q8/`；
  2. 新建 `~/Library/Application Support/VivicModelAPI/decision-service/service.py`（FastAPI，监听 `127.0.0.1:19095`，用 `runtime/venv-next/bin/python`）：
     - 启动时拉起 `llama-server -m model.gguf --n-gpu-layers 99 --ctx-size 4096 --parallel 1 --threads 4 -b 4096 -ub 4096 --no-webui --log-disable`（参数与仓库 `evals/decision/startlux_eval.py` 的 `start_engine` 一致，只是开 GPU），并建立 `Decider`（`think_mode="never"`、`allow_none=True`、`none_check=True`、`context_length=4096`）；
     - `POST /v1/native`，请求 `{"state": <对象>, "questions": {<名>: {"type":"choice"|"noul", "instructions":..., "criteria":...}}}`，返回 `{"answers":..., "latency_ms":...}`；
     - `GET /health` 返回 `{"ok":true,"model":"startlux-decision-4b","loaded":true}`；
     - 鉴权：读取 `../worker-token`，要求 `Authorization: Bearer <token>`（与现有 worker 相同）；
     - 串行处理（一把锁），队列 > 4 返回 429；
     - llama-server 进程退出时自动重启。
  3. launchd：`~/Library/LaunchAgents/com.vivic.decision.plist`，`RunAtLoad`、`KeepAlive`，日志写 `~/Library/Logs/vivic-decision.log`；`launchctl bootstrap gui/$(id -u) <plist>`。
- **验收**：在 Mac 上用 `curl` 调 10 次评测集里的句子，中位耗时 < 2.2 秒；同时用现有服务做一次 TTS，决策耗时不变；`launchctl kickstart -k` 后能自动恢复。

#### B2 现有 worker 转发
- **目标**：服务器经已有隧道就能访问新服务，不新开端口。
- **步骤**：备份 `file-api-20261026/supervisor.py`。在 `/v1/decisions` 处理函数**最前面**加一个分支：`data.get("model") == "startlux-decision-4b"` 时，把原始请求体原样转发给 `http://127.0.0.1:19095/v1/native`，把响应原样返回（超时 20 秒）。其他模型的处理逻辑一行都不改；`/v1/models` 列表里追加 `startlux-decision-4b`。用 `launchctl list | grep -i vivic` 找到 supervisor 的 launchd 标签，`launchctl kickstart -k` 重启。
- **验收**：Mac 上 `curl 127.0.0.1:19090/v1/decisions`（带 worker token，model=startlux-decision-4b）返回 answers；`/health` 正常；做一次 ASR 请求仍正常。

#### B3 服务器网关放行 + 专用密钥
- **步骤**：
  1. 备份 `/opt/vivic-model-api/gateway.mjs` 和 `api-permissions.mjs`（`.bak-<日期>`）；
  2. `gateway.mjs` 第 ~383 行：把 `startlux-decision-4b` 加进 `/v1/decisions` 的模型白名单；`api-permissions.mjs` 里 `decisions` 权限的 models 加上它；如有请求体字段校验，允许 `state`/`questions`；
  3. `systemctl restart vivic-model-api`，`systemctl status` 正常；
  4. 登录网关管理后台（`https://edsionc.top/api/` 的控制台，凭据见 Mac 上的 `登录凭据.txt`），新建密钥 `vivic-backend-decision`，**只勾选"意图分类"权限**；把密钥写进服务器 `/opt/vivic-preview-20261025/backend/env.list`：`VIVIC_DECISION_API_KEY=...`、`VIVIC_DECISION_URL=https://edsionc.top/api/v1/decisions`、`VIVIC_DECISION_MODEL=startlux-decision-4b`。
- **验收**：在服务器上用该密钥 `curl` 一个原生请求成功；用同一密钥请求 `/v1/audio/speech` 被拒（403）。

### 阶段 C　后端接入决策（影子模式 + 日志）

#### C1 路由类别定义
- 新建 `packages/contracts/src/routes.ts`，导出 `ROUTES`（id → 描述）。**第一版直接用下面这份**（已根据评测错题调过描述）：

| id | 描述 |
|---|---|
| chat | 闲聊、打招呼、感谢、情绪表达，不需要做任何事 |
| answer | 知识问答、解释、介绍，或解释某句话、某张卡的意思（被解释的命令不执行） |
| search | 需要联网查询的实时信息，如天气、新闻、价格、最新资料 |
| countdown | 新建一个倒计时、计时器，或在一段时间后提醒（不是暂停或修改已有的） |
| todo | 新建待办事项或任务清单 |
| note | 把用户说的内容记下来、记笔记、做便签 |
| generate | 帮用户写作、整理、规划、总结、改写，或生成表格图表 |
| focus | 聚焦、放大、打开查看某一张已有卡片 |
| overview | 显示全部卡片，把所有卡片放进一屏的全局视图 |
| restore | 退出聚焦，恢复之前的视图 |
| highlight | 让某张卡片或卡片里的某一条闪烁高亮，方便找到 |
| edit | 修改已有卡片：勾选完成、增删条目、改标题、展开收起、暂停或继续倒计时 |
| arrange | 移动、固定或取消固定、整理卡片布局，或把卡片传送到用户页/展示页 |
| delete | 删除卡片或清空画布 |
| undo | 撤销或重做刚才的操作 |
| unsupported | 系统做不到的事，如下单购物、打电话、转账、控制家电 |

- 同步更新 `evals/decision/dataset.json` 的 `routes`（**只改描述，不改题目和答案**），在 Mac 上用 `startlux_eval.py` 对 4B 重跑一次，把新旧对比写进日志。若准确率下降超过 1 个百分点，回退描述并报告。

#### C2 决策客户端与状态构造
- 新建 `apps/local-api/src/decision/router.ts`：
  - `routeUtterance(text, ctx: CanvasContext, signal)` → `{route, probability, probabilities, none, latencyMs}`；
  - 请求体：`{"model":"startlux-decision-4b","state": buildState(text, ctx),"questions":{"route":{"type":"choice","instructions":ROUTE_INSTR,"criteria":ROUTES}}}`；
  - `buildState`：`{user_message, canvas:{focused_card, cards:[{id, desc}]}}`，`desc` 形如 `TodoCard「本周待办」交周报、买牛奶 位置x=0,y=0`，单卡 ≤110 字，最多 40 张卡（超出时优先保留聚焦卡和最近更新的卡）。与 `evals/decision/run_eval.py` 的 `kev_state`/`card_label` 保持一致，避免和评测脱节；
  - `ROUTE_INSTR`、`TARGET_INSTR` 文案照抄 `evals/decision/run_eval.py`；
  - 超时 4 秒；任何错误返回 `null`（调用方退回老流程），绝不抛到用户。
- 新建 `decision/target.ts`：`resolveTarget(text, ctx, route)`。先用确定性规则：
  1. 卡片标题、别名在原话中出现，且唯一；
  2. "这张 / 它 / 刚才那张" → `focusHistory` 最后一张；
  3. "左边 / 右边 / 上面 / 下面" + 可选类型词 → 坐标极值；
  4. 类型词（待办、便签、倒计时、天气……）且该类型唯一。
  
  都不成立时，再调用一次决策模型问 `target`（候选 = 卡片 id + `ambiguous` + `missing`）。返回 `{targetId} | {ambiguous: candidates} | {missing: true}`。
- 新建 `decision/split.ts`：`splitClauses(text)`，按"然后、再、顺便、并且、同时、接着、另外、，再、；"切分，最多 3 段；带"不要 / 别 / 如果 / 要是"的句子不切（整句交大模型）；每段至少 2 个字。

#### C3 接入 `runIntent`（影子模式）
- 环境变量：`VIVIC_DECISION_MODE=off|shadow|on`（默认 `off`）、`VIVIC_DECISION_ROUTES=`（`on` 模式下允许直接执行的类别，逗号分隔）。
- 依赖注入路径：`hosted/service.ts` 读取 `VIVIC_DECISION_*`，创建 router 客户端 → 传给 `online/appFactory.ts` 的 `createOnlineSessionApp` → `createApp` 的 deps → `PipelineDeps.router`。
- `shadow` 模式：`runIntent` 开始时**并行**发起 `splitClauses` + `routeUtterance`，不等待；老流程照常执行；老流程结束后最多再等 300 毫秒，把决策结果放进新字段 `IntentResult.trace`：`{mode, clauses, route, probability, target, latencyMs, legacyKind, legacyUsedProvider, legacyActionTypes, legacyCardTypes}`。**影子模式绝不能改变返回给用户的结果，也不能增加超过 300 毫秒的延迟。**
- `IntentResponseSchema`（`apps/local-api/src/schemas.ts`）允许 `trace` 可选字段；`hosted/service.ts` 在把 `/api/intent` 响应转给浏览器前**去掉 trace**。

#### C4 决策日志
- `space/store.ts` 新建表（迁移要幂等）：
  ```sql
  CREATE TABLE IF NOT EXISTS decision_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, account_id TEXT NOT NULL, space_id TEXT,
    path TEXT NOT NULL,            -- 'browser' | 'task'
    text TEXT NOT NULL, trace_json TEXT NOT NULL, outcome TEXT, undone INTEGER DEFAULT 0
  ) STRICT;
  ```
  保留最近 20000 条。
- `hosted/service.ts`：浏览器路径（转发 `/api/intent`）和 `hosted/tasks.ts`（任务路径）拿到含 trace 的结果后写一条日志；`outcome` 记录执行结果（succeeded / clarify / failed / error）。用户 30 秒内执行撤销时，把最近一条该用户日志的 `undone` 置 1。
- 新增只读接口 `GET /api/space/decision-log?limit=200`，只允许账号所有者访问（参照 `hosted/owner.ts` 的鉴权方式）。另写 `scripts/decision-report.mjs`：通过服务器工具取 json，输出每个类别的样本数、决策与老流程一致率、延迟 P50/P95。
- **一致性定义**（报告用）：决策类别 → 期望的老流程表现：
  - countdown → 建了 CountdownCard；todo → TodoCard；note → NoteCard；
  - search → `usedProvider=search` 或天气类数据；
  - overview / restore / focus / highlight → 对应 action；
  - delete → `card.delete` / `cards.delete`；undo → `history.undo` / `history.redo`；
  - chat / answer → 只有 `reply` / `subtitle`；
  - 其他类别只统计数量。

#### C5 部署影子模式
- 用 A3 部署，`VIVIC_DECISION_MODE=shadow`。
- 把评测集 161 句通过线上 `/api/intent` 回放一遍：用测试账号，写 `scripts/replay-eval.mjs`。**不要用用户的真实 Space；回放会真的建卡，回放后在测试 Space 里清空。**
- **验收**（🛑 检查点 2）：报告给用户：
  - 回放的决策路由准确率（应接近 95%）；
  - 线上端到端决策延迟 P50/P95；
  - 影子模式下用户请求总耗时是否变化（对比部署前 1 天的日志，若无则对比回放）；
  - 决策服务失败次数。

### 阶段 D　卡片契约：大模型只填参数

#### D1 契约类型与内置契约
- `packages/contracts/src/cardContract.ts`：
  ```ts
  export interface CardContract<S> {
    id: string;              // 与路由类别或 ext.<id> 对应
    name: string; description: string; examples: string[];
    cardType: string;        // 产出的卡片类型
    slots: z.ZodType<S>;     // 大模型 / 解析器要填的参数
    parse?(text: string, ctx: CanvasContext): S | null;   // 确定性解析，填不出返回 null
    build(slots: S, ctx: CanvasContext, now: Date): Action[]; // 宿主补 id、布局、时间
  }
  ```
- `apps/local-api/src/cards/` 下逐个实现：
  - `countdown`：slots `{seconds, text?}`。parse 复用 `intent/reminders.ts` 的 `parseDuration` / `parseExactReminders`；build 复用 `buildReminderActions`。
  - `todo`：slots `{title?, items: string[1..30]}`。parse 复用 `intent/rules.ts` 里已有的待办句式。
  - `note`：slots `{text}` 或 `{bullets}`。parse：去掉"记一下 / 记下来 / 便签：/ 新建便笺，内容是"等前缀后的原文。
  - `answer`：产出 **NewsCard**（scene `news_summary`），slots `{headline, summary, keyPoints≤5, url?}`，`summaryBy:"ai"`，无 parse（必须大模型）。
  - `generate`：沿用现有场景卡（scenes），按大模型输出的 `scene_id` 建卡。
  - `search`：沿用现有搜索 / 天气适配器（`deps.search`、`deps.data`），不调大模型。
  - 视图类（overview / restore / focus / highlight / undo）：无 slots，build 直接产出对应 action 或 hostOperation（参考 `decision/taskV2.ts` 里 `build()` 的写法）。
  - edit / arrange / delete：需要目标卡；edit 的具体修改交大模型填 `{targetId 已定, patch}`，arrange 用 hostOperation（move / pin / surface）。
- **规则**：大模型永远不输出 id、layout、metadata、时间戳。

#### D2 规划器只填参数
- `intent/pipeline.ts`：当决策给出类别且概率 ≥ 0.5 时，system prompt 只包含该契约的 slots 说明（`z.toJSONSchema`），要求输出 `{"slots":{...},"say":"≤40字口语","text":"≤120字字幕"}`；宿主用契约的 `build` 建卡，再走现有校验（`actionExecutionIssue`、grounding）。
- 概率 < 0.5 或类别为 generate：给排名前 3 的契约说明，让大模型先选契约再填 slots。仍失败才退回现有的完整 planner。
- 保留一次带具体错误路径的重试。

#### D3 图片
- 带图请求：先把图片存为 Space 资源（参照 `hosted/assets.ts` 现有上传流程），拿到 `media:<id>`；契约 `image_analysis` 产出 NewsCard：`image=media:<id>`，`headline` 为一句结论，`keyPoints` 为分析要点，`summaryBy:"ai"`。
- 删除 `pipeline.ts` 里"可创建 NoteCard 或 TodoCard 保存简洁分析，不保存图像"这句提示。
- 若 NewsCard 前端不显示 `media:` 图片，记入 FRONTEND-REQUESTS.md，暂时改用 `PhotoCoverCard`（`image.src=media:<id>`，`caption` 放结论）。

#### D4 三通道输出
- `say` → envelope 的 `spokenText`（语音播报）；`text` → `subtitle.show` action（字幕）；卡片 → `card.create`。前端已支持这三者，无需改前端。
- 校验 `say`：≤ 40 字；不含 `http`、连续 6 位以上数字、列表符号。不合格就用 `text` 的第一句截断代替。
- 落卡规则：chat、即时短答、澄清、报错 → 只有 say + text，不落卡；answer / generate / 新建类 → 落卡。

#### D 阶段验收
- 本地测试不新增失败；
- 对评测集里新建类、回答类题目做线上回放（仍是 `shadow`，但 D 的改动对所有请求生效），大模型输出被校验拒绝的比例 < 3%；
- 发一张图得到带原图的卡片。

部署后报告用户（无检查点，但要报告）。

### 阶段 E　放开直接执行（按类别）

#### E0 🛑 检查点 3
把 C5 / D 的数据给用户看，提议第一批放开的类别（建议：countdown、todo、note、overview、restore、focus、undo、unsupported、chat），得到用户同意后再改 `VIVIC_DECISION_MODE=on`。

#### E1 `on` 模式执行路径
- `runIntent` 入口：`splitClauses` → 每段 `routeUtterance`；
- 每段：若类别 ∈ `VIVIC_DECISION_ROUTES` 且概率 ≥ 0.8，则走契约（parse 成功 → 直接 build，**不调大模型**；parse 失败 → 大模型只填 slots）；否则整句走 D2 的规划器；
- 多段：各段结果合并成一个 envelope（`stage.awaken` 只放首位，多卡创建后只放一次 `canvas.fit`）；任一段需要澄清，整句澄清；
- 继续写 trace（mode=on）。

#### E2 删除确认
- 类别 delete（不论概率）：返回 clarify："确定删除「<卡名>」吗？"（全部删除时："确定删除这 N 张卡吗？"），用现有 continuation / `awaiting_clarification` 机制；用户下一句是"确定 / 是 / 删吧"才执行，其他任何回答都取消。

#### E3 目标歧义追问
- `resolveTarget` 返回 ambiguous：clarify "你要操作哪一张？1. 本周待办 2. 购物清单"，候选用 `DecisionTaskStatus.clarification.candidates`；用户回"第一个 / 1 / 本周待办"即闭环（`taskV2.ts` 里已有编号解析，可复用其写法）。

#### E4 版本冲突自动重试
- `hosted/tasks.ts`：`run()` 中 `version-conflict` 时重新取快照、重新调用 `/api/intent`，最多 2 次；仍冲突再报给用户。

#### E 阶段验收
- 线上说"倒计时 50 分钟"：trace 显示未调用大模型，端到端 < 3 秒；
- "帮我记个便签明天交周报，再设个 50 分钟倒计时"出两张卡；
- "删除读书笔记"先确认；
- 第一批类别放开一周后，用 `decision-report` 看 undone 比例。之后每放开一批都先报告用户。

### 阶段 F　.vivicard v0.2 与做卡指南

#### F1 manifest v0.2（只加字段，v0.1 继续可用）
- `packages/card-runtime/src/index.ts` 的 `parseManifest`：`formatVersion` 允许 `"0.2"`；新增可选字段：
  - `examples: string[]`（3–10 条，每条 4–40 字，不含 URL）；
  - `slots`：可选，缺省时用 `dataSchema` 作为参数表；
  - `icon`（≤ 8 字符）；
  - `category`（≤ 20 字）。
- `capabilities` 仍必须为空。
- 补单元测试：v0.1 包、v0.2 包、非法 examples。

#### F2 服务端安装接口
- `hosted/owner.ts` 已有 `hostedDefinitions` 存储，补齐：
  - `POST /api/space/cards`：上传 `.vivicard`（≤ 1MiB），服务端用 `readPackageZip` 完整校验；
  - `GET`：列表；
  - `PATCH :id`：启用 / 禁用；
  - `DELETE :id?hash=`：有卡片引用该版本时拒绝；
  - `GET :id/package`：导出。
- 每账号 ≤ 32 个定义，启用 ≤ 16 个。

#### F3 决策类别动态包含扩展卡
- 启用的扩展卡作为额外类别 `ext.<id>`，描述 = `name：description。例：examples[0]；examples[1]`；
- 内置 16 类 + 扩展卡超过 16 个时分两步：第一次把所有扩展卡合并成一个类别 `ext`（"使用用户安装的扩展卡片"），选中后第二次在扩展卡之间选。

#### F4 扩展卡参数由大模型填
- `scenes/extensions.ts` 已支持 `{scene_id:"ext.<id>", data:{config,data,state}}`；改为由决策结果决定注入哪张卡的 schema（不再要求原话里出现卡名）。

#### F5 《Vivic 做卡指南》
- `docs/vivicard/做卡指南.md`：写给用户电脑上的 Codex / Claude 看。内容包括：
  - 目录结构、5 个文件的写法；
  - 9 个声明式组件（Header / KeyValue / Metric / List / Image / Badge / Link / Table / Progress）和 bind 规则；
  - examples 怎么写；
  - 自检命令 `corepack pnpm card:check <目录>`、打包命令 `corepack pnpm card:pack <目录> <输出.vivicard>`。
- 附一个完整示例 `examples/vivicard/fitness-log/`（健身打卡），能通过 `card:check`。
- **验收**：按指南从零做一张卡，导入后用一句话触发出卡（🛑 检查点 4：请用户亲自试一次）。

### 阶段 G　演示准备与交接
- `docs/design/DEMO.md`：10 条演示话术及预期效果，覆盖：
  - 秒出卡（倒计时、待办）；
  - 回答卡（介绍 Google）；
  - 图片分析；
  - 多意图；
  - 指代追问；
  - 删除确认；
  - 扩展卡。
- 演示前一天：在 Mac 上跑评测集（4B），在线上回放评测集，结果写进日志。
- 更新 `Vivic-执行计划-v1.md` 的进度表；整理 FRONTEND-REQUESTS.md 交给用户。

---

## 5. 需要前端配合的事（不要自己做，写进 FRONTEND-REQUESTS.md）

1. 卡片内单个要点的高亮（NoteCard 要点、NewsCard 要点）。现在只有 TodoCard 条目支持。
2. 澄清候选以可点选的编号列表显示（现在只是文字）。
3. （若 D3 发现）NewsCard 显示 `media:` 图片。

---

## 6. 汇报模板（每个任务完成后发给用户）

```
【任务 X 完成】
做了什么：……（1–2 句）
结果：……（关键数字或"网站正常"）
有什么问题：……（没有就写"无"）
下一步：任务 Y
```

`EXECUTION-LOG.md` 的格式：每个任务一节，包括：
- 勾选框；
- 日期；
- 改动文件；
- 验收命令和输出摘要；
- 遇到的问题。

文件开头保留以下几节，并随时更新：
- "基线失败"；
- "疑问"；
- "当前线上状态"（部署的 sha、决策模式、放开的类别）。
