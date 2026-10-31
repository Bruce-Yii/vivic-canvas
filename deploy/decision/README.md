# 独立常驻决策服务

Mac 安装入口为 `install.py`，之后按顺序运行 `verify.py`、`wire_worker.py`，再在服务器运行 `wire_gateway.py` 和 `provision_key.py`。密钥只在私有环境文件与 SSH stdin 中处理，不放入仓库。

原生 4B 使用 `state/questions`，不是旧模型的 `input/labels`：

```json
{
  "model": "startlux-decision-4b",
  "state": {"user_message": "倒计时50分钟"},
  "questions": {
    "route": {"type": "choice", "instructions": "选择用户要求的动作", "criteria": {
      "countdown": "创建倒计时", "chat": "闲聊"
    }}
  }
}
```

决策服务仅监听 Mac 回环 `19095`，旧 worker 根据模型名转发，复用已有隧道和网关。模型固定常驻，不加入原 ASR/TTS 单模型轮换；请求单并行、最多四个等待，超过返回 429。请求鉴权与旧 worker 共用私有 token，后端访问网关使用单独的 decisions-only key。

`VIVIC_DECISION_MODE=off|shadow|on` 由后端环境控制。C 阶段只支持 off/影子观察，on 不会提前启用执行；真正执行必须等卡片契约和 E 阶段检查点批准。

报告命令 `node scripts/decision-report.mjs --hours 24` 从服务器只读取动作、类型、路由与耗时等聚合所需字段，不输出原话或卡片内容。“与旧流程一致率”不是人工标注准确率。

影子回放由 `prepare_shadow_eval.py` 创建一次性邀请码并通过正常注册接口创建独立测试账号。测试账号不继承其他人的大模型连接；会话凭据保存在服务器私有文件中。关闭影子的基线在只监听回环的克隆数据容器中运行，不再为对比重复重启生产后端。回放只操作该测试账号的 Space，并在结束时清空，随后删除克隆容器和数据。
