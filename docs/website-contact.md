# 官网底部四个二维码

官网：[edsionc.top/vivic](https://edsionc.top/vivic/)。

根据 2026-10-17 用户确认，底部保留四个入口：

1. 微信内测交流群。
2. 小红书内测交流群。
3. Vivic 官网访问入口：`https://edsionc.top/vivic/`。
4. 麦当劳 MCP 卡片独立仓库：`https://github.com/ECdison6227/vivic-mcdonalds-mcp`。

麦当劳卡片仓库当前公开项目介绍，应用源码待后续提供。官网入口注明这一状态。

当前官网由单文件落地页构建独立部署，并包含比本仓库基础版本更新的内测登记流程。使用 `scripts/update-landing-qr.py` 在当前线上构建中更新二维码列表，避免用较早的完整构建覆盖线上登记和应用入口。

更新脚本保留现有 React 卡片组件和页面内容：四张二维码嵌入 HTML，避免依赖额外图片请求；二维码图片提供可点击的原始入口；桌面四列、平板两列、手机单列。二维码不依赖滚动动画显示。

```sh
python3 scripts/update-landing-qr.py current-index.html updated-index.html qr-config.json
```

配置是四条记录组成的 JSON 数组，每条记录包含 `id`、`platform`、`group`、`hint`、`brand`、`href`、`linkLabel` 和本地 PNG 路径 `image`。首条沿用官网既有的 `xiaohongshu` ID。

发布前保留线上文件副本并核对 SHA-256，确认文件未被其他发布修改后再原子替换。重新生成官网单文件时，也需要保留或重新应用四个二维码入口。
