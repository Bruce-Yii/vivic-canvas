# D 真实验收运行说明

`scripts/replay-d-eval.mjs` 只接受 `evaluation=true` 且用户名以 `decision-eval-` 开头的隔离账号。启动前要求该 Space 为空；使用正常 owner API 放入原始夹具、提交提案、发送执行回执，结束后恢复原内容并删除新增图片。

先通过正常连接 API 为此账号验证模型，然后在 API 容器工作目录运行（私有会话文件不含模型密钥，不入 Git）：

```sh
node --import tsx d-acceptance-20261030.mjs \
  --credentials /tmp/vivic-d-eval/session.json \
  --dataset /tmp/vivic-d-eval/dataset.json \
  --output /tmp/vivic-d-eval/result.json \
  --model step-3.7-flash
```

脚本需与 `replay-eval.mjs` 同目录，以复用冻结夹具和上下文转换。`--smoke` 只跑少量预检；`--case <id>` 跑单题；`--no-image` 可省略图片，但这不满足完整 D 图片验收。

完整选择固定为原集59道主 route 属于 answer/countdown/todo/note/generate 的题，加一道程序生成的双色图片，不改原题或标签。另外两道以 search 为主的复合题不混入本次分母。输入均为合成数据，输出使用真实托管请求和上游模型；图片题未把颜色答案写进用户文字。

响应耗时取 SSE 的最终结果到达时间；规则与实际调用模型的请求分开统计。规则返回时影子分类可能尚未结束，新版脚本在计时完成后等待当前观察日志收敛，再发送下一题；这段排队清理不计入响应耗时。首轮未加此节奏控制，结果独立保留，不删除、替换或混入后续复测。

原始 `summary.finalUnreliableParameters` 仅识别固定失败消息，不等于完整质量评分。最终报告必须结合预先记录的 `d-acceptance-policy.json`、所有 clarify 文本及实际卡片内容人工复核：规则直达、合理澄清、网络/分类失败、结构拒绝、漏项和未落卡分别统计。不能用全部60请求稀释模型拒绝率，也不能把“合法卡片”写成“全部内容事实正确”。

完成后把合成结果复制回 `evals/decision/live/`；删除容器内和服务器上本次临时 session 文件。不要复制密钥、原用户日志或真实用户画布进入 Git。
