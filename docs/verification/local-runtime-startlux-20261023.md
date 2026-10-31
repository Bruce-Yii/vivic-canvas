# 2026-10-23 本地运行与 StartLux 验证

实现范围见 [本轮更新](../updates/2026-10-23-startlux-runtime.md)。没有推送、重启用户现有服务或改动真实画布。

- API 定向 81 项通过：原生 StartLux 请求/拒答/错误/配置、模型清单与内存建议、平台解析、下载/停止竞态、原 provider 及配置回归。修正 tar 负例表的参数包装，直接断言解析器错误，避免因测试参数形态错误假通过；最后两个 runtime 文件 15 项再跑通过。
- Web 定向 17 项通过：启动器状态与请求竞态、决策设置。未将既往 UI 全量结果计入本轮。
- API / Web TypeScript 类型检查、所有本轮 TS/TSX/MJS 文件定向 oxlint、触及文件空白检查通过。
- Web、mobile 生产构建及 Windows x64 生产部署/打包通过。构建保留既有 Vite 大包、Sherpaw WASM 路径及模块外置提示，本轮未把语音构建提示算作新的音频运行验证。
- 新 Windows 包用包内 Node 在独立 18793 端口启动，关闭偏好恢复及托管模型，验证 `/healthz`、`/launcher`、带认证的 `/api/decision/models`。四档候选、4B默认、未检查安装状态返回正确；测试进程已退出，18793无监听。不下载模型，不接触当前18787服务。
- 两个固定 Mac 引擎档真实下载核对字节/SHA256、tar解析与文件安装通过；receipt正常有效，跨架构检查、二进制篡改拒绝。未在 Windows执行Mach-O。
- Mac Node/Bash静态语法、oxlint、工作流YAML与双架构矩阵检查通过；原生Mac构建/CI/推理尚未执行，不能称Mac安装包已验收。
- 官方四档HF固定revision/文件字节/LFS SHA256及训练checkpoint revision在线核对通过。未下载StartLux权重、未跑真实StartLux推理、未训练。

Windows ZIP：106,589,908 bytes；SHA256 `62582270e04fef8da5f54aadb767dc5f9fe85c964befceecdcee5d39ced6c6d0`。

可交付文件在外层 `delivery/runtime-20261023/`。当前包的“准备模型”仍为Qwen 0.5B；StartLux是可连接的原生协议与候选清单，不能据此称4B已内置或微调完成。动态本地TTS仅核查方案，现有识别/唤醒/VAD与预生成声音保留。
