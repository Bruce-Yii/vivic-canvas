# Vivic local connector prototype

RUN-01 的独立本地启动器原型。它在 `127.0.0.1` 提供带 bearer 会话保护的 JSON API，并只管理自己启动的决策子进程。

接入时由受控本机后端启动连接器、私下读取启动 JSON 并持有本进程会话的 token；浏览器调用该后端。连接器没有 CORS 支持，当前也没有实现 Vivic 后端桥接或产品 UI 接线。

```powershell
py -3 contrib/local-connector/connector.py serve --port 8791
py -3 -m unittest discover -s contrib/local-connector -p "test_*.py" -v
```

默认 `mock_provider.py` 是无网络、无凭据的真实子进程 fixture，用于复现健康、能力、启动、停止、取消、异常退出、端口占用和重连。它不代表真实模型准确率。协议和安装说明见 [`docs/local-connector/`](../../docs/local-connector/)，验证边界见 [`docs/verification/local-connector.md`](../../docs/verification/local-connector.md)。
